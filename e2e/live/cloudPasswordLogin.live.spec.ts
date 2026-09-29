import {expect, test} from '@playwright/test';

import {ephemeralPersona} from '../../src/tests/liveharness/personas';
import {liveLane} from './lane';
import {PersonaSession} from './personaSession';

test.skip(!liveLane.enabled, liveLane.skipReason);

/*
 * #675 — cloud-password login regression.
 *
 * REPORTED (issue #675, live evidence
 * .local/share/impulsem-cao/runs/cloud-password-login-correlated-20260918.json): after setting a
 * cloud password and entering the SMS code on a fresh sign-in, the client bounces back to the
 * sign-in form instead of reaching the password card — or, once it does reach the card, the card
 * cannot actually complete a login. The Loki trace shows `auth.signIn` correctly answering
 * `SESSION_PASSWORD_NEEDED`, immediately followed by `account.getPassword` failing
 * `AUTH_KEY_UNREGISTERED`: the pending-2FA identity the backend hands back on the first error
 * (gRPC trailer `pending-token`) never reaches the second call. This scenario does not assert the
 * transport mechanism (that is a Gateway/backend concern under separate investigation) — it
 * asserts the OBSERVABLE client behaviour canon requires end to end.
 *
 * CANON (.demo/telegram-docs-text, read and re-derived for this file):
 *   - api/auth.md:792-815 — auth.signIn on a 2FA account answers `error 400
 *     SESSION_PASSWORD_NEEDED` (line 795); the client must then follow SRP 2FA
 *     (account.getPassword -> auth.checkPassword) and, on success, auth.checkPassword returns an
 *     auth.authorization the same way auth.signIn would (lines 813-815).
 *   - method/account.getPassword.md:33-39 — no parameters; "This method can be invoked over an
 *     unauthenticated connection" (the pending-2FA window, not a full session).
 *   - method/auth.checkPassword.md:44-56 — same unauthenticated-connection note; a wrong password
 *     answers `400 PASSWORD_HASH_INVALID` (lines 54-56) rather than tearing down the attempt.
 *
 * THE GENUINE CLOSING TEST (not just "the password card stayed visible"): a FRESH ephemeral
 * persona is signed up, given a cloud password through the real manager, then a SEPARATE clean
 * browser context signs into that SAME account through the real phone/SMS form. An incorrect
 * password must be visibly rejected while the pending flow stays open for correction; the correct
 * password must then reach real authenticated UI as the CORRECT account — the only end state that
 * actually closes the reported incident.
 */

const testCloudPassword = 'impulse-e2e-675-cloud-password';
const wrongCloudPassword = 'impulse-e2e-675-wrong-password';

const setupTimeoutMs = 240_000;
const loginTimeoutMs = 240_000;
const passwordStepTimeoutMs = 60_000;

test(
  '#675 a fresh cloud-password account signs in through SESSION_PASSWORD_NEEDED -> password card, ' +
  'rejecting a wrong password before accepting the right one',
  async({browser}, testInfo) => {
    const persona = ephemeralPersona(`cloud-pwd-${testInfo.testId}`);

    // Separate, RETAINED authorized session: creates the account, sets the test password, and —
    // in `finally` — clears it again. Never the session under test; the login half below opens
    // its own clean context.
    const setupSession = await PersonaSession.open(browser, persona);
    let loginSession: PersonaSession | undefined;

    // Flipped ONLY once this run has explicitly PROVEN two things in order: it created this
    // account (the assertion below passed, not merely `reusedExistingAccount`'s false-by-default
    // value) and it actually installed the test password on it. Cleanup below mutates the
    // account's password ONLY when this is true — never by default, never by inferring ownership
    // from a caught exception (review #216 finding 2: relying on computeSRP's incidental
    // TypeError on a passwordless account was an accident, not a guard).
    let installedTestPasswordOnOwnAccount = false;
    let productError: unknown;

    try {
      // 1. A genuinely fresh persona. signUpThroughUi (personaSession.ts) throws BY NAME on a
      // password-protected collision instead of silently reusing or resetting one; the assertion
      // below is the second, explicit proof that THIS run created the account, using the same
      // field #509's earlier fixes already surfaced for exactly this purpose.
      await setupSession.signUpThroughUi();
      expect(
        setupSession.reusedExistingAccount,
        'SETUP PRECONDITION FAILURE (not a product-regression signal): signUpThroughUi reused an ' +
        'existing account for this run\'s freshly-allocated persona instead of creating one. This ' +
        'run cannot prove it owns whatever password state that account already carries, so setting ' +
        'or asserting a password on it would not be evidence about #675 either way. The reserved ' +
        'test block wraps across runs (#509) — rerun with a fresh persona/slot.'
      ).toBe(false);

      const ownerPeerId = await setupSession.ownPeerId();

      // 2. The real manager/API flow — passwordManager.updateSettings, the same call Settings ->
      // Privacy and Security -> Two-Step Verification drives. Test-only password, never logged.
      await setupSession.updateCloudPasswordThroughApi({newPassword: testCloudPassword});
      // Ownership AND installation are both now proven — cleanup may run.
      installedTestPasswordOnOwnAccount = true;

      // 3. A SEPARATE, clean browser context — no injected session, nothing shared with
      // setupSession's storage — logs in through the real phone/SMS form. Canon requires
      // SESSION_PASSWORD_NEEDED here (api/auth.md:795); the assertion is inside
      // signInExpectingPasswordChallengeThroughUi, which fails BY NAME if the client instead
      // signs straight in or shows the sign-up card.
      loginSession = await PersonaSession.open(browser, persona);
      await loginSession.signInExpectingPasswordChallengeThroughUi();

      // 4. Wrong password: canon's PASSWORD_HASH_INVALID (method/auth.checkPassword.md:54-56)
      // must be a VISIBLE rejection with the pending flow retained for correction, not an
      // authenticated end state and not a bounce back to the sign-in form.
      const wrongOutcome = await loginSession.submitPasswordThroughUi(wrongCloudPassword);
      expect(
        wrongOutcome,
        'PRODUCT REGRESSION: submitting an INCORRECT password reached an "authenticated" end state ' +
        '— either the wrong password was accepted, or the client authenticated some other way ' +
        'entirely, instead of the password card staying up (PASSWORD_HASH_INVALID) for correction.'
      ).toBe('rejected');

      // 5. Correct password, submitted a SECOND time in the SAME pending window (the challenge
      // consumed by step 4 must have been refreshed by the card itself, PasswordCard.tsx:186,
      // exactly as a real retry does). This is the actual #675 closing assertion: real
      // authenticated UI, not merely a password input that is still on screen.
      const correctOutcome = await loginSession.submitPasswordThroughUi(testCloudPassword);
      expect(
        correctOutcome,
        'PRODUCT REGRESSION (#675): the CORRECT password, submitted right after an incorrect one was ' +
        'rejected in the same pending flow, did not reach the authenticated end state. Canon\'s ' +
        'SESSION_PASSWORD_NEEDED -> account.getPassword -> SRP -> auth.checkPassword -> ' +
        'auth.authorization (api/auth.md:792-815) must complete a real login here, not bounce the ' +
        'client back to the sign-in form.'
      ).toBe('authenticated');

      // The observable end state is the CORRECT account's own identity, not merely "some"
      // authenticated UI — a session that silently authenticated as a different account would
      // pass a weaker check and be a worse bug than the one under test.
      const authenticatedPeerId = await loginSession.ownPeerId();
      expect(
        authenticatedPeerId,
        'the password-login session authenticated as a DIFFERENT account than the one this run just ' +
        'created and password-protected.'
      ).toBe(ownerPeerId);
    } catch(error) {
      // Captured rather than let propagate immediately: cleanup below still needs to run (and
      // report its OWN failure, if any) without a `throw` inside `finally` silently replacing
      // this — the actual product regression — with a mere teardown problem.
      productError = error;
    } finally {
      // 6. Restore this test-created account to its pre-test (passwordless) state through the
      // RETAINED authorized setup session — never the login session, which may hold no valid
      // authorization if the scenario failed before step 5. Gated on
      // installedTestPasswordOnOwnAccount (never on default state, never on an incidental
      // exception): no account this run did not prove it owns and password-protect itself is
      // ever mutated here. No account deletion, nothing else touched.
      let cleanupError: unknown;
      if(installedTestPasswordOnOwnAccount) {
        try {
          await setupSession.updateCloudPasswordThroughApi({currentPassword: testCloudPassword});
        } catch(cleanupCaughtError) {
          cleanupError = cleanupCaughtError;
        }
      }

      // Contexts close unconditionally regardless of ownership/cleanup outcome — this is
      // resource teardown, not an account mutation.
      await loginSession?.close().catch(() => {});
      await setupSession.close().catch(() => {});

      if(cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if(productError) {
          const productMessage = productError instanceof Error ? productError.message : String(productError);
          throw new Error(
            `PRODUCT FAILURE (the actual #675 regression, reported first): ${productMessage}\n\n` +
            'CLEANUP ALSO FAILED afterward, clearing the test password this run installed on its ' +
            `own account: ${cleanupMessage}`
          );
        }

        throw new Error(
          'every product assertion above PASSED, but cleanup failed to clear the test password this ' +
          `run installed on its own account — it may still carry it: ${cleanupMessage}`
        );
      }
    }

    if(productError) {
      throw productError;
    }
  }
);

test.describe.configure({
  timeout: setupTimeoutMs + loginTimeoutMs + passwordStepTimeoutMs * 2 + 120_000
});
