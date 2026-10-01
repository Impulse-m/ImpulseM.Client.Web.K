import {beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import type {Dialog, User} from '@layer';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn()
}));

vi.mock('@lib/apiManagerProxy', () => ({
  default: {
    getUser: mocks.getUser
  }
}));

// only the DOM-fragment branch of getPeerTitle uses it; this test reads the plain-text title
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({
  default: (text: string) => text
}));

import {AppUsersManager} from '@appManagers/appUsersManager';
import DialogsStorage from '@lib/storages/dialogs';
import getPeerTitle from '@components/wrappers/getPeerTitle';
import I18n from '@lib/langPack';
import lang from '@/lang';

/**
 * The owner's dialog with user 91485156409344, whose account had been deleted, vanished on
 * 2026-10-01: messages.getDialogs refused to name it because the server could not hydrate the
 * peer at all. Canon keeps a deleted account as a user carrying the deleted flag
 * (constructor/user.md:95-99), and the server now sends it as user{id, access_hash, deleted}.
 *
 * The first case pins the contract the client consumes: given that shape, the dialog is kept
 * (DialogsStorage.canSaveDialog drops a deleted user's dialog only when it has no server message),
 * the peer renders as tweb's own deleted-account title ('HiddenName'), and it is addressable
 * through the access_hash the server sent. It is green against unchanged client code -- the client
 * already renders exactly what canon sends; the defect was the server never sending it.
 *
 * The second case pins what the client does with the old answer, a dialog whose user is absent
 * from users[]: the title falls back to the same 'HiddenName', but the peer cannot be addressed --
 * there is no user object to take an access_hash from, so building its input peer throws, and with
 * it every action on the dialog (delete, read, open history).
 */

const OWNER_ID = 91166460608512 as UserId;
const DELETED_USER_ID = 91485156409344 as UserId;
const SERVER_ACCESS_HASH = '-4851564093441234';

function makeUsersManager() {
  const users = new AppUsersManager();
  Object.assign(users as any, {
    users: {},
    usernames: {},
    rootScope: {myId: OWNER_ID.toPeerId(false)},
    mirrorUser: () => {},
    checkPremium: () => {},
    setUserToStateIfNeeded: () => {},
    log: Object.assign(() => {}, {error: () => {}, warn: () => {}})
  });
  return users;
}

function makeDialogsStorage(users: AppUsersManager) {
  const storage = new DialogsStorage();
  Object.assign(storage as any, {
    appUsersManager: users,
    appChatsManager: {
      getChat: (): undefined => undefined
    }
  });
  return storage;
}

function makeDialog(userId: UserId, topMessage: number): Dialog.dialog {
  return {
    _: 'dialog',
    pFlags: {},
    peer: {_: 'peerUser', user_id: userId},
    top_message: topMessage,
    read_inbox_max_id: topMessage,
    read_outbox_max_id: 0,
    unread_count: 0,
    unread_mentions_count: 0,
    unread_reactions_count: 0,
    unread_poll_votes_count: 0,
    notify_settings: {_: 'peerNotifySettings', pFlags: {}}
  } as Dialog.dialog;
}

describe('a dialog whose peer is a deleted account', () => {
  let users: AppUsersManager;

  beforeEach(() => {
    users = makeUsersManager();
    mocks.getUser.mockImplementation((id: UserId) => users.getUser(id));
  });

  it('is kept, titled as a deleted account and addressable when the server sends user#deleted', async() => {
    // messages.getDialogs users[] entry, in the shape the server now sends for a deleted account
    const deletedUser = {
      _: 'user',
      id: DELETED_USER_ID,
      access_hash: SERVER_ACCESS_HASH,
      pFlags: {deleted: true}
    } as User.user;
    users.saveApiUsers([deletedUser]);
    const peerId = DELETED_USER_ID.toPeerId(false);
    const dialog = makeDialog(DELETED_USER_ID, 31);

    expect(users.isDeleted(DELETED_USER_ID)).toBe(true);
    expect(makeDialogsStorage(users).canSaveDialog(peerId, dialog)).toBe(true);

    const title = await getPeerTitle({peerId, plainText: true});
    // tweb's own deleted-account label; the test environment loads no language pack, so the
    // rendered value is the key and its English string is pinned from the default pack
    expect(title).toBe(I18n.format('HiddenName', true));
    expect(lang.HiddenName).toBe('Deleted Account');

    expect(users.getUserInputPeer(DELETED_USER_ID)).toEqual({
      _: 'inputPeerUser',
      user_id: DELETED_USER_ID,
      access_hash: SERVER_ACCESS_HASH
    });
  });

  it('cannot be addressed when the server leaves the user out of users[] (the old answer)', async() => {
    const peerId = DELETED_USER_ID.toPeerId(false);
    const dialog = makeDialog(DELETED_USER_ID, 31);

    expect(users.getUser(DELETED_USER_ID)).toBeUndefined();
    // the client does not drop it on its own -- it has no user to tell it the account is deleted
    expect(makeDialogsStorage(users).canSaveDialog(peerId, dialog)).toBe(true);
    // the title falls back to the same deleted-account label...
    expect(await getPeerTitle({peerId, plainText: true})).toBe(I18n.format('HiddenName', true));
    // ...but there is nothing to address the peer with, so every action on the dialog fails
    expect(() => users.getUserInputPeer(DELETED_USER_ID)).toThrow(TypeError);
  });
});
