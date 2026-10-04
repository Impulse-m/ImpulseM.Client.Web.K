import {expect, test as base} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {PersonaSession} from './personaSession';


/*
 * Two devices, one account — issue #319.
 *
 * REPORTED BY THE CEO, in his own words: "я открываю на ноутбуке аккаунт, открываю на компьютере
 * тот же самый аккаунт, пишу с компьютера, допустим, себе в сохранение какое-то сообщение, и оно не
 * появляется на моем ноутбуке". This file is that sentence, executed.
 *
 * WHY IT HAD TO COME TO THE REAL BROWSER. The server half is already measured GREEN and is not the
 * defect: EverySessionOfOneAccountSeesItsMessagesScenario (server repo) drives two real
 * authorizations of one account — each with its own session token and its own Centrifugo credential
 * — and both receive the account's own outgoing self-send and its inbound messages. The node-hosted
 * client harness agrees: a freshly signed-in manager stack reports sockets=1, connectAcks=1,
 * subscribeAcks=[user:<id>], publicationsOn=5, closes=[none].
 *
 * What neither of those has is what the CEO's setup has: a real chromium, with the SharedWorker that
 * owns the connection for a whole browser, a service worker, and persisted multi-account state. Two
 * browser CONTEXTS are two of those — which is what `PersonaSession.open` gives, one isolated
 * context each. That is the last surface between the measured-green server and the observed silence.
 *
 * THE SECOND DEVICE SIGNS IN, it does not sign up. signInThroughUi asserts it was NOT shown the name
 * card: that card means auth.signIn answered authorizationSignUpRequired, i.e. the account was not
 * found, and a run that walked past it would register a second account and then compare two accounts
 * while calling the result multi-device.
 *
 * SAVED MESSAGES IS THE PUREST FORM and is deliberate. There is no second party, no contact edge, no
 * peer to resolve and nothing to hydrate — just one account writing to itself. If this is red, the
 * account's own update stream does not reach its own second session, and every richer scenario
 * inherits it.
 *
 * NO RELOAD ANYWHERE. The whole complaint is "without refreshing the page": the watcher opens Saved
 * Messages BEFORE the writer sends — a laptop already sitting in the chat — and is never navigated
 * again. A scenario that reloaded the watcher would go green over the exact defect it exists for.
 */
const signInTimeoutMs = 240_000;
const appearanceTimeoutMs = 60_000;


const test = base.extend<{account: {writer: PersonaSession, watcher: PersonaSession}}>({
  account: async({browser}, use, testInfo) => {
    const persona = ephemeralPersona(`two-dev-${testInfo.testId}`);

    // Two isolated contexts of ONE persona: two devices, in the only sense the server and the
    // browser can tell apart.
    // IMPULSE_TWO_DEVICES_IN_PROCESS=1 runs both devices with ?noWorker=1, which puts the update
    // pipeline in the page where its console is readable. Diagnostic only — it changes the mode, so
    // a verdict taken under it says which mode it came from.
    const inProcessWorker = process.env.IMPULSE_TWO_DEVICES_IN_PROCESS === '1';
    const writer = await PersonaSession.open(browser, persona, {inProcessWorker});
    const watcher = await PersonaSession.open(browser, persona, {inProcessWorker});

    try {
      // Sequential on purpose. The account has to EXIST before the second device can sign into it,
      // and running the two flows concurrently races the registration against the sign-in — which
      // shows up as the name card on the watcher and would be read as "the account was not found".
      await writer.signUpThroughUi();
      await watcher.signInThroughUi();

      await use({writer, watcher});

      const combined = [
        ...[...new Set(writer.consoleClean.failures)].map((entry) => `[writer] ${entry}`),
        ...[...new Set(watcher.consoleClean.failures)].map((entry) => `[watcher] ${entry}`)
      ];
      expect(
        combined,
        `CONSOLE CLEAN violated during "${testInfo.title}" — every entry below is an error the real ` +
        'user\'s console showed while the lane itself stayed green. On this scenario in particular ' +
        'a watcher-side entry is the likeliest place the missing update is explained'
      ).toEqual([]);
    } finally {
      await writer.close();
      await watcher.close();
    }
  }
});


test('#319 a message written to Saved Messages on one device appears on the account\'s other device', async({account}) => {
  const {writer, watcher} = account;

  // The watcher is a laptop already sitting in the chat. It is opened FIRST and never touched
  // again — no reload, no navigation — because "without refreshing the page" is the complaint.
  await watcher.openSavedMessages();
  await writer.openSavedMessages();

  const marker = `two-devices-${Date.now()}`;
  await writer.sendTextThroughUi(marker);

  // The writer's own device settling is the control: it separates "the send failed" from "the send
  // succeeded and the other device was never told", and those are different defects.
  await writer.waitForOutgoingSettled(marker);

  // THE DEFECT. One account, two devices, and what one writes the other must see.
  const sinceMs = Date.now();
  try {
    await watcher.waitForSettledText(marker, appearanceTimeoutMs);
  } catch(error) {
    // The watcher's own console is where this is explained, and a bare timeout throws it away. The
    // two candidate mechanisms leave different traces: publications arriving and being dropped, or
    // no subscription on user:<id> at all.
    const stored = await watcher.describeStoredHistory(marker);
    const watcherRealtime = await watcher.describeRealtimeState();
    // The WRITER's state is the control for the observer itself. tweb owns its connection from a
    // worker, and an init script runs only in the page — so "the watcher has no Centrifugo socket"
    // means nothing until the writer, which demonstrably works, is shown to have one.
    const writerRealtime = await writer.describeRealtimeState();
    throw new Error(
      `The account's other device never showed "${marker}" within ${appearanceTimeoutMs} ms, while ` +
      'the writing device settled it — the server has the message and the second device was never ' +
      `told (#319).\n\nWATCHER STORED HISTORY (managers, not DOM): ${stored}\n\nWATCHER REALTIME STATE: ${watcherRealtime}\n\nWRITER REALTIME STATE ` +
      `(control, this device works): ${writerRealtime}\n\nWATCHER UPDATE PIPELINE TRAIL:\n` +
      `${watcher.formatUpdatePipelineTrail()}\n\nWRITER UPDATE PIPELINE TRAIL (control):\n` +
      `${writer.formatUpdatePipelineTrail()}\n\nOriginal: ${String(error)}`
    );
  }
});


test('#319 a message arriving from someone else appears on BOTH devices of the account', async({account, browser}, testInfo) => {
  const {writer, watcher} = account;

  // A real third party, not a self-send: the CEO named both halves — "когда мне кто-то пишет, я не
  // вижу, как это сообщение появляется на всех устройствах". The outbound half travels in a
  // container that also carries updateMessageID; this one does not, so it is a different shape and
  // cannot be assumed from the other's green.
  const outsider = await PersonaSession.open(browser, ephemeralPersona(`outsider-${testInfo.testId}`));

  try {
    await outsider.signUpThroughUi();
    await outsider.openDialogWithPhone(writer.persona.phone);

    // Both devices of the account sit in the conversation before anything is sent, and neither is
    // navigated again.
    await writer.openDialogWithPhone(outsider.persona.phone);
    await watcher.openDialogWithPhone(outsider.persona.phone);

    const marker = `inbound-two-devices-${Date.now()}`;
    await outsider.sendTextThroughUi(marker);

    // Both, not either: an account's inbound stream is owed to every authorized session of it, and
    // asserting only one would pass over exactly half of what was reported.
    await writer.waitForSettledText(marker, appearanceTimeoutMs);
    await watcher.waitForSettledText(marker, appearanceTimeoutMs);
  } finally {
    await outsider.close();
  }
});

test.describe.configure({timeout: signInTimeoutMs + appearanceTimeoutMs + 120_000});
