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
const HELP_GET_CONFIG: string = 'help.getConfig';

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

  it('a failed teardown leaves the slot without its stopped user, so a later socket subscribes none of its lanes', async() => {
    const {callUpdateSocket, startImpulseRealtime, stopImpulseRealtime} = await import('@lib/impulse/realtime');
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [failing] = socketHarness.sockets;
    failing.disconnect = (): void => {
      throw CLOSE_FAILURE;
    };
    expect(() => stopImpulseRealtime(ACCOUNT)).toThrow(CLOSE_FAILURE);
    socketHarness.respondOnce(HELP_GET_CONFIG, (): {data: Uint8Array} => ({data: new Uint8Array(0)}));

    await callUpdateSocket({accountNumber: ACCOUNT, method: HELP_GET_CONFIG, request: new Uint8Array(0)});

    const [, reopened] = socketHarness.sockets;
    expect(
      reopened.subscriptions.map((subscription): string => subscription.channel),
      'the socket a later call opens must not subscribe the lanes of the user the failed teardown stopped'
    ).toEqual([]);
  });
});
