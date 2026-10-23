import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * One credential transition moves the identity of the slot once: each move retires the media lanes of the old identity, so a
 * transition that moved it twice would retire the lanes of an identity it had just made. A retired lane closes its pool once,
 * so the count is the pools closed by the transition.
 */

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
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

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const CURRENT_DC: number = 2;
const GET_FILE: string = 'upload.getFile';
const SESSION_TOKEN: string = 'access-jwt-stored';
const REFRESH_TOKEN: string = 'refresh-token-stored';
const PENDING_TOKEN: string = 'pending-token-stored';

function withMediaOption(): FleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
    ]
  };
}

function retiredMediaLanes(): number {
  return fleetHarness.pools.reduce((closed: number, pool): number => closed + pool.close.mock.calls.length, 0);
}

beforeEach(() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
});

describe('a restore moves the identity of the slot once', () => {
  it('a stored session that still holds a pending challenge retires the media lane of the old identity once', async() => {
    const {callMediaFleet, setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    accountGet.mockResolvedValue(undefined);
    await restoreImpulseSession(ACCOUNT);
    setFleetConfig(ACCOUNT, withMediaOption());
    fleetHarness.respondOnce(GET_FILE, () => ({data: new Uint8Array(0)}));
    await callMediaFleet({accountNumber: ACCOUNT, method: GET_FILE, request: new Uint8Array(0)});
    accountGet.mockResolvedValue({
      userId: 42,
      impulse_session_token: SESSION_TOKEN,
      impulse_refresh_token: REFRESH_TOKEN,
      impulse_pending_token: PENDING_TOKEN
    });

    await restoreImpulseSession(ACCOUNT);

    expect(
      retiredMediaLanes(),
      'the restore is one credential transition: the anonymous media lane retires once, not once for the pending token and again for the session'
    ).toBe(1);
  });
});

describe('a sign-out moves the identity of the slot once', () => {
  it('a sign-out of a slot that still holds a pending challenge retires the media lane of the signed-in identity once', async() => {
    const {callMediaFleet, setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
    accountGet.mockResolvedValue({
      userId: 42,
      impulse_session_token: SESSION_TOKEN,
      impulse_refresh_token: REFRESH_TOKEN,
      impulse_pending_token: PENDING_TOKEN
    });
    await restoreImpulseSession(ACCOUNT);
    setFleetConfig(ACCOUNT, withMediaOption());
    fleetHarness.respondOnce(GET_FILE, () => ({data: new Uint8Array(0)}));
    await callMediaFleet({accountNumber: ACCOUNT, method: GET_FILE, request: new Uint8Array(0)});
    expect(retiredMediaLanes(), 'the media lane of the signed-in identity is still open before the sign-out').toBe(0);

    await clearImpulseSession(ACCOUNT);

    expect(
      retiredMediaLanes(),
      'the sign-out is one credential transition: the session and the pending challenge leave together, and the lane retires once'
    ).toBe(1);
  });
});
