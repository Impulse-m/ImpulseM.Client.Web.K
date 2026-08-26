import {beforeEach, describe, expect, it, vi} from 'vitest';

import {LogTypes} from '@lib/logger';

/**
 * One chatty call site must not be able to saturate the network.
 *
 * Every upstream logger call reaches the telemetry sink unconditionally — that is deliberate, and
 * right for a timeline. It was also, until this budget existed, right for the network, which it is
 * not. A single upstream module logging inside a render loop put 5,037 lines on the wire in eight
 * minutes: ninety-seven per cent of everything the client sent, from one call.
 *
 * The call site was doing nothing unusual. It logged ten times a second because upstream logs go to
 * a console, where ten a second costs nothing. That is exactly why the budget cannot live at call
 * sites: the next chatty one will not know to ask either.
 *
 * The second test is the one that matters most. A throttle that drops silently is worse than the
 * flood, because a gap in the log reads as "the code stopped running" and sends the next reader
 * looking for a bug that is not there.
 */
describe('log shipping is budgeted per call site', () => {
  let capture: typeof import('@lib/debug/logsBuffer').capture;
  let setLogSink: typeof import('@lib/debug/logsBuffer').setLogSink;
  let shipped: {prefix: string, args: any[]}[];

  beforeEach(async() => {
    vi.resetModules();
    const module = await import('@lib/debug/logsBuffer');
    capture = module.capture;
    setLogSink = module.setLogSink;
    shipped = [];
    setLogSink((_level, prefix, args) => {
      shipped.push({prefix, args});
    });
  });

  it('stops shipping a call site that floods, and keeps shipping a quiet one', () => {
    for(let i = 0; i < 500; ++i) {
      capture(LogTypes.Log, 'SEARCH-SUPER', ['load']);
    }
    capture(LogTypes.Log, 'SOMETHING-ELSE', ['a rare and interesting event']);

    const flooded = shipped.filter((entry) => entry.prefix === 'SEARCH-SUPER');
    const quiet = shipped.filter((entry) => entry.prefix === 'SOMETHING-ELSE');

    expect(
      flooded.length,
      'five hundred calls from one site shipped almost unchanged means the budget is not applied, ' +
      'and one render loop can put the client back on the wire at ten lines a second'
    ).toBeLessThan(100);

    expect(
      quiet.length,
      'the budget is per call site precisely so that a flood elsewhere cannot cost an unrelated ' +
      'event its delivery — a throttle that drops the rare line is worse than no throttle'
    ).toBe(1);
  });

  it('never drops silently: the next line after a throttled window says how many were lost', () => {
    vi.useFakeTimers();
    try {
      for(let i = 0; i < 200; ++i) {
        capture(LogTypes.Log, 'NOISY', ['tick']);
      }
      const duringWindow = shipped.length;

      vi.advanceTimersByTime(11_000);
      capture(LogTypes.Log, 'NOISY', ['tick']);

      const afterWindow = shipped.slice(duringWindow);
      expect(afterWindow).toHaveLength(1);

      const note = afterWindow[0].args.join(' ');
      expect(
        /\d+ further lines from this call site were not shipped/.test(note),
        'a gap with no explanation reads as "the code stopped running" and sends the next reader ' +
        `hunting a bug that is not there. The line carried: ${note}`
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
