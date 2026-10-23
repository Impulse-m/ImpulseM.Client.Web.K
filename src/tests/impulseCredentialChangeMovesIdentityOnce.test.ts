import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * One credential transition moves the identity of the slot once: each move retires the fleet lanes of the old identity and
 * re-keys the update socket, so a transition that reports itself twice would retire the lanes of an identity it just made.
 */

const {accountGet, accountUpdate, accountClearFields, resetFleetIdentitySpy} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn(),
  resetFleetIdentitySpy: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

vi.mock('@lib/impulse/fleet/fleet', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/fleet/fleet')>();
  return {
    ...actual,
    resetFleetIdentity: (accountNumber: ActiveAccountNumber): void => {
      resetFleetIdentitySpy(accountNumber);
      actual.resetFleetIdentity(accountNumber);
    }
  };
});

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const SESSION_TOKEN: string = 'access-jwt-stored';
const REFRESH_TOKEN: string = 'refresh-token-stored';
const PENDING_TOKEN: string = 'pending-token-stored';

beforeEach(() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  resetFleetIdentitySpy.mockClear();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
});

describe('a restore moves the identity of the slot once', () => {
  it('a stored session that still holds a pending challenge moves the identity once, not once per credential', async() => {
    accountGet.mockResolvedValue({
      userId: 42,
      impulse_session_token: SESSION_TOKEN,
      impulse_refresh_token: REFRESH_TOKEN,
      impulse_pending_token: PENDING_TOKEN
    });
    const {restoreImpulseSession} = await import('@lib/impulse/session');

    await restoreImpulseSession(ACCOUNT);

    expect(
      resetFleetIdentitySpy,
      'the restore is one credential transition: its fleet lanes retire once, not once for the pending token and again for the session'
    ).toHaveBeenCalledTimes(1);
  });
});

describe('a sign-out moves the identity of the slot once', () => {
  it('a sign-out of a slot that still holds a pending challenge moves the identity once', async() => {
    accountGet.mockResolvedValue({
      userId: 42,
      impulse_session_token: SESSION_TOKEN,
      impulse_refresh_token: REFRESH_TOKEN,
      impulse_pending_token: PENDING_TOKEN
    });
    const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
    await restoreImpulseSession(ACCOUNT);
    resetFleetIdentitySpy.mockClear();

    await clearImpulseSession(ACCOUNT);

    expect(
      resetFleetIdentitySpy,
      'the sign-out is one credential transition: the session and the pending challenge leave together, with one identity move'
    ).toHaveBeenCalledTimes(1);
  });
});
