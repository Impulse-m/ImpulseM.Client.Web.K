import {BrowserContextOptions, test as base, expect} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {PersonaSession} from './personaSession';

/*
 * The standing fixture of the B2 lane: every scenario gets a sender/recipient persona pair —
 * two isolated browser contexts, both signed up through the REAL auth UI, each with the
 * dialog to the other one open — and the CONSOLE CLEAN universal invariant is asserted over
 * BOTH pages at teardown unconditionally. A scenario cannot opt out of it and cannot forget
 * it; any error-level console entry, uncaught throw or unhandled rejection on either side
 * fails the scenario with the entry verbatim.
 *
 * Personas follow src/tests/liveharness/personas.ts: ephemeral accounts on the +997 block,
 * unique per run AND per scenario (the label carries the test title), registered through the
 * dev stack's scripted code 11111.
 */
export type PersonaPair = {
  sender: PersonaSession,
  recipient: PersonaSession
};


export const test = base.extend<{
  pair: PersonaPair,
  pairContextOptions: BrowserContextOptions,
  recipientContextOptions: BrowserContextOptions | undefined
}>({
  // Options of both personas' browser contexts; a scenario sets them with test.use({pairContextOptions}).
  pairContextOptions: [{}, {option: true}],
  // Overrides pairContextOptions for the recipient alone, when a scenario needs the two sides to differ.
  recipientContextOptions: [undefined, {option: true}],

  pair: async({browser, pairContextOptions, recipientContextOptions}, use, testInfo) => {
    // The label doubles as the persona's first name and is typed into the sign-up UI, which
    // caps names at 70 chars — testId keeps it short while still unique per scenario.
    // Firefox has no `permissions` context option: its fake devices need none (the project's prefs).
    const forBrowser = (options: BrowserContextOptions): BrowserContextOptions => {
      return browser.browserType().name() === 'firefox' ? {...options, permissions: undefined} : options;
    };
    const senderOptions: BrowserContextOptions = forBrowser(pairContextOptions);
    const recipientOptions: BrowserContextOptions = forBrowser(recipientContextOptions ?? pairContextOptions);
    const sender = await PersonaSession.open(browser, ephemeralPersona(`sender-${testInfo.testId}`), {contextOptions: senderOptions});
    const recipient = await PersonaSession.open(browser, ephemeralPersona(`recipient-${testInfo.testId}`), {contextOptions: recipientOptions});

    try {
      await Promise.all([
        sender.signUpThroughUi(),
        recipient.signUpThroughUi()
      ]);

      await sender.openDialogWithPhone(recipient.persona.phone);
      await recipient.openDialogWithPhone(sender.persona.phone);

      await use({sender, recipient});

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
  }
});

export {expect};
