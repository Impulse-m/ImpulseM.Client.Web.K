import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {backendHttpOrigin} from '@config/backendOrigin';

import type {Logger} from '@lib/impulseLogger';

/**
 * The Loki transport must survive the batches that matter most.
 *
 * The Fetch standard caps the TOTAL body of in-flight keepalive requests at 64 KiB
 * (https://fetch.spec.whatwg.org, "http-network-or-cache fetch": if the sum of contentLength and
 * inflightKeepaliveBytes is greater than 64 kibibytes, return a network error). A keepalive fetch
 * over that budget is rejected by the browser with a TypeError BEFORE any network I/O.
 *
 * Both senders in impulseLogger set `keepalive: true` on an unbounded body, and a failed periodic
 * flush requeues the whole batch in front of everything newer — so the payload only ever grows.
 * Once one flush crosses the budget, every later flush is rejected too: a permanent,
 * self-sustaining log blackout. A misbehaving client is exactly the client that logs the most,
 * so the investigation goes blind exactly when the client misbehaves.
 *
 * Contract pinned here:
 *   1. periodic flushes are NOT keepalive requests (keepalive exists for the unload path);
 *   2. the unload flush keeps keepalive and bounds its total body to the budget, newest-first;
 *   3. a failed batch cannot grow the next payload past the budget forever — entries beyond the
 *      budget are dropped oldest-first through the existing dropped-entries accounting;
 *   4. negative control: a small batch still ships exactly as today, in one push, same body shape.
 */

// 64 KiB, verbatim from the Fetch standard. The production constant may be smaller (a safety
// margin is fine); it can never be larger, so every assertion below is against this ceiling.
const KEEPALIVE_BODY_BUDGET_BYTES = 65_536;
// Mirrors FLUSH_INTERVAL_MS in impulseLogger: advancing this far always fires a pending flush.
const FLUSH_INTERVAL_MS = 2_000;
// ~2.2 KB per serialized entry; 40 of them build a ~88 KB payload — comfortably over budget.
const ENTRY_PADDING = 'x'.repeat(2_048);
const OVER_BUDGET_ENTRY_COUNT = 40;

type RecordedFetch = {
  url: string,
  keepalive: boolean | undefined,
  bodyText: string,
  bodyBytes: number,
  init: RequestInit
};

describe('Loki transport survives over-budget batches', () => {
  let getLogger: typeof import('@lib/impulseLogger').getLogger;
  let fetchCalls: RecordedFetch[];
  let respondTo: (callIndex: number) => Promise<Response>;
  let warnLines: string[];

  beforeEach(async() => {
    vi.resetModules();
    vi.useFakeTimers();

    fetchCalls = [];
    respondTo = () => Promise.resolve(okResponse());
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
      fetchCalls.push({
        url: String(input),
        keepalive: init?.keepalive,
        bodyText,
        bodyBytes: byteLength(bodyText),
        init: init ?? {}
      });
      return respondTo(fetchCalls.length - 1);
    });

    // impulseLogger binds console.warn at import time, so the spy must exist first.
    warnLines = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnLines.push(args.map((arg) => String(arg)).join(' '));
    });

    ({getLogger} = await import('@lib/impulseLogger'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function okResponse(): Response {
    return {ok: true, status: 204} as unknown as Response;
  }

  function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  function seqTag(index: number): string {
    return `seq-${String(index).padStart(2, '0')}`;
  }

  function emitPaddedEntries(logger: Logger, marker: string, count: number): void {
    for(let i = 0; i < count; ++i) {
      logger.info(`${marker} ${seqTag(i)} ${ENTRY_PADDING}`);
    }
  }

  function callsCarrying(marker: string): RecordedFetch[] {
    return fetchCalls.filter((call) => call.bodyText.includes(marker));
  }

  async function drainMicrotasks(): Promise<void> {
    for(let i = 0; i < 8; ++i) {
      await Promise.resolve();
    }
  }

  it('periodic flushes are not keepalive requests, and still deliver the whole batch', async() => {
    const marker = 'keepalive-budget-periodic';
    emitPaddedEntries(getLogger(marker), marker, OVER_BUDGET_ENTRY_COUNT);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await drainMicrotasks();

    const sent = callsCarrying(marker);
    expect(
      sent.length,
      'the periodic flush never reached fetch at all — the batch is stuck in the buffer and no diagnostic ships'
    ).toBeGreaterThan(0);

    const attemptedBytes = sent.reduce((total, call) => total + call.bodyBytes, 0);
    expect(
      attemptedBytes,
      'fixture self-check: this batch must serialize past the 64 KiB keepalive budget, or the test proves nothing'
    ).toBeGreaterThan(KEEPALIVE_BODY_BUDGET_BYTES);

    for(const call of sent) {
      expect(
        call.keepalive,
        'a periodic flush marked keepalive is capped at 64 KiB of body by the Fetch standard: the moment a ' +
        'misbehaving client logs more than that into one batch, the browser rejects the push with a TypeError ' +
        'before any network I/O, the batch is requeued into an even larger payload, and every later flush fails ' +
        'the same way — a permanent blackout, and the investigation goes blind exactly when the client misbehaves. ' +
        'Keepalive exists for the unload path, not for periodic sends'
      ).toBeFalsy();
    }

    const delivered = sent.map((call) => call.bodyText).join('');
    expect(
      delivered,
      'removing the cap must not cost the oldest entry of a healthy over-budget batch its delivery'
    ).toContain(seqTag(0));
    expect(
      delivered,
      'removing the cap must not cost the newest entry of a healthy over-budget batch its delivery'
    ).toContain(seqTag(OVER_BUDGET_ENTRY_COUNT - 1));
  });

  it('the unload flush keeps keepalive and bounds its total body to the keepalive budget', async() => {
    const marker = 'keepalive-budget-unload';
    emitPaddedEntries(getLogger(marker), marker, OVER_BUDGET_ENTRY_COUNT);

    window.dispatchEvent(new Event('pagehide'));

    const sent = callsCarrying(marker);
    expect(
      sent.length,
      'the unload flush sent nothing: the final diagnostics before the tab dies — the ones that explain ' +
      'the death — never leave the machine'
    ).toBeGreaterThan(0);

    for(const call of sent) {
      expect(
        call.keepalive,
        'the unload flush is the one sender that needs keepalive: without it the request is aborted together ' +
        'with the dying page, and the last diagnostics before a crash-close are lost'
      ).toBe(true);
    }

    // The 64 KiB budget is shared across ALL in-flight keepalive requests of the origin, so the
    // bound is on the SUM: splitting an over-budget batch into parallel keepalive requests still
    // busts the budget and still loses the tail of the log.
    const totalKeepaliveBytes = sent.reduce((total, call) => total + call.bodyBytes, 0);
    expect(
      totalKeepaliveBytes,
      'the browser rejects keepalive bodies past 64 KiB total before any network I/O: an unbounded unload ' +
      'flush throws away exactly the final diagnostics of a dying page — the ones every live investigation ' +
      'of a client crash depends on'
    ).toBeLessThanOrEqual(KEEPALIVE_BODY_BUDGET_BYTES);

    const delivered = sent.map((call) => call.bodyText).join('');
    expect(
      delivered,
      'when the budget forces a choice, the newest entries are the ones that explain why the page is dying ' +
      'and must be the ones that ship'
    ).toContain(seqTag(OVER_BUDGET_ENTRY_COUNT - 1));
  });

  it('a failed batch cannot grow the next payload past the budget: oldest entries are dropped, and accounted', async() => {
    const marker = 'keepalive-budget-requeue';
    const logger = getLogger(marker);
    // The exact live failure: the browser rejects the over-budget keepalive push pre-network.
    const transportError = new TypeError('NetworkError when attempting to fetch resource.');
    respondTo = (callIndex) => callIndex === 0 ? Promise.reject(transportError) : Promise.resolve(okResponse());

    emitPaddedEntries(logger, marker, OVER_BUDGET_ENTRY_COUNT);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    // Flush #1 has failed and requeued. The client keeps misbehaving — and keeps logging.
    logger.info(`${marker} ${seqTag(OVER_BUDGET_ENTRY_COUNT)} ${ENTRY_PADDING}`);
    logger.info(`${marker} ${seqTag(OVER_BUDGET_ENTRY_COUNT + 1)} ${ENTRY_PADDING}`);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 1);
    await drainMicrotasks();

    const retries = callsCarrying(marker).slice(1);
    expect(
      retries.length,
      'no retry flush went out after a transport failure — one failed push silenced the client for good'
    ).toBeGreaterThan(0);

    for(const call of retries) {
      expect(
        call.bodyBytes,
        'a failed flush requeues its whole batch in front of everything newer, so the retry payload only ever ' +
        'grows: once it crosses the 64 KiB keepalive budget, every subsequent attempt is rejected by the browser ' +
        'before any network I/O — a permanent, self-sustaining blackout, and the investigation goes blind ' +
        'exactly when the client misbehaves. The retry must shed load down to the budget instead'
      ).toBeLessThanOrEqual(KEEPALIVE_BODY_BUDGET_BYTES);
    }

    const retriedText = retries.map((call) => call.bodyText).join('');
    expect(
      retriedText,
      'shedding load must keep the newest diagnostics: the entries logged closest to the failure are the ones ' +
      'that explain it'
    ).toContain(seqTag(OVER_BUDGET_ENTRY_COUNT + 1));
    expect(
      retriedText,
      'entries beyond the budget must be dropped oldest-first: keeping the oldest means the payload can never ' +
      'shrink back under the budget, and no later diagnostic ever ships again'
    ).not.toContain(seqTag(0));

    expect(
      warnLines.some((line) => /Dropped \d+/.test(line)),
      'diagnostics beyond the budget may be dropped, but never silently: the existing dropped-entries ' +
      'accounting must say how many were lost, or a gap in Loki reads as "the client was fine"'
    ).toBe(true);
  });

  it('negative control: a small batch still ships exactly as today — one push, same body shape', async() => {
    const marker = 'keepalive-budget-small';
    const logger = getLogger(marker);
    logger.info(`${marker} first`);
    logger.info(`${marker} second`);
    logger.info(`${marker} third`);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await drainMicrotasks();

    const sent = callsCarrying(marker);
    expect(
      sent,
      'a batch well inside the budget must still go out as a single push — the fix must not tax the healthy path'
    ).toHaveLength(1);

    const call = sent[0];
    expect(call.url).toBe(`${backendHttpOrigin()}/loki/api/v1/push`);
    expect(call.init.method).toBe('POST');
    expect(call.init.credentials).toBe('omit');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const payload = JSON.parse(call.bodyText) as {
      streams: {stream: Record<string, string>, values: [string, string][]}[]
    };
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0].stream).toEqual({service_name: 'ImpulseM.Web', component: 'main', level: 'info'});
    expect(payload.streams[0].values).toHaveLength(3);
    for(const [timestampNanos, line] of payload.streams[0].values) {
      expect(timestampNanos).toMatch(/^\d+$/);
      const record = JSON.parse(line) as {level: string, module: string, message: string};
      expect(record.level).toBe('info');
      expect(record.module).toBe(marker);
      expect(record.message).toContain(marker);
    }
  });
});
