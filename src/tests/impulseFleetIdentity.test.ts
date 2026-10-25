import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {RefreshSessionResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {REFRESH_SESSION_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

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
const SIGNED_IN_TOKEN: string = 'access-token-first';
const REFRESH_TOKEN: string = 'refresh-token-stored';

function refreshedAuthorization(sessionToken: string): Uint8Array {
  return toBinary(RefreshSessionResponseSchema, create(RefreshSessionResponseSchema, {
    sessionToken,
    refreshToken: REFRESH_TOKEN
  }));
}

async function identityOfSlot() {
  const {fleetIdentityFor} = await import('@lib/impulse/session');
  return fleetIdentityFor(ACCOUNT);
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
});

describe('the identity of a signed-in slot', () => {
  beforeEach(async() => {
    const {restoreImpulseSession} = await import('@lib/impulse/session');
    accountGet.mockResolvedValue({userId: 42, impulse_session_token: SIGNED_IN_TOKEN, impulse_refresh_token: REFRESH_TOKEN});
    await restoreImpulseSession(ACCOUNT);
  });

  it('is the session, keyed by its epoch', async() => {
    const identity = await identityOfSlot();

    expect(identity.kind).toBe('session');
    expect(identity.key).toBe('session:1');
  });

  it('is renewed through the refresh, which travels its own anonymous pool and never the update socket', async() => {
    const identity = await identityOfSlot();
    await identity.getToken?.();
    identity.onRefused?.();
    fleetHarness.respond(REFRESH_SESSION_METHOD, () => ({data: refreshedAuthorization('access-token-renewed')}));

    await expect(identity.getToken?.()).resolves.toBe('access-token-renewed');

    expect(fleetHarness.calls.map((call) => call.method), 'the renewal is the one refresh call of the anonymous pool').toEqual([REFRESH_SESSION_METHOD]);
    expect(fleetHarness.pools[0].options.connection.getToken, 'the refresh pool presents no token: it renews one').toBeUndefined();
    expect(socketHarness.calls, 'the refresh does not wait on the update socket it renews').toHaveLength(0);
  });
});
