import {describe, expect, it} from 'vitest';

import {
  ProductionReconnectJitterMaxMs,
  ReconnectFloorMs,
  sdkReconnectDelay
} from '@lib/impulse/realtimeDiscipline';
import {ReconnectJitterMinMs} from '@lib/impulse/realtime';


/*
 * #445. Every socket the server hangs up on used to come back inside 2 ms.
 *
 * `realtime.ts` passed `minReconnectDelay: 1`, overriding the SDK's own default of 500, on the
 * strength of a comment that said "Production reconnects spread across 20 seconds". Nothing spread
 * anything: `maxReconnectDelay` is the exponential CAP, and the SDK's ladder grows its random range
 * from the FLOOR, so at attempt 0 the delay is `1 + randInt(0, 1)`. `_connectResponse` resets the
 * attempt counter, so a socket that was healthy at the moment of the disconnect always starts at
 * attempt 0 -- which is exactly the case a server-initiated disconnect creates, for every socket at
 * once.
 *
 * That is live today for 3001 Shutdown, 3005 DisconnectExpired and 3012 DisconnectNoPong: a
 * Centrifugo rolling restart already produces the herd. It also blocks #426, because the server has
 * no way to spread the wave itself -- the Disconnect message carries only {code, reason}
 * (protos/vendor/centrifugo/v6/api.proto:228-234) and the SDK reads the code only to decide WHETHER
 * to reconnect, never WHEN.
 *
 * These assert the floor our options actually produce, against the SDK's published ladder, rather
 * than asserting the constant back to itself. The worst case is `random() -> 0`, which is what a
 * herd's unluckiest cohort gets and what decides the peak rate.
 */
describe('the first reconnect after a server disconnect has a real floor', () => {
  const WORST_CASE = () => 0;

  const MUST_HAVE_A_FLOOR =
    'The first reconnect delay is what decides the peak connect rate after a server-initiated ' +
    'disconnect, because every socket that was healthy starts at attempt 0 together. At a 1 ms ' +
    'floor one Centrifugo node\'s worth of sockets returns inside the same 2 ms, each re-subscribing ' +
    '33 channels, each channel costing 5 unconditional Redis writes (#445).';

  it('does not let the configured floor collapse to the SDK ladder\'s first rung', () => {
    expect(
      sdkReconnectDelay(0, ReconnectJitterMinMs, ProductionReconnectJitterMaxMs, WORST_CASE),
      MUST_HAVE_A_FLOOR
    ).toBeGreaterThanOrEqual(ReconnectFloorMs);
  });

  it('keeps the floor for the whole early ladder, not just the first rung', () => {
    // Attempts 0-3 are where a herd actually lands: by attempt 4 the random window has grown past
    // the floor on its own. Asserting only attempt 0 would pass on a fix that special-cased it.
    for(let attempt = 0; attempt <= 3; ++attempt) {
      expect(
        sdkReconnectDelay(attempt, ReconnectJitterMinMs, ProductionReconnectJitterMaxMs, WORST_CASE),
        `${MUST_HAVE_A_FLOOR} Attempt ${attempt} fell below it.`
      ).toBeGreaterThanOrEqual(ReconnectFloorMs);
    }
  });

  it('still spreads: the ladder must not become a fixed delay', () => {
    // The counterpart, and it is not optional. Setting minDelay == maxDelay would satisfy every
    // floor assertion above and hand every socket the SAME delay -- a herd moved rather than
    // spread. This pins that the unluckiest and the luckiest get different answers.
    const earliest = sdkReconnectDelay(0, ReconnectJitterMinMs, ProductionReconnectJitterMaxMs, () => 0);
    const latest = sdkReconnectDelay(0, ReconnectJitterMinMs, ProductionReconnectJitterMaxMs, () => 0.999999);

    expect(
      latest,
      'a reconnect policy with no spread is a herd with a delay in front of it, not a fixed herd'
    ).toBeGreaterThan(earliest);
  });

  it('reproduces the SDK ladder exactly, so the assertions above mean something', () => {
    // If this drifts from the shipped bundle, every assertion in this file is measuring a fiction.
    // Values computed by hand from min(max, min + randInt(0, min(max, min * 2^attempt))).
    expect(sdkReconnectDelay(0, 500, 20_000, () => 0)).toBe(500);
    expect(sdkReconnectDelay(0, 500, 20_000, () => 0.999999)).toBe(1000);
    expect(sdkReconnectDelay(3, 500, 20_000, () => 0)).toBe(500);
    expect(sdkReconnectDelay(3, 500, 20_000, () => 0.999999)).toBe(4500);
    // The cap wins once min * 2^attempt passes it, and it caps the SUM rather than the window.
    expect(sdkReconnectDelay(20, 500, 20_000, () => 0.999999)).toBe(20_000);
    // Attempts are clamped at 31, so a long-running reconnect loop cannot overflow the shift.
    expect(sdkReconnectDelay(99, 500, 20_000, () => 0)).toBe(500);
  });
});
