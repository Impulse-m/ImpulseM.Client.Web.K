/*
 * A new login is confirmed from another logged-in session even when that session is itself unconfirmed:
 * the prompt reaches every other session, and its Yes confirms the new one.
 * Canon: api/auth.md:937-949.
 */
import {afterAll, beforeAll, expect, it} from 'vitest';

import type {AuthLoginToken, Authorization} from '@layer';

import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona, Persona} from './personas';
import {AnonymousRpcSession, claimFreshNumber, openAnonymousRpcSession, openMinimalRpcSession, MinimalRpcSession} from './rpcDriver';
import {signInHeadless} from './authFlow';


type AuthorizationRow = Authorization.authorization;


function requireRow(
  rows: AuthorizationRow[],
  matches: (row: AuthorizationRow) => boolean,
  what: string
): AuthorizationRow {
  const row: AuthorizationRow | undefined = rows.find(matches);
  if(!row) {
    throw new Error(`account.getAuthorizations carries no ${what}`);
  }

  return row;
}


describeLive('a new login is confirmed from a session that is itself unconfirmed', () => {
  const rejections: UnhandledRejectionGuard = new UnhandledRejectionGuard();
  const persona: Persona = ephemeralPersona('ConfirmFromUnconfirmed');

  let first: MinimalRpcSession | undefined;
  let approver: LiveStack | undefined;
  let newLogin: AnonymousRpcSession | undefined;

  beforeAll(() => {
    rejections.install();
  });

  afterAll(async() => {
    rejections.uninstall();
    newLogin?.close();
    first?.close();
    await approver?.dispose();
  });

  it('confirms the new session from the unconfirmed approver, and only that session turns confirmed', async() => {
    // A reserved number allows 3 login codes an hour: the claim and A's sign-in spend 2, so B must not claim again.
    await claimFreshNumber(liveLane.gatewayOrigin, persona);
    first = await openMinimalRpcSession(liveLane.gatewayOrigin, persona);

    // signInOnce refuses an account found under an ephemeral persona, so B signs in under the same number with another last name.
    const approverPersona: Persona = {...persona, lastName: 'Approver'};
    approver = await bootLiveManagerStack(liveLane.gatewayOrigin);
    const {userId: approverUserId} = await signInHeadless(approver, approverPersona);
    expect(String(approverUserId), 'the approver must sign in to the same account as A').toBe(first.userId);

    const app = approver.helpers.appConfig;
    newLogin = openAnonymousRpcSession(liveLane.gatewayOrigin);
    const exported: AuthLoginToken = await newLogin.invoke('auth.exportLoginToken', {
      api_id: app.id,
      api_hash: app.hash,
      except_ids: []
    });
    if(exported._ !== 'auth.loginToken') {
      throw new Error(`auth.exportLoginToken answered ${exported._}, not an unaccepted login token`);
    }

    const accepted: AuthorizationRow = await approver.managers.apiManager.invokeApi('auth.acceptLoginToken', {token: exported.token});
    const newLoginHash: string = String(accepted.hash);

    const beforeRows: AuthorizationRow[] = (await first.invoke('account.getAuthorizations', {})).authorizations;
    const newLoginBefore: AuthorizationRow = requireRow(
      beforeRows,
      (row: AuthorizationRow): boolean => String(row.hash) === newLoginHash,
      `session ${newLoginHash} for the QR login`
    );
    expect(newLoginBefore.pFlags.unconfirmed, 'the QR-login session must be unconfirmed before the approval').toBe(true);

    const approverBefore: AuthorizationRow = requireRow(
      beforeRows,
      (row: AuthorizationRow): boolean => !row.pFlags.current && String(row.hash) !== newLoginHash,
      'row for the approver, which is neither the current session nor the new one'
    );
    const approverHash: string = String(approverBefore.hash);
    expect(approverBefore.pFlags.unconfirmed, 'the approver session must be unconfirmed for this scenario to prove anything').toBe(true);

    // The client holds the prompt back on a session younger than FRESH_AUTHORIZATION_PERIOD (appAccountManager.ts:221-224), and B signed in just now: the hash comes from the session list.
    const confirmed: boolean = await approver.managers.appAccountManager.confirmUnconfirmedAuthorization(newLoginHash);
    expect(confirmed, 'Yes from an unconfirmed session must confirm the new login (api/auth.md:937-949)').toBe(true);

    const afterRows: AuthorizationRow[] = (await first.invoke('account.getAuthorizations', {})).authorizations;
    const newLoginAfter: AuthorizationRow = requireRow(
      afterRows,
      (row: AuthorizationRow): boolean => String(row.hash) === newLoginHash,
      `session ${newLoginHash} for the QR login after the approval`
    );
    expect(newLoginAfter.pFlags.unconfirmed, 'the new session must no longer be unconfirmed after Yes').toBeFalsy();

    const approverAfter: AuthorizationRow = requireRow(
      afterRows,
      (row: AuthorizationRow): boolean => String(row.hash) === approverHash,
      `session ${approverHash} for the approver after the approval`
    );
    expect(approverAfter.pFlags.unconfirmed, 'the approver was not named by the approval and must stay unconfirmed').toBe(true);

    approver.wire.assertClean('confirming a new login from an unconfirmed session');
    rejections.assertNone('confirming a new login from an unconfirmed session');
  }, 120_000);
});
