import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callPool, setFleetIdentitySource} from '@lib/impulse/fleet/fleet';
import type {FleetIdentity} from '@lib/impulse/fleet/fleet';
import {checkPoolMethod, checkSocketMethod} from '@lib/impulse/grpc/methodClasses';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  return {...actual, RpcPool: pools().RpcPoolStub};
});

const fleetHarness = sharedFleetPoolHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const SESSION_IDENTITY: FleetIdentity = {kind: 'session', key: 'session:fixture', getToken: async(): Promise<string> => 'session-token'};

describe('fleet lanes refuse the methods their identity may not carry', () => {
  beforeEach(() => {
    fleetHarness.reset();
    setFleetIdentitySource(() => SESSION_IDENTITY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([true, false])('refuses a method outside the pool set on the pool lane (DEV=%s)', (dev: boolean) => {
    vi.stubEnv('DEV', dev);
    const call = (): Promise<Uint8Array> => callPool({accountNumber: ACCOUNT, method: 'upload.getFile', request: REQUEST_BYTES});
    if(dev) {
      expect(call).toThrow('pool cannot send upload.getFile');
    } else {
      expect(call).toThrow();
    }
    expect(fleetHarness.calls).toHaveLength(0);
  });

  it('lets the pool carry connectionIdentity and refreshSession', () => {
    expect(() => checkPoolMethod('connectionIdentity')).not.toThrow();
    expect(() => checkPoolMethod('refreshSession')).not.toThrow();
  });

  it('refuses auth.importAuthorization on a session socket and allows it on an identity socket', () => {
    vi.stubEnv('DEV', true);
    expect(() => checkSocketMethod({kind: 'session', method: 'auth.importAuthorization'}))
      .toThrow('session socket cannot send auth.importAuthorization');
    expect(() => checkSocketMethod({kind: 'identity', method: 'auth.importAuthorization'})).not.toThrow();
  });
});
