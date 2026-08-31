import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {clientPort, liveLane} from './lane';
import {assertMediaFidelity, fidelityExpectationsFor} from './mediaAsserts';
import {recorderWebmVideo} from './mediaFixtures';
import {PersonaSession} from './personaSession';
import {assertBootedAuthorized, assertStorageSurvived, stampStorageSentinel} from './warmStorage';

/*
 * CEO script #4 — the warm cache (issue #108): the state the CEO actually lives in and no
 * fresh-profile scenario ever had. Both personas run in PERSISTENT on-disk browser profiles.
 * They exchange a video and both sides must render it faithfully; then the profiles go
 * through TWO warm transitions — first a tab reload (F5, storage preserved), then a FULL
 * browser restart over the same profile directory — and after each one the SAME fidelity
 * invariant must hold on the SAME message. If a cached bad state can pin a preview to the
 * blur, this is the scenario that catches it.
 *
 * IndexedDB survival across each transition is PROVEN, not assumed (warmStorage.ts): a
 * sentinel record written before must read back verbatim after, no app database may vanish,
 * and the restarted app must boot authorized without the auth pages. A reload that silently
 * wiped storage fails by name instead of running the "warm" assertions against a cold cache.
 *
 * The pair fixture (pair.ts) is deliberately not used: it owns ephemeral in-memory contexts,
 * while this scenario's whole point is the on-disk profile. The CONSOLE CLEAN universal
 * invariant is applied manually at the end over both personas, exactly like the fixture does.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

const mediaScope = '.bubble[data-mid]:not(.service) .attachment';


test('video preview fidelity survives a warm cache: reload and a full browser restart on the same profile', async({}, testInfo) => {
  test.setTimeout(600_000);

  const baseUrl = `http://localhost:${clientPort}/`;
  const sender = await PersonaSession.openPersistent(
    testInfo.outputPath('profile-sender'),
    ephemeralPersona(`warm-sender-${testInfo.testId}`),
    baseUrl
  );
  const recipient = await PersonaSession.openPersistent(
    testInfo.outputPath('profile-recipient'),
    ephemeralPersona(`warm-recipient-${testInfo.testId}`),
    baseUrl
  );

  try {
    await Promise.all([
      sender.signUpThroughUi(),
      recipient.signUpThroughUi()
    ]);
    await sender.openDialogWithPhone(recipient.persona.phone);
    await recipient.openDialogWithPhone(sender.persona.phone);

    const video = recorderWebmVideo('warm-cache-video.webm');
    const expectations = fidelityExpectationsFor([video]);

    await sender.attachMediaThroughUi([video]);
    await recipient.waitForSettledMessageCount(1);

    await assertMediaFidelity(sender.page, 'sender', mediaScope, expectations, 'fresh render');
    await assertMediaFidelity(recipient.page, 'recipient', mediaScope, expectations, 'fresh render');

    // Warm transition #1: a tab reload over the same profile (the CEO's F5).
    const stamp = `warm-${testInfo.testId}-${Date.now()}`;
    const senderBefore = await stampStorageSentinel(sender.page, 'sender', stamp);
    const recipientBefore = await stampStorageSentinel(recipient.page, 'recipient', stamp);

    await sender.reloadAndReopenDialog(recipient.persona.phone);
    await recipient.reloadAndReopenDialog(sender.persona.phone);

    await assertStorageSurvived(sender.page, 'sender', senderBefore, 'tab reload');
    await assertStorageSurvived(recipient.page, 'recipient', recipientBefore, 'tab reload');

    await assertMediaFidelity(sender.page, 'sender', mediaScope, expectations, 'after tab reload (warm #1)');
    await assertMediaFidelity(recipient.page, 'recipient', mediaScope, expectations, 'after tab reload (warm #1)');

    // Warm transition #2: a FULL browser restart over the same profile directory.
    const restartStamp = `${stamp}-restart`;
    const senderBeforeRestart = await stampStorageSentinel(sender.page, 'sender', restartStamp);
    const recipientBeforeRestart = await stampStorageSentinel(recipient.page, 'recipient', restartStamp);

    await sender.restartBrowserProfile();
    await recipient.restartBrowserProfile();

    // Storage proof FIRST (it needs only the origin loaded, not the app booted): if the
    // restart wiped IndexedDB the failure must say so by name, and if storage survived but
    // the app still lands on the auth pages, the split localizes the loss to the app layer.
    await assertStorageSurvived(sender.page, 'sender', senderBeforeRestart, 'browser restart');
    await assertStorageSurvived(recipient.page, 'recipient', recipientBeforeRestart, 'browser restart');
    await assertBootedAuthorized(sender.page, 'sender', 'the browser restart');
    await assertBootedAuthorized(recipient.page, 'recipient', 'the browser restart');

    await sender.openDialogWithPhone(recipient.persona.phone);
    await recipient.openDialogWithPhone(sender.persona.phone);

    await assertMediaFidelity(sender.page, 'sender', mediaScope, expectations, 'after browser restart (warm #2)');
    await assertMediaFidelity(recipient.page, 'recipient', mediaScope, expectations, 'after browser restart (warm #2)');

    const combined = [
      ...[...new Set(sender.consoleClean.failures)].map((entry) => `[sender] ${entry}`),
      ...[...new Set(recipient.consoleClean.failures)].map((entry) => `[recipient] ${entry}`)
    ];
    expect(
      combined,
      `CONSOLE CLEAN violated during "${testInfo.title}" — every entry below is an error the ` +
      'real user\'s console showed while every RPC-level lane stayed green (the #91/#93 class: ' +
      'a main-thread throw that silently loses a send, a render, or persisted state). ' +
      'Entries are verbatim, prefixed with the persona whose page produced them'
    ).toEqual([]);
  } finally {
    await sender.close();
    await recipient.close();
  }
});
