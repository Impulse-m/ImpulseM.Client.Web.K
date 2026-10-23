import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import '@helpers/peerIdPolyfill';

import App from '@config/app';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {UpdatesSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * The manager's own bring-up wires a failed dispatch of a channel's lane to that channel's difference: the sink the bring-up
 * registers cannot take the update, and the recovery it registers asks updates.getChannelDifference for the channel.
 */

const {accountUpdate, recordedErrors} = vi.hoisted(() => ({
  accountUpdate: vi.fn(),
  recordedErrors: [] as unknown[][]
}));

vi.mock('@lib/accounts/accountController', () => ({
  default: {update: accountUpdate}
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
      warn: silent,
      error: (...args: unknown[]): void => {
        recordedErrors.push(args);
      }
    })
  };
});

const socketHarness = sharedUpdateSocketHarness();
const ACCOUNT: ActiveAccountNumber = 1;
const USER_ID: number = 42;
const CHANNEL_ID: number = 42;
const CHANNEL_PTS: number = 7;
const DISPATCH_FAILURE: Error = new Error('sink rejected the update');
const SEED_FAILURE: Error = new Error('dialog cache unreadable');

type BringUpManager = {
  setUserAuth(userAuth: {dcID: number, date: number, id: number}): Promise<void>
};

function makeLog() {
  const makeLogger = () => Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()});
  return Object.assign(makeLogger(), {bindPrefix: makeLogger});
}

function pushedUpdatesTooLong(): Uint8Array {
  return toBinary(UpdatesSchema, create(UpdatesSchema, {value: {case: 'updatesTooLong', value: {}}}));
}

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  accountUpdate.mockReset();
  accountUpdate.mockResolvedValue(undefined);
  recordedErrors.length = 0;
  await registerSessionIdentitySource();
});

async function bringUpSlotWhoseSinkThrows(
  getDialogOnly: () => {pts: number} | undefined,
  invokeApi: ReturnType<typeof vi.fn>
) {
  const {ApiManager} = await import('@appManagers/apiManager');
  const {ApiUpdatesManager} = await import('@appManagers/apiUpdatesManager');
  const dialogsStorage = {getDialogOnly: vi.fn(getDialogOnly)};
  const updates = Object.assign(new ApiUpdatesManager() as any, {
    log: makeLog(),
    apiManager: {invokeApi},
    appChatsManager: {getChannelInput: vi.fn(() => ({_: 'inputChannel', channel_id: CHANNEL_ID, access_hash: 'hash'}))},
    dialogsStorage,
    rootScope: {dispatchEvent: vi.fn()}
  });
  vi.spyOn(updates, 'processUpdateMessage').mockImplementation((): never => {
    throw DISPATCH_FAILURE;
  });
  const manager: BringUpManager = Object.assign(Object.create(ApiManager.prototype), {
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    rootScope: {dispatchEvent: vi.fn()},
    dialogsStorage,
    apiUpdatesManager: updates
  });

  await manager.setUserAuth({dcID: App.baseDcId, date: 1, id: USER_ID});
  const [socket] = socketHarness.sockets;
  socket.emit('publication', {channel: `channel:${CHANNEL_ID}`, data: {type: 1, pts: 5, ptsCount: 1, date: 1, data: pushedUpdatesTooLong()}});
  return socket;
}

describe('the bring-up of a signed-in slot asks for the difference of a channel its sink cannot take', () => {
  it('a channel publication the sink throws on reaches updates.getChannelDifference through the registered recovery', async() => {
    const invokeApi = vi.fn((): Promise<never> => new Promise<never>((): void => {}));
    const socket = await bringUpSlotWhoseSinkThrows((): {pts: number} => ({pts: CHANNEL_PTS}), invokeApi);

    await vi.waitFor((): void => {
      expect(
        invokeApi,
        'the sink of the bring-up cannot take the update, so the registered recovery asks updates.getChannelDifference for the channel'
      ).toHaveBeenCalledWith('updates.getChannelDifference', expect.objectContaining({pts: CHANNEL_PTS}), expect.anything());
    });
    expect(socket.disconnected, 'the failed dispatch leaves the socket of the slot connected').toBe(false);
  });

  it('a dialog cache that throws while the recovery seeds the channel leaves the socket connected, and the failure is recorded', async() => {
    const invokeApi = vi.fn((): Promise<never> => new Promise<never>((): void => {}));
    const socket = await bringUpSlotWhoseSinkThrows((): never => {
      throw SEED_FAILURE;
    }, invokeApi);

    await vi.waitFor((): void => {
      expect(
        recordedErrors.some((args: unknown[]): boolean => args[2] === SEED_FAILURE),
        'a recovery that cannot seed its channel records the failure with its error'
      ).toBe(true);
    });
    expect(socket.disconnected, 'a failed seed leaves the socket of the slot connected').toBe(false);
    expect(invokeApi, 'no difference is asked for a channel the recovery could not seed').not.toHaveBeenCalledWith(
      'updates.getChannelDifference',
      expect.anything(),
      expect.anything()
    );
  });
});
