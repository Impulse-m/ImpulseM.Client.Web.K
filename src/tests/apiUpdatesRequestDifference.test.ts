import {beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

const {recordedErrors} = vi.hoisted(() => ({recordedErrors: [] as unknown[][]}));

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

/*
 * A lane whose pushed update could not be dispatched asks the manager for the difference of that lane: the inbox's through
 * updatesTooLong, a channel's through updates.getChannelDifference from the channel's own pts. A channel the manager holds no
 * pts for takes its dialog first: messages.getPeerDialogs returns the dialog (.demo/telegram-docs-text/method/messages.getPeerDialogs.md:25-31),
 * and the dialog carries its pts (.demo/telegram-docs-text/constructor/dialog.md:21-22).
 */

const CHANNEL_ID: number = 42;
const CHANNEL_PTS: number = 7;
const STALE_CHANNEL_PTS: number = 5;
const CHANNEL_PEER: PeerId = CHANNEL_ID.toPeerId(true);
const DIALOG_REFUSAL: ApiError = {type: 'CHANNEL_PRIVATE', code: 400};

function makeLog() {
  const makeLogger = () => Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()});
  return Object.assign(makeLogger(), {bindPrefix: makeLogger});
}

function managerWithStubs() {
  const manager = new ApiUpdatesManager() as any;
  const invokeApi = vi.fn(() => new Promise<never>(() => {}));
  Object.assign(manager, {
    log: makeLog(),
    apiManager: {invokeApi},
    appChatsManager: {
      getChannelInput: vi.fn(() => ({_: 'inputChannel', channel_id: CHANNEL_ID, access_hash: 'hash'}))
    },
    rootScope: {dispatchEvent: vi.fn()}
  });
  return {manager, invokeApi};
}

/**
 * A manager whose messages.getPeerDialogs is answered by `dialogRequest`, which receives the messages manager that issued
 * the request, and every other request never settles.
 */
function managerWithDialogPath(dialogRequest: (messages: any) => Promise<unknown>) {
  const manager = new ApiUpdatesManager() as any;
  const messages = new AppMessagesManager() as any;
  const invokeApi = vi.fn((method: string) => (
    method === 'messages.getPeerDialogs' ? dialogRequest(messages) : new Promise<never>(() => {})
  ));
  Object.assign(messages, {
    log: makeLog(),
    apiManager: {invokeApi},
    apiUpdatesManager: manager
  });
  Object.assign(manager, {
    log: makeLog(),
    apiManager: {invokeApi},
    appMessagesManager: messages,
    appChatsManager: {
      getChannelInput: vi.fn(() => ({_: 'inputChannel', channel_id: CHANNEL_ID, access_hash: 'hash'}))
    },
    appPeersManager: {
      getInputDialogPeerById: (peerId: PeerId) => ({_: 'inputDialogPeer', peer_id: peerId})
    },
    dialogsStorage: {getDialogOnly: vi.fn((): undefined => undefined), applyDialogs: vi.fn()},
    rootScope: {dispatchEvent: vi.fn()}
  });
  return {manager, invokeApi};
}

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void) => setTimeout(resolve, 0));
}

beforeEach(() => {
  recordedErrors.length = 0;
});

describe('a recovery request of the inbox lane', () => {
  it('asks the inbox for its difference through updates.getDifference', async() => {
    const {manager, invokeApi} = managerWithStubs();

    manager.requestDifference(undefined);
    await settled();

    expect(
      invokeApi,
      'an inbox recovery is the updatesTooLong answer: a getDifference of the inbox state'
    ).toHaveBeenCalledWith('updates.getDifference', expect.anything(), expect.anything());
  });

  it('runs after the caller returns, so a publication handler never runs the recovery inline', async() => {
    const {manager} = managerWithStubs();
    const processUpdateMessage = vi.spyOn(manager, 'processUpdateMessage');

    manager.requestDifference(undefined);

    expect(
      processUpdateMessage,
      'the caller is the SDK publication handler: processUpdateMessage must not run inside the socket emit'
    ).not.toHaveBeenCalled();
    await settled();
    expect(processUpdateMessage).toHaveBeenCalledWith({_: 'updatesTooLong'});
  });
});

describe('a recovery request of a channel lane', () => {
  it('asks the channel for its own difference from the pts the channel holds', async() => {
    const {manager, invokeApi} = managerWithStubs();
    manager.addChannelState(CHANNEL_ID, CHANNEL_PTS);

    manager.requestDifference(CHANNEL_ID);
    await settled();

    expect(
      invokeApi,
      'a channel recovery asks updates.getChannelDifference for that channel, from its own pts, not the inbox'
    ).toHaveBeenCalledWith('updates.getChannelDifference', expect.objectContaining({pts: CHANNEL_PTS}), expect.anything());
    expect(invokeApi, 'the channel recovery does not ask for the inbox difference').not.toHaveBeenCalledWith(
      'updates.getDifference',
      expect.anything(),
      expect.anything()
    );
  });

  it('an unseeded channel takes its dialog first, then asks for its difference from the dialog pts', async() => {
    const {manager, invokeApi} = managerWithDialogPath(() => Promise.resolve({
      dialogs: [{_: 'dialog', peerId: CHANNEL_PEER, pts: CHANNEL_PTS}],
      messages: [],
      chats: [],
      users: [],
      state: {}
    }));

    manager.requestDifference(CHANNEL_ID);

    await vi.waitFor((): void => {
      expect(
        invokeApi,
        'a channel with no pts takes its dialog: messages.getPeerDialogs, then updates.getChannelDifference from the dialog pts'
      ).toHaveBeenCalledWith('updates.getChannelDifference', expect.objectContaining({pts: CHANNEL_PTS}), expect.anything());
    });
    expect(
      invokeApi.mock.calls.map((call: unknown[]): unknown => call[0]),
      'the dialog is fetched before the difference is asked for'
    ).toEqual(['messages.getPeerDialogs', 'updates.getChannelDifference']);
  });

  it('a channel cutoff that moves while its dialog is in flight fetches the dialog again before seeding its pts', async() => {
    let dialogAnswers: number = 0;
    const {manager, invokeApi} = managerWithDialogPath((messages: any): Promise<unknown> => {
      dialogAnswers++;
      if(dialogAnswers === 1) {
        messages.getChannelAvailableMinIdGeneration = (): string => 'cutoff:moved';
        return Promise.resolve({
          dialogs: [{_: 'dialog', peerId: CHANNEL_PEER, pts: STALE_CHANNEL_PTS}],
          messages: [],
          chats: [],
          users: [],
          state: {}
        });
      }

      return Promise.resolve({
        dialogs: [{_: 'dialog', peerId: CHANNEL_PEER, pts: CHANNEL_PTS}],
        messages: [],
        chats: [],
        users: [],
        state: {}
      });
    });

    manager.requestDifference(CHANNEL_ID);

    await vi.waitFor((): void => {
      expect(
        invokeApi,
        'a cutoff that moved during the dialog request seeds the pts of the dialog fetched after it settled'
      ).toHaveBeenCalledWith('updates.getChannelDifference', expect.objectContaining({pts: CHANNEL_PTS}), expect.anything());
    });
    expect(
      invokeApi.mock.calls.filter((call: unknown[]): boolean => call[0] === 'messages.getPeerDialogs'),
      'the dialog read under a moved cutoff is requested again, not seeded'
    ).toHaveLength(2);
  });

  it('a channel whose dialog carries no pts fails the recovery with a typed error and asks for no difference', async() => {
    const {manager, invokeApi} = managerWithDialogPath(() => Promise.resolve({
      dialogs: [],
      messages: [],
      chats: [],
      users: [],
      state: {}
    }));

    const outcome: unknown = await Promise.resolve()
    .then((): unknown => manager.requestDifference(CHANNEL_ID))
    .then((): undefined => undefined, (error: unknown): unknown => error);

    expect(
      outcome,
      'a channel the dialog path cannot seed rejects the recovery with a typed ApiError, not an unhandled rejection'
    ).toMatchObject({type: 'UNKNOWN'});
    expect(
      invokeApi,
      'the difference of a channel without a pts is never asked for'
    ).not.toHaveBeenCalledWith('updates.getChannelDifference', expect.anything(), expect.anything());
  });

  it('a dialog the server refuses fails the recovery with the server ApiError, not an UNKNOWN', async() => {
    const {manager, invokeApi} = managerWithDialogPath(() => Promise.reject(DIALOG_REFUSAL));

    const outcome: unknown = await Promise.resolve()
    .then((): unknown => manager.requestDifference(CHANNEL_ID))
    .then((): undefined => undefined, (error: unknown): unknown => error);

    expect(
      outcome,
      'a refused dialog request reaches the recovery as the server ApiError: the swallow of reloadConversation must not turn it into UNKNOWN'
    ).toBe(DIALOG_REFUSAL);
    expect(
      invokeApi,
      'no difference is asked for a channel whose dialog could not be read'
    ).not.toHaveBeenCalledWith('updates.getChannelDifference', expect.anything(), expect.anything());
  });
});

describe('a channel update whose dialog the server refuses', () => {
  it('records a refused dialog of the throttled branch with its channel, and leaves no request unhandled', async() => {
    const {manager} = managerWithDialogPath(() => Promise.reject(DIALOG_REFUSAL));
    manager.channelStates = {[CHANNEL_ID]: {pendingPtsUpdates: [], syncPending: null, syncLoading: null}};
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      manager.processUpdateMessage({_: 'updateShort', update: {_: 'updateChannelTooLong', channel_id: CHANNEL_ID}});

      await vi.waitFor((): void => {
        expect(
          recordedErrors.some((args: unknown[]): boolean => (
            args[2] === DIALOG_REFUSAL && (args[1] as {channelId?: number} | undefined)?.channelId === CHANNEL_ID
          )),
          'a failed difference request of the throttled branch is recorded with the error that failed it and its channel'
        ).toBe(true);
      });
      await settled();
      expect(unhandled, 'the throttled branch never leaves its difference request unhandled').toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });
});

describe('a channel update whose channel holds no pts', () => {
  it('records the missing pts of the throttled branch with its channel, and asks for no difference', async() => {
    const {manager, invokeApi} = managerWithDialogPath(() => Promise.resolve({
      dialogs: [],
      messages: [],
      chats: [],
      users: [],
      state: {}
    }));
    manager.channelStates = {[CHANNEL_ID]: {pendingPtsUpdates: [], syncPending: null, syncLoading: null}};
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      manager.processUpdateMessage({_: 'updateShort', update: {_: 'updateChannelTooLong', channel_id: CHANNEL_ID}});

      await vi.waitFor((): void => {
        expect(
          recordedErrors.some((args: unknown[]): boolean => (
            (args[2] as ApiError | undefined)?.type === 'UNKNOWN' && (args[1] as {channelId?: number} | undefined)?.channelId === CHANNEL_ID
          )),
          'a channel whose dialog carries no pts fails the throttled branch with a typed UNKNOWN recorded under its channel'
        ).toBe(true);
      });
      await settled();
      expect(
        invokeApi,
        'the difference of a channel without a pts is never asked for'
      ).not.toHaveBeenCalledWith('updates.getChannelDifference', expect.anything(), expect.anything());
      expect(unhandled, 'the throttled branch never leaves its difference request unhandled').toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });
});
