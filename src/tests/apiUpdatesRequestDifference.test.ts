import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {AppMessagesManager} from '@appManagers/appMessagesManager';

/*
 * A lane whose pushed update could not be dispatched asks the manager for the difference of that lane: the inbox's through
 * updatesTooLong, a channel's through updates.getChannelDifference from the channel's own pts. A channel the manager holds no
 * pts for takes its dialog first: messages.getPeerDialogs returns the dialog (.demo/telegram-docs-text/method/messages.getPeerDialogs.md:25-31),
 * and the dialog carries its pts (.demo/telegram-docs-text/constructor/dialog.md:21-22).
 */

const CHANNEL_ID: number = 42;
const CHANNEL_PTS: number = 7;
const CHANNEL_PEER: PeerId = CHANNEL_ID.toPeerId(true);

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
 * A manager whose dialog path is the real AppMessagesManager.reloadConversation over stubbed collaborators: its
 * messages.getPeerDialogs answers with `peerDialogs`, and every other request never settles.
 */
function managerWithDialogPath(peerDialogs: unknown) {
  const invokeApi = vi.fn((method: string) => (
    method === 'messages.getPeerDialogs' ? Promise.resolve(peerDialogs) : new Promise<never>(() => {})
  ));
  const messagesStub = {
    log: makeLog(),
    apiManager: {invokeApi},
    apiUpdatesManager: {updatesState: {}},
    appPeersManager: {
      getPeerId: (peerId: PeerId): PeerId => peerId,
      getInputDialogPeerById: (peerId: PeerId) => ({_: 'inputDialogPeer', peer_id: peerId})
    },
    dialogsStorage: {applyDialogs: vi.fn()},
    getChannelAvailableMinIdGeneration: (): number => 0,
    reloadConversationsPeers: new Map<PeerId, unknown>(),
    reloadConversationsPromise: null as Promise<void> | null
  };
  const manager = new ApiUpdatesManager() as any;
  Object.assign(manager, {
    log: makeLog(),
    apiManager: {invokeApi},
    appChatsManager: {
      getChannelInput: vi.fn(() => ({_: 'inputChannel', channel_id: CHANNEL_ID, access_hash: 'hash'}))
    },
    dialogsStorage: {getDialogOnly: vi.fn((): undefined => undefined)},
    appMessagesManager: {
      reloadConversation: (peerId: PeerId) => AppMessagesManager.prototype.reloadConversation.call(
        messagesStub as unknown as AppMessagesManager,
        peerId
      )
    },
    rootScope: {dispatchEvent: vi.fn()}
  });
  return {manager, invokeApi};
}

function settled(): Promise<void> {
  return new Promise<void>((resolve: () => void) => setTimeout(resolve, 0));
}

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
    const {manager, invokeApi} = managerWithDialogPath({
      dialogs: [{_: 'dialog', peerId: CHANNEL_PEER, pts: CHANNEL_PTS}],
      messages: [],
      chats: [],
      users: [],
      state: {}
    });

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

  it('a channel whose dialog carries no pts fails the recovery with a typed error and asks for no difference', async() => {
    const {manager, invokeApi} = managerWithDialogPath({
      dialogs: [],
      messages: [],
      chats: [],
      users: [],
      state: {}
    });

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
});
