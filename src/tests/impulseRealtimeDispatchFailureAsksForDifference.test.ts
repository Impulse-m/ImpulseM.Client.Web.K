import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {UpdatesSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * A pushed update the sink cannot take is not dropped: its lane asks for the difference, a channel lane for its own
 * (updates.getChannelDifference), the inbox and the session lanes for the inbox one (.demo/telegram-docs-text/constructor/updatesTooLong.md).
 * The request never re-enters the sink, and no failure of it reaches the SDK's publication handler, which would disconnect the socket.
 */

const socketHarness = sharedUpdateSocketHarness();
const ACCOUNT: ActiveAccountNumber = 1;
const USER_ID: string = '42';
const CHANNEL_ID: number = 42;
const DISPATCH_FAILURE: Error = new Error('sink rejected the update');

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

function pushedUpdatesTooLong(): Uint8Array {
  return toBinary(UpdatesSchema, create(UpdatesSchema, {value: {case: 'updatesTooLong', value: {}}}));
}

function publicationOf(channel: string): {channel: string, data: unknown} {
  return {channel, data: {type: 1, pts: 5, ptsCount: 1, date: 1, data: pushedUpdatesTooLong()}};
}

describe('a decoded update the sink cannot dispatch', () => {
  it('leaves the socket connected and does not re-enter the sink', async() => {
    const {setRealtimeSink, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    setRealtimeSink(ACCOUNT, sink);
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    expect(
      () => socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`)),
      'the publication handler returns normally: a throw here disconnects the socket'
    ).not.toThrow();
    expect(socket.disconnected, 'the socket of the slot stays connected after a failed dispatch').toBe(false);
    expect(sink, 'the recovery is not a second synchronous call into the sink that just failed').toHaveBeenCalledTimes(1);
  });

  it('asks for the difference of the channel whose lane carried it', async() => {
    const {setRealtimeRecovery, setRealtimeSink, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    const recovery = vi.fn();
    setRealtimeSink(ACCOUNT, sink);
    setRealtimeRecovery(ACCOUNT, recovery);
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`));

    expect(
      recovery,
      'a channel:{id} update asks for that channel: updates.getChannelDifference is the channel\'s recovery, not the inbox\'s'
    ).toHaveBeenCalledWith(CHANNEL_ID);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('asks for the inbox difference when the inbox lane carried it', async() => {
    const {setRealtimeRecovery, setRealtimeSink, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    const recovery = vi.fn();
    setRealtimeSink(ACCOUNT, sink);
    setRealtimeRecovery(ACCOUNT, recovery);
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`user:${USER_ID}`));

    expect(
      recovery,
      'an update of the user lane asks for the inbox difference, updates.getDifference'
    ).toHaveBeenCalledWith(undefined);
  });
});
