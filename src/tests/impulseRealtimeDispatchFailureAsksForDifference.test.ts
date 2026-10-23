import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {UpdatesSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * A pushed update the sink cannot take is not dropped: the client asks for the difference, the same recovery an oversize
 * update takes (.demo/telegram-docs-text/constructor/updatesTooLong.md).
 */

const socketHarness = sharedUpdateSocketHarness();
const ACCOUNT: ActiveAccountNumber = 1;
const USER_ID: string = '42';
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

describe('a decoded update the sink cannot dispatch asks the sink for the difference', () => {
  it('the failed dispatch is followed by updatesTooLong, which makes the manager fetch what the update carried', async() => {
    const {setRealtimeSink, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn().mockImplementationOnce((): void => {
      throw DISPATCH_FAILURE;
    });
    setRealtimeSink(ACCOUNT, sink);
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;
    const pushed: Uint8Array = toBinary(UpdatesSchema, create(UpdatesSchema, {value: {case: 'updatesTooLong', value: {}}}));

    socket.emit('publication', {channel: `user:${USER_ID}`, data: {type: 1, pts: 5, ptsCount: 1, date: 1, data: pushed}});

    expect(
      sink,
      'a dispatch that failed must be followed by the updatesTooLong recovery, not logged and dropped'
    ).toHaveBeenCalledTimes(2);
    expect(
      sink,
      'the recovery is the updatesTooLong the manager answers with a getDifference'
    ).toHaveBeenLastCalledWith({_: 'updatesTooLong'});
  });
});
