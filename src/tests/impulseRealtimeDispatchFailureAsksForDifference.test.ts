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
const RECOVERY_FAILURE: Error = new Error('difference request rejected');

const {recordedErrors, recordedWarnings} = vi.hoisted(() => ({
  recordedErrors: [] as unknown[][],
  recordedWarnings: [] as unknown[][]
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

vi.mock('@lib/impulseLogger', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulseLogger')>();
  const silent = (): void => {};
  return {
    ...actual,
    getLogger: (): ReturnType<typeof actual.getLogger> => ({
      debug: silent,
      info: silent,
      warn: (...args: unknown[]): void => {
        recordedWarnings.push(args);
      },
      error: (...args: unknown[]): void => {
        recordedErrors.push(args);
      }
    })
  };
});

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  recordedErrors.length = 0;
  recordedWarnings.length = 0;
  await registerSessionIdentitySource();
});

function pushedUpdatesTooLong(): Uint8Array {
  return toBinary(UpdatesSchema, create(UpdatesSchema, {value: {case: 'updatesTooLong', value: {}}}));
}

function publicationOf(channel: string): {channel: string, data: unknown} {
  return {channel, data: {type: 1, pts: 5, ptsCount: 1, date: 1, data: pushedUpdatesTooLong()}};
}

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 0);
  });
}

describe('a decoded update the sink cannot dispatch', () => {
  it('leaves the socket connected and does not re-enter the sink', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    setRealtimeDispatch(ACCOUNT, {sink, recovery: vi.fn((): Promise<void> => Promise.resolve())});
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
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    const recovery = vi.fn((): Promise<void> => Promise.resolve());
    setRealtimeDispatch(ACCOUNT, {sink, recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`));

    await vi.waitFor((): void => {
      expect(
        recovery,
        'a channel:{id} update asks for that channel: updates.getChannelDifference is the channel\'s recovery, not the inbox\'s'
      ).toHaveBeenCalledWith(CHANNEL_ID);
    });
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it('asks for the inbox difference when the inbox lane carried it', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn((): void => {
      throw DISPATCH_FAILURE;
    });
    const recovery = vi.fn((): Promise<void> => Promise.resolve());
    setRealtimeDispatch(ACCOUNT, {sink, recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`user:${USER_ID}`));

    await vi.waitFor((): void => {
      expect(
        recovery,
        'an update of the user lane asks for the inbox difference, updates.getDifference'
      ).toHaveBeenCalledWith(undefined);
    });
  });
});

describe('the recovery of a failed dispatch cannot break the socket', () => {
  it('a recovery that throws leaves the socket connected', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = (): void => {
      throw DISPATCH_FAILURE;
    };
    const recovery = (): never => {
      throw RECOVERY_FAILURE;
    };
    setRealtimeDispatch(ACCOUNT, {sink, recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    expect(
      () => socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`)),
      'a recovery that cannot run is a failed recovery, not a throw out of the publication handler'
    ).not.toThrow();
    expect(socket.disconnected, 'the socket of the slot stays connected when the recovery fails').toBe(false);
  });

  it('a failed recovery is recorded as an error with its cause, and the socket stays connected', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = (): void => {
      throw DISPATCH_FAILURE;
    };
    const recovery = (): Promise<void> => Promise.reject(RECOVERY_FAILURE);
    setRealtimeDispatch(ACCOUNT, {sink, recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`));

    await vi.waitFor((): void => {
      expect(
        recordedErrors.some((args: unknown[]): boolean => (
          args[2] === RECOVERY_FAILURE && (args[1] as {channelId?: number} | undefined)?.channelId === CHANNEL_ID
        )),
        'a failed difference request is recorded with the error that failed it and the channel it was asked for'
      ).toBe(true);
    });
    expect(socket.disconnected, 'the socket of the slot stays connected when the difference request fails').toBe(false);
  });
});

describe('an oversize publication asks for the difference of its own lane', () => {
  it('an oversize channel publication asks for that channel and dispatches nothing', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn();
    const recovery = vi.fn((): Promise<void> => Promise.resolve());
    setRealtimeDispatch(ACCOUNT, {sink, recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', {channel: `channel:${CHANNEL_ID}`, data: {oversize: true, type: 500}});

    await vi.waitFor((): void => {
      expect(
        recovery,
        'an oversize channel publication asks for that channel: updates.getChannelDifference is the channel\'s recovery'
      ).toHaveBeenCalledWith(CHANNEL_ID);
    });
    expect(sink, 'an oversize publication is not dispatched: the difference carries it').not.toHaveBeenCalled();
  });
});

describe('the recovery of a publication runs after the publication handler returns', () => {
  it('an oversize publication asks for its difference only once the socket emit has returned', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const recovery = vi.fn((): Promise<void> => Promise.resolve());
    setRealtimeDispatch(ACCOUNT, {sink: vi.fn(), recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', {channel: `user:${USER_ID}`, data: {oversize: true, type: 500}});

    expect(
      recovery,
      'the recovery runs after the publication handler returns: inline, it would reach the updates manager inside the SDK handler'
    ).not.toHaveBeenCalled();
    await vi.waitFor((): void => {
      expect(recovery).toHaveBeenCalledWith(undefined);
    });
  });
});

describe('a channel lane that names no channel', () => {
  it('records a typed error naming the lane, and asks for no difference of any lane', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const recovery = vi.fn((): Promise<void> => Promise.resolve());
    setRealtimeDispatch(ACCOUNT, {sink: vi.fn(), recovery});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', {channel: 'channel:not-a-number', data: {oversize: true, type: 500}});
    await settled();

    expect(
      recovery,
      'a malformed channel lane asks for no difference: the inbox difference would answer for a channel the lane does not name'
    ).not.toHaveBeenCalled();
    expect(
      recordedErrors.some((args: unknown[]): boolean => (
        (args[1] as {channel?: string} | undefined)?.channel === 'channel:not-a-number' &&
        (args[2] as ApiError | undefined)?.type === 'UNKNOWN'
      )),
      'the malformed lane is recorded with a typed error that names the lane'
    ).toBe(true);
  });

  it('dispatches no update of a channel lane it cannot name', async() => {
    const {setRealtimeDispatch, startImpulseRealtime} = await import('@lib/impulse/realtime');
    const sink = vi.fn();
    setRealtimeDispatch(ACCOUNT, {sink, recovery: vi.fn((): Promise<void> => Promise.resolve())});
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf('channel:not-a-number'));
    await settled();

    expect(
      sink,
      'an update of a channel lane that names no channel is not dispatched to the inbox'
    ).not.toHaveBeenCalled();
  });
});

describe('a publication of a slot with no dispatch registered', () => {
  it('is dropped with a warning that names the account and the channel', async() => {
    const {startImpulseRealtime} = await import('@lib/impulse/realtime');
    startImpulseRealtime(USER_ID, ACCOUNT);
    const [socket] = socketHarness.sockets;

    socket.emit('publication', publicationOf(`channel:${CHANNEL_ID}`));

    expect(
      recordedWarnings.some((args: unknown[]): boolean => {
        const payload = args[1] as {accountNumber?: number, channel?: string} | undefined;
        return payload?.accountNumber === ACCOUNT && payload?.channel === `channel:${CHANNEL_ID}`;
      }),
      'a publication with no dispatch to take it is recorded as a warning naming its account and channel'
    ).toBe(true);
  });
});
