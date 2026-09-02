import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// One module instance for the whole file. Re-importing after vi.resetModules() would arm a second
// set of listeners on the same window; every later test would then count each report N times.
import '@lib/impulseLogger';

/**
 * Uncaught failures reach Loki through the LIVE listeners, and a storm of one failure cannot
 * drown everything else. (#174)
 *
 * impulseLogger arms `error` and `unhandledrejection` listeners at import time. The sibling test
 * (impulseLoggerUncaught.test.ts) calls the reporter directly and pins what a report carries; it
 * never proves the listeners are installed or that a report survives the transport. These tests
 * drive the real path: a listener that throws, an event on the window, a fetch to Loki.
 *
 * The storm case is the one a reporter with no ceiling turns into its own incident: a crash inside
 * a per-pointer-move listener fires hundreds of times a second, every report is identical, and the
 * logger's bounded buffer sheds the OLDEST entries first -- which are the diagnostics that explain
 * how the client got there. So one signature (error name, message and top stack frame) ships at
 * most MAX_REPORTS_PER_SIGNATURE times per session, the last report says that the rest were
 * suppressed, and a different failure after the storm still ships.
 */

// Mirrors FLUSH_INTERVAL_MS in impulseLogger: advancing this far always fires a pending flush.
const FLUSH_INTERVAL_MS = 2_000;
// The ceiling one signature may reach in one session. The production constant may be lower; it
// can never be higher, so the storm assertion is against this number.
const MAX_REPORTS_PER_SIGNATURE = 10;
// Well past the ceiling and well inside the logger's 1 000-entry buffer, so a shortfall in the
// count is the cap and not the buffer.
const STORM_SIZE = 200;

type UncaughtRecord = {
  level: string,
  module: string,
  message: string,
  payload?: Record<string, unknown>,
  error?: {name: string, message: string, stack?: string}
};

describe('uncaught failures reach Loki through the live listeners', () => {
  let fetchBodies: string[];

  beforeEach(() => {
    vi.useFakeTimers();

    fetchBodies = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchBodies.push(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
      return Promise.resolve({ok: true, status: 204} as unknown as Response);
    });

    // jsdom reports a throwing listener on the virtual console as well; that output is noise here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function flushToLoki(): Promise<void> {
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    for(let i = 0; i < 8; ++i) {
      await Promise.resolve();
    }
  }

  function shippedUncaughtRecords(): UncaughtRecord[] {
    const records: UncaughtRecord[] = [];
    for(const body of fetchBodies) {
      const payload = JSON.parse(body) as {streams: {values: [string, string][]}[]};
      for(const stream of payload.streams) {
        for(const [, line] of stream.values) {
          const record = JSON.parse(line) as UncaughtRecord;
          if(record.module === 'uncaught') {
            records.push(record);
          }
        }
      }
    }
    return records;
  }

  function recordsCarrying(marker: string): UncaughtRecord[] {
    return shippedUncaughtRecords().filter((record) => record.error?.message.includes(marker));
  }

  function dispatchUncaught(error: Error): void {
    window.dispatchEvent(new ErrorEvent('error', {error, message: error.message}));
  }

  it('a throw inside a DOM listener ships to Loki as an error record with its stack', async() => {
    const marker = 'uncaught-storm-listener-throw';
    const button = document.createElement('button');
    document.body.append(button);
    button.addEventListener('click', () => {
      throw new Error(marker);
    });

    button.click();
    await flushToLoki();

    const shipped = recordsCarrying(marker);
    expect(
      shipped,
      'a synchronous throw inside a DOM listener never reached Loki: the crash is visible only in the ' +
      'user\'s own console, which nobody is watching -- the exact blindness #33 was found through'
    ).toHaveLength(1);
    expect(shipped[0].level).toBe('error');
    expect(
      shipped[0].error?.stack,
      'a report without a stack names a failure but not where it is; the report must carry the stack'
    ).toEqual(expect.any(String));
  });

  it('an unhandled rejection ships to Loki as an error record', async() => {
    const marker = 'uncaught-storm-rejection';
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', {value: new Error(marker)});

    window.dispatchEvent(event);
    await flushToLoki();

    expect(
      recordsCarrying(marker),
      'an unhandled rejection never reached Loki: every fire-and-forget async chain in the client fails ' +
      'silently for telemetry'
    ).toHaveLength(1);
  });

  it('one signature repeating past the ceiling ships at most the ceiling, says so, and does not silence other failures', async() => {
    const marker = 'uncaught-storm-repeating';
    const otherMarker = 'uncaught-storm-after-the-storm';

    // Same name, message and top frame every time: the shape of a crash in a per-pointer-move
    // listener, which is the shape a reporter with no ceiling turns into its own incident.
    const throwFromOnePlace = (): Error => new Error(marker);
    for(let i = 0; i < STORM_SIZE; ++i) {
      dispatchUncaught(throwFromOnePlace());
    }
    dispatchUncaught(new Error(otherMarker));
    await flushToLoki();

    const storm = recordsCarrying(marker);
    expect(
      storm.length,
      'a repeating uncaught failure shipped without a ceiling: hundreds of identical reports per second ' +
      'push every OTHER diagnostic out of the bounded buffer oldest-first, so the storm erases exactly ' +
      'the records that explain how the client got there, and the fix becomes its own incident'
    ).toBeLessThanOrEqual(MAX_REPORTS_PER_SIGNATURE);
    expect(
      storm.length,
      'the ceiling must not swallow the failure entirely: the first occurrences are the diagnostic'
    ).toBeGreaterThanOrEqual(1);

    const accounted = storm.filter((record) => record.payload?.furtherOccurrencesSuppressed === true);
    expect(
      accounted,
      'suppression must be visible in the data: a gap after the ceiling that no record accounts for ' +
      'reads in Loki as "the storm stopped", and a storm that stopped is the opposite of what happened'
    ).toHaveLength(1);

    expect(
      recordsCarrying(otherMarker),
      'the ceiling is per signature, not per session: a different failure after the storm must still ship, ' +
      'or the first storm of a session blinds telemetry to everything that follows it'
    ).toHaveLength(1);
  });

  it('negative control: a signature below the ceiling ships every occurrence and claims no suppression', async() => {
    const marker = 'uncaught-storm-below-ceiling';
    const occurrences = 3;

    for(let i = 0; i < occurrences; ++i) {
      dispatchUncaught(new Error(marker));
    }
    await flushToLoki();

    const shipped = recordsCarrying(marker);
    expect(
      shipped,
      'a failure that repeats a few times is a few data points, not a storm: the ceiling must not tax it'
    ).toHaveLength(occurrences);
    expect(
      shipped.some((record) => record.payload?.furtherOccurrencesSuppressed === true),
      'a report that claims suppression when nothing was suppressed makes the accounting worthless'
    ).toBe(false);
  });
});
