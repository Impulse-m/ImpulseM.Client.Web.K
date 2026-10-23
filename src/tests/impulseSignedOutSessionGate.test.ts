import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import type {ActiveAccountNumber} from '@lib/accounts/types';

import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * Issue #137. A backend blip made a whole boot wave come back AUTH_TOKEN_INVALID, the 401
 * policy cleared the session token and left the account record behind -- and from that moment
 * every reload died before it drew anything:
 *
 *   [LANGPACK] getLangPack failed { langCode: "en", langPack: "web" }
 *   Error: Stored account has no Impulse session token
 *   Uncaught (in promise) Error: Stored account has no Impulse session token
 *
 * The session gate reported "this slot holds no token" through the same channel as "restore
 * broke", so it rejected; every boot consumer awaits that gate, so the boot died with it. The
 * user could not even reach the sign-in screen that would have fixed the state, and the only
 * way out was clearing site data by hand.
 *
 * These pin the behaviour, not the mechanism: a signed-out client reaches a usable screen, the
 * pre-auth call that draws that screen is allowed to travel without a token, and a restore that
 * genuinely failed still stops the boot wave.
 */

const socketHarness = sharedUpdateSocketHarness();

const accountGet = vi.fn();

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

/**
 * `BootstrapExemptMethodContributor` lists this method as pre-auth exempt on purpose: canon needs
 * the langpack to render the login page itself, so it must be reachable with no session.
 */
const GET_LANG_PACK = 'langpack.getLangPack';

/*
 * Exactly the storage state the CEO's browser was left in: the account record survives, its
 * tokens do not. Nothing is corrupt here -- this is what being signed out looks like on disk.
 */
const SIGNED_OUT_ACCOUNT = {userId: 42};

const STUCK_ON_A_BLANK_PAGE =
  'A stored account whose token the 401 policy cleared is the ordinary signed-out state, not a ' +
  'restore failure. The session gate rejected instead of opening, and every boot consumer awaits ' +
  'it, so a signed-out user is stuck on a blank page: the sign-in screen that would repair the ' +
  'state never renders, and only clearing site data by hand gets the client back.';

const LANGPACK_MUST_NOT_BE_BLOCKED =
  'langpack.getLangPack is served without a token by design -- the login page cannot draw its own ' +
  'strings otherwise. The gate blocked it before it ever reached the fleet, which is the ' +
  '"[LANGPACK] getLangPack failed" the CEO saw one tick before the client went blank.';

const LANGPACK_MUST_LEAVE_ONCE =
  'The pre-auth langpack call must actually leave the client once the gate opens. No request ' +
  'reached the fleet at all, so the sign-in screen has no strings to render.';

const LANGPACK_CARRIES_NO_TOKEN =
  'A signed-out client has no session token, and the pre-auth langpack call must travel without ' +
  'a token rather than be held back waiting for one. Requiring a token here is what turns a ' +
  'transient backend blip into a permanently bricked tab.';

const GATE_MUST_STILL_GUARD =
  'Treating a cleared token as the signed-out state must not degrade the gate into one that ' +
  'always opens. The gate exists so no boot RPC leaves before the stored token is in place; ' +
  'when the account store itself throws, nobody knows whether a token exists, and letting the ' +
  'wave go out unauthenticated is what signed a legitimately signed-in user out in the first place.';


function everySlot(): ActiveAccountNumber[] {
  // createManagers builds managers for all four slots and calls after() on each, so the real
  // boot always restores every slot. The gate opens on the last one to report in.
  return Array.from({length: MAX_ACCOUNTS}, (unused, index) => (index + 1) as ActiveAccountNumber);
}


describe('Impulse session gate for a signed-out client', () => {
  beforeEach(registerSessionIdentitySource);

  afterEach(() => {
    vi.resetModules();
    socketHarness.reset();
    accountGet.mockReset();
  });


  it('opens the boot gate when the stored account has lost its session token', async() => {
    accountGet.mockImplementation(async(accountNumber: ActiveAccountNumber) => (
      accountNumber === 1 ? SIGNED_OUT_ACCOUNT : undefined
    ));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    // Slot 1 is the one carrying SIGNED_OUT_ACCOUNT above; each slot now has its
    // own gate, so it is the only one whose outcome this test can mean.
    const outcome = await whenImpulseSessionReady(1).then(
      () => 'gate opened',
      (error: Error) => `gate rejected: ${error?.message}`
    );

    expect(outcome, STUCK_ON_A_BLANK_PAGE).toBe('gate opened');
  });


  it('lets the pre-auth langpack call leave with no token', async() => {
    accountGet.mockImplementation(async(accountNumber: ActiveAccountNumber) => (
      accountNumber === 1 ? SIGNED_OUT_ACCOUNT : undefined
    ));
    socketHarness.respondOnce(GET_LANG_PACK, () => ({data: new Uint8Array(0)}));

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    // Issued on behalf of slot 1, the signed-out account above.
    const outcome = await grpcInvoke(GET_LANG_PACK, {langPack: 'web', langCode: 'en'}, 1).then(
      () => 'served',
      (error: any) => `blocked: ${error?.message ?? error?.type ?? String(error)}`
    );
    const langPackRequests = socketHarness.calls.filter((request) => request.method === GET_LANG_PACK);

    expect(outcome, LANGPACK_MUST_NOT_BE_BLOCKED).toBe('served');
    expect(langPackRequests.length, LANGPACK_MUST_LEAVE_ONCE).toBe(1);
    expect(langPackRequests[0].presentedToken, LANGPACK_CARRIES_NO_TOKEN).toBeUndefined();
  });


  it('still rejects the boot gate when the account store genuinely fails', async() => {
    accountGet.mockRejectedValue(new Error('IndexedDB is unavailable'));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    // Every slot's AccountController.get() call rejects identically here, so
    // any one slot's gate demonstrates the guard; slot 1 stands for all four.
    const outcome = await whenImpulseSessionReady(1).then(
      () => ({name: 'gate opened', code: 'gate opened', message: 'gate opened'}),
      (error: any) => ({name: error?.name, code: error?.code, message: error?.message})
    );

    expect(outcome, GATE_MUST_STILL_GUARD).toMatchObject({
      name: 'ImpulseSessionRestoreError',
      code: 'IMPULSE_SESSION_RESTORE_FAILED',
      message: 'Failed to restore the Impulse session'
    });
  });
});
