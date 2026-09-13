import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {PersonaSession} from './personaSession';


/*
 * Two accounts, one browser — the CEO's multi-account realtime report.
 *
 * REPORTED: two accounts open in one browser, and realtime updates break for one of them.
 *
 * WHY IT HAS TO COME TO THE REAL BROWSER. tweb binds a TAB to one account through the `account`
 * URL param, but the connection that carries updates lives in the SharedWorker, which is shared
 * across every tab of the browser. #436 moved every per-account credential into a map keyed by
 * account number; the realtime CONNECTION lifecycle was the one piece still held as a
 * SharedWorker-wide singleton, and bringing up the second account called stopImpulseRealtime() and
 * disconnected the first account's socket. Only a real browser has that shared worker across two
 * tabs — the node harness has the managers but not the shared connection surface, so this is the
 * last place the defect is visible.
 *
 * TWO TABS, ONE CONTEXT. Account A signs UP on the default tab (slot 1). Account B signs UP on a
 * SECOND tab of the SAME context at `?account=2` (slot 2) — PersonaSession.openAdditionalAccount.
 * The two tabs share one SharedWorker, so B's bring-up is exactly the event that, on the singleton,
 * tears down A's socket. A is never reloaded after B signs in: "without refreshing the page" is the
 * whole of the complaint.
 *
 * A THIRD PARTY WRITES TO A. A self-send would settle off the sendMessage response regardless of the
 * socket; a message from a third persona can only reach account A through A's own live `user:{id}`
 * push socket. So account A's tab, sitting in the conversation with the third party and never
 * reloaded, must show the message live — RED today, because B's sign-in disconnected A.
 */
const signUpTimeoutMs = 240_000;
const appearanceTimeoutMs = 60_000;


test('#multiaccount a message sent to the first account still arrives live after a SECOND account signs in on another tab of the same browser', async({browser}, testInfo) => {
  const personaA = ephemeralPersona(`two-acc-a-${testInfo.testId}`);
  const personaB = ephemeralPersona(`two-acc-b-${testInfo.testId}`);
  const outsiderPersona = ephemeralPersona(`two-acc-sender-${testInfo.testId}`);

  // Account A on the default tab (slot 1).
  const accountA = await PersonaSession.open(browser, personaA);
  // Account B on a SECOND tab of the SAME context (slot 2) — shares A's SharedWorker.
  const accountB = await PersonaSession.openAdditionalAccount(accountA, personaB, 2);
  // The third party who writes to A — its own browser context, a genuinely separate client.
  const outsider = await PersonaSession.open(browser, outsiderPersona);

  try {
    // Sequential and ordered: A first, then B on the shared worker. On the singleton, THIS is the
    // step that tears A's socket down. B is signed in and left as the foreground account; A is never
    // touched again except to read.
    await accountA.signUpThroughUi();
    await accountB.signUpThroughUi();
    await outsider.signUpThroughUi();

    // A sits in the conversation with the outsider BEFORE anything is sent, and is not reloaded.
    await outsider.openDialogWithPhone(accountA.persona.phone);
    await accountA.openDialogWithPhone(outsider.persona.phone);

    const marker = `two-accounts-${Date.now()}`;
    await outsider.sendTextThroughUi(marker);

    // THE DEFECT: account A — the account brought up FIRST, whose socket the second account's
    // bring-up disconnected on the singleton — must still receive its inbound message live.
    try {
      await accountA.waitForIncomingText(marker);
    } catch(error) {
      const realtimeA = await accountA.describeRealtimeState();
      const realtimeB = await accountB.describeRealtimeState();
      const outsiderRealtime = await outsider.describeRealtimeState();
      throw new Error(
        `Account A never showed "${marker}" within ${appearanceTimeoutMs} ms after a SECOND account ` +
        'signed in on another tab of the same browser — bringing up account B tore down account A\'s ' +
        'realtime socket (the SharedWorker-wide singleton stopImpulseRealtime), so the first account ' +
        'stopped receiving anything live without a reload (#436).\n\n' +
        `ACCOUNT A REALTIME STATE (the silenced account): ${realtimeA}\n\n` +
        `ACCOUNT B REALTIME STATE (the survivor): ${realtimeB}\n\n` +
        `OUTSIDER REALTIME STATE (control, this client works): ${outsiderRealtime}\n\n` +
        `Original: ${String(error)}`
      );
    }
  } finally {
    // Close the standalone contexts, then the shared one (which disposes account B's tab too).
    await outsider.close().catch(() => {});
    await accountB.closePageOnly().catch(() => {});
    await accountA.close().catch(() => {});
  }
});

test.describe.configure({timeout: signUpTimeoutMs + appearanceTimeoutMs + 180_000});
