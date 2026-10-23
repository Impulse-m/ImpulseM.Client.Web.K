import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * A teardown failure is the caller's failure: the socket of a stopped slot that cannot close is rethrown, not logged.
 */

const socketHarness = sharedUpdateSocketHarness();
const ACCOUNT: ActiveAccountNumber = 1;
const USER_ID: string = '42';
const CLOSE_FAILURE: Error = new Error('socket close failed');

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  await registerSessionIdentitySource();
});

describe('a socket that cannot close fails the teardown of its slot', () => {
  it('stopImpulseRealtime rethrows the close failure of the socket it retires', async() => {
    const {startImpulseRealtime, stopImpulseRealtime} = await import('@lib/impulse/realtime');
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;
    socket.disconnect = (): void => {
      throw CLOSE_FAILURE;
    };

    expect(
      () => stopImpulseRealtime(ACCOUNT),
      'a socket that fails to close is a teardown failure for the caller, not a line in the log'
    ).toThrow(CLOSE_FAILURE);
  });
});
