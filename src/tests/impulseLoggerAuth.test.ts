import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {backendHttpOrigin} from '@config/backendOrigin';

import type {Logger} from '@lib/impulseLogger';

/**
 * The Loki push contract the web client must satisfy:
 *   - service_name is exactly ImpulseM.Web (anything else is a 400);
 *   - the active session token is sent as a bearer, never a pending token, and a token the
 *     server rejected with 401 is not sent again until the session token changes;
 *   - 429/503 requeue the batch and wait Retry-After before the next flush;
 *   - 400/413/415 drop the batch;
 *   - one push carries at most 500 entries; a larger backlog is split, not dropped.
 */

const FLUSH_INTERVAL_MS = 2_000;
const RETRY_AFTER_SECONDS = 7;
const RETRY_AFTER_MS = RETRY_AFTER_SECONDS * 1_000;
const MAX_ENTRIES_PER_PUSH = 500;
const OVERSIZED_BACKLOG_ENTRY_COUNT = 600;
const WEB_SERVICE_NAME = 'ImpulseM.Web';
const SESSION_TOKEN = 'session-token-first';
const ROTATED_SESSION_TOKEN = 'session-token-rotated';
const HTTP_OK = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;

type RecordedFetch = {
  url: string,
  bodyText: string,
  init: RequestInit,
  authorization: string | undefined,
  sentAtMs: number
};

type RespondTo = (callIndex: number) => Promise<Response>;

describe('Loki push honours the server contract', () => {
  let getLogger: typeof import('@lib/impulseLogger').getLogger;
  let setLogAuthTokenProvider: typeof import('@lib/impulseLogger').setLogAuthTokenProvider;
  let fetchCalls: RecordedFetch[];
  let respondTo: RespondTo;
  let warnLines: string[];

  beforeEach(async() => {
    vi.resetModules();
    vi.useFakeTimers();

    fetchCalls = [];
    respondTo = () => Promise.resolve(statusResponse(HTTP_OK));
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = (init?.headers ?? {}) as Record<string, string>;
      const bodyText: string = typeof init?.body === 'string' ? init.body : '';
      fetchCalls.push({
        url: String(input),
        bodyText,
        init: init ?? {},
        authorization: headers.Authorization,
        sentAtMs: Date.now()
      });
      return respondTo(fetchCalls.length - 1);
    });

    // impulseLogger binds console.warn at import time, so the spy must exist first.
    warnLines = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map((arg: unknown) => String(arg)).join(' '));
    });

    ({getLogger, setLogAuthTokenProvider} = await import('@lib/impulseLogger'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function statusResponse(status: number, headers: Record<string, string> = {}): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {get: (name: string): string | null => headers[name] ?? null}
    } as unknown as Response;
  }

  function callsCarrying(marker: string): RecordedFetch[] {
    return fetchCalls.filter((call: RecordedFetch) => call.bodyText.includes(marker));
  }

  function logOne(logger: Logger, marker: string): void {
    logger.info(marker);
  }

  async function drainMicrotasks(): Promise<void> {
    for(let i = 0; i < 8; ++i) {
      await Promise.resolve();
    }
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await drainMicrotasks();
  }

  function parsedValueCount(bodyText: string): number {
    const payload = JSON.parse(bodyText) as {streams: {values: unknown[]}[]};
    return payload.streams.reduce((total: number, stream) => total + stream.values.length, 0);
  }

  it('the payload names the web service ImpulseM.Web', async() => {
    const marker: string = 'auth-service-name';
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);

    const sent: RecordedFetch[] = callsCarrying(marker);
    expect(sent, 'the single entry must ship in one push').toHaveLength(1);
    const payload = JSON.parse(sent[0].bodyText) as {streams: {stream: Record<string, string>}[]};
    expect(
      payload.streams[0].stream.service_name,
      'the server answers 400 to any service_name other than ImpulseM.Web'
    ).toBe(WEB_SERVICE_NAME);
  });

  it('sends the active session token as a bearer on a normal flush', async() => {
    const marker: string = 'auth-bearer-sent';
    setLogAuthTokenProvider(() => SESSION_TOKEN);
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);

    const sent: RecordedFetch[] = callsCarrying(marker);
    expect(sent, 'the entry must ship').toHaveLength(1);
    expect(sent[0].authorization, 'the active session token must travel as a bearer').toBe(`Bearer ${SESSION_TOKEN}`);
    expect(sent[0].init.credentials, 'authorization is a header, the request stays credential-free').toBe('omit');
  });

  it('sends no Authorization header when no provider is registered', async() => {
    const marker: string = 'auth-no-provider';
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);

    const sent: RecordedFetch[] = callsCarrying(marker);
    expect(sent, 'the entry must ship').toHaveLength(1);
    expect(sent[0].authorization, 'a worker or service worker ships anonymously').toBeUndefined();
  });

  it('sends no Authorization header when the provider returns no token', async() => {
    const marker: string = 'auth-no-token';
    setLogAuthTokenProvider(() => undefined);
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);

    const sent: RecordedFetch[] = callsCarrying(marker);
    expect(sent, 'the entry must ship').toHaveLength(1);
    expect(sent[0].authorization, 'no session means the anonymous per-IP lane').toBeUndefined();
  });

  it('a 401 drops the batch; the rejected token is withheld until the session token changes', async() => {
    const firstMarker: string = 'auth-401-first';
    const secondMarker: string = 'auth-401-second';
    const thirdMarker: string = 'auth-401-third';
    let currentToken: string | undefined = SESSION_TOKEN;
    setLogAuthTokenProvider(() => currentToken);
    respondTo = (callIndex: number) => Promise.resolve(
      callIndex === 0 ? statusResponse(HTTP_UNAUTHORIZED) : statusResponse(HTTP_OK)
    );

    logOne(getLogger(firstMarker), firstMarker);
    await advance(FLUSH_INTERVAL_MS);
    await advance(FLUSH_INTERVAL_MS * 3);
    expect(
      callsCarrying(firstMarker),
      'a 401 batch must be dropped, not requeued into an endless retry of a dead token'
    ).toHaveLength(1);

    logOne(getLogger(secondMarker), secondMarker);
    await advance(FLUSH_INTERVAL_MS);
    const secondSent: RecordedFetch[] = callsCarrying(secondMarker);
    expect(secondSent, 'the next batch must still ship').toHaveLength(1);
    expect(
      secondSent[0].authorization,
      'the server rejected this exact token; resending it only repeats the 401'
    ).toBeUndefined();

    currentToken = ROTATED_SESSION_TOKEN;
    logOne(getLogger(thirdMarker), thirdMarker);
    await advance(FLUSH_INTERVAL_MS);
    const thirdSent: RecordedFetch[] = callsCarrying(thirdMarker);
    expect(thirdSent, 'the batch after rotation must ship').toHaveLength(1);
    expect(
      thirdSent[0].authorization,
      'once the session token changes, the new token must be sent again'
    ).toBe(`Bearer ${ROTATED_SESSION_TOKEN}`);
  });

  it('a 429 requeues the batch and waits Retry-After seconds before the next push', async() => {
    const marker: string = 'auth-429-retry';
    setLogAuthTokenProvider(() => SESSION_TOKEN);
    respondTo = (callIndex: number) => Promise.resolve(
      callIndex === 0 ?
        statusResponse(HTTP_TOO_MANY_REQUESTS, {'Retry-After': String(RETRY_AFTER_SECONDS)}) :
        statusResponse(HTTP_OK)
    );
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);
    expect(fetchCalls, 'the first push must have been attempted').toHaveLength(1);

    await advance(RETRY_AFTER_MS - FLUSH_INTERVAL_MS);
    expect(
      fetchCalls,
      'the batch must not be re-sent before Retry-After has elapsed'
    ).toHaveLength(1);

    await advance(FLUSH_INTERVAL_MS);
    expect(fetchCalls, 'the requeued batch must be re-sent once Retry-After has elapsed').toHaveLength(2);
    expect(
      fetchCalls[1].sentAtMs - fetchCalls[0].sentAtMs,
      'the retry must come about Retry-After seconds after the throttled push'
    ).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
    expect(
      callsCarrying(marker),
      'a throttled batch is requeued, so the entry is sent again rather than lost'
    ).toHaveLength(2);
  });

  it('a 400 drops the batch without requeue and warns with the status only', async() => {
    const marker: string = 'auth-400-rejected';
    respondTo = () => Promise.resolve(statusResponse(HTTP_BAD_REQUEST));
    logOne(getLogger(marker), marker);

    await advance(FLUSH_INTERVAL_MS);
    await advance(FLUSH_INTERVAL_MS * 10);

    expect(
      callsCarrying(marker),
      'a malformed batch is refused again on every retry, so it must be dropped, not requeued'
    ).toHaveLength(1);

    const statusLine: string | undefined = warnLines.find((line: string) => line.includes(String(HTTP_BAD_REQUEST)));
    expect(statusLine, 'the rejection must be reported with its status').toBeDefined();
    expect(statusLine, 'the warning must carry the status only, never the batch').not.toContain(marker);
  });

  it('more than 500 entries are split into several pushes, none dropped', async() => {
    const marker: string = 'auth-split-backlog';
    const logger: Logger = getLogger(marker);
    for(let i = 0; i < OVERSIZED_BACKLOG_ENTRY_COUNT; ++i) {
      logOne(logger, `${marker} ${i}`);
    }

    await advance(FLUSH_INTERVAL_MS * 4);

    expect(fetchCalls.length, 'the backlog must go out in more than one push').toBeGreaterThan(1);
    for(const call of fetchCalls) {
      expect(
        parsedValueCount(call.bodyText),
        'no push may carry more than 500 entries'
      ).toBeLessThanOrEqual(MAX_ENTRIES_PER_PUSH);
    }

    const delivered: number = fetchCalls.reduce(
      (total: number, call: RecordedFetch) => total + parsedValueCount(call.bodyText),
      0
    );
    expect(delivered, 'splitting must not drop a single entry').toBe(OVERSIZED_BACKLOG_ENTRY_COUNT);
  });

  it('the unload flush carries the bearer and keeps credentials omitted', async() => {
    const marker: string = 'auth-unload-bearer';
    setLogAuthTokenProvider(() => SESSION_TOKEN);
    logOne(getLogger(marker), marker);

    window.dispatchEvent(new Event('pagehide'));

    const sent: RecordedFetch[] = callsCarrying(marker);
    expect(sent, 'the unload flush must ship the entry').toHaveLength(1);
    expect(sent[0].authorization, 'the unload flush must authenticate like the normal flush').toBe(`Bearer ${SESSION_TOKEN}`);
    expect(sent[0].init.credentials).toBe('omit');
    expect(sent[0].init.keepalive).toBe(true);
    expect(sent[0].url).toBe(`${backendHttpOrigin()}/loki/api/v1/push`);
  });
});
