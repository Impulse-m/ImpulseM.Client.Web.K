import {describe, expect, it} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager} from '@appManagers/appMessagesManager';
import createHistoryStorage from '@appManagers/utils/messages/createHistoryStorage';
import type {Dialog, Update} from '@layer';

/**
 * The owner's dialogs on 2026-10-01 (basic groups 732401, 748901, 401901 and channel 749001) kept
 * an unread badge although every message had been read. The badge is the server's number: the
 * client hands still_unread_count straight to dialog.unread_count, also when the read reaches the
 * dialog's top message, exactly as tdlib takes the server's count over its own
 * (MessagesManager.cpp:12689-12693). So a phantom badge cannot be repaired here; it is repaired by
 * the server answering canonically — nothing above the top is unread — and these tests pin that the
 * canonical answer reaches the badge on both read updates.
 */

type ReadUpdate = Update.updateReadHistoryInbox | Update.updateReadChannelInbox;

function makeManager(peerId: PeerId, dialog: Dialog.dialog) {
  const manager = new AppMessagesManager();
  const historyStorage = createHistoryStorage({type: 'history', peerId});
  historyStorage.readMaxId = dialog.read_inbox_max_id;
  historyStorage._maxId = dialog.top_message;

  Object.assign(manager as any, {
    appMessagesIdsManager: {
      generateMessageId: (id: number) => id
    },
    appPeersManager: {
      getPeerId: () => peerId,
      isBotforum: () => false
    },
    appChatsManager: {
      isForum: () => false,
      isMonoforum: () => false
    },
    appUsersManager: {
      forceUserOnline: () => {}
    },
    dialogsStorage: {
      prepareDialogUnreadCountModifying: () => () => {},
      processDialogForFilters: () => {},
      setDialogToState: () => {},
      getForumTopic: (): undefined => undefined
    },
    rootScope: {
      dispatchEvent: () => {}
    },
    threadsToReplies: {},
    getAccountNumber: () => 1,
    getMonoforumThreadId: (): undefined => undefined,
    getHistoryMessagesStorage: () => new Map(),
    getHistoryStorage: () => historyStorage,
    getDialogOnly: () => dialog,
    getReadMaxIdIfUnread: () => 0,
    reloadConversation: () => {}
  });

  return manager;
}

function applyRead(manager: AppMessagesManager, update: ReadUpdate) {
  (manager as any).onUpdateReadHistory(update);
}

function makeDialog(peer: Dialog.dialog['peer'], topMessage: number, unreadCount: number): Dialog.dialog {
  return {
    _: 'dialog',
    pFlags: {},
    peer,
    top_message: topMessage,
    read_inbox_max_id: 0,
    read_outbox_max_id: 0,
    unread_count: unreadCount,
    unread_mentions_count: 0,
    unread_reactions_count: 0,
    unread_poll_votes_count: 0,
    notify_settings: {_: 'peerNotifySettings', pFlags: {}}
  } as Dialog.dialog;
}

describe('the unread badge after a read is the server\'s still_unread_count', () => {
  it('clears a basic group\'s badge when the server reports nothing above a read to the top', () => {
    const chatId = 732401;
    const peerId = (chatId as ChatId).toPeerId(true);
    const dialog = makeDialog({_: 'peerChat', chat_id: chatId}, 327, 4);
    const manager = makeManager(peerId, dialog);

    applyRead(manager, {
      _: 'updateReadHistoryInbox',
      pFlags: {},
      peer: {_: 'peerChat', chat_id: chatId},
      max_id: 327,
      still_unread_count: 0,
      pts: 10,
      pts_count: 1
    } as Update.updateReadHistoryInbox);

    expect(dialog.read_inbox_max_id).toBe(327);
    expect(dialog.unread_count).toBe(0);
  });

  it('clears a channel\'s badge when the server reports nothing above a read to the channel\'s top', () => {
    const channelId = 749001;
    const peerId = (channelId as ChatId).toPeerId(true);
    const dialog = makeDialog({_: 'peerChannel', channel_id: channelId}, 2, 1);
    const manager = makeManager(peerId, dialog);

    applyRead(manager, {
      _: 'updateReadChannelInbox',
      pFlags: {},
      channel_id: channelId,
      max_id: 2,
      still_unread_count: 0,
      pts: 4
    } as Update.updateReadChannelInbox);

    expect(dialog.read_inbox_max_id).toBe(2);
    expect(dialog.unread_count).toBe(0);
  });

  it('shows whatever count the server sends, even for a read that reaches the top message', () => {
    // the contract the server fix rests on: the client does not second-guess still_unread_count, so
    // the phantom 4 the server used to send for group 732401 is exactly what the owner saw
    const chatId = 732401;
    const peerId = (chatId as ChatId).toPeerId(true);
    const dialog = makeDialog({_: 'peerChat', chat_id: chatId}, 327, 4);
    const manager = makeManager(peerId, dialog);

    applyRead(manager, {
      _: 'updateReadHistoryInbox',
      pFlags: {},
      peer: {_: 'peerChat', chat_id: chatId},
      max_id: 327,
      still_unread_count: 4,
      pts: 10,
      pts_count: 1
    } as Update.updateReadHistoryInbox);

    expect(dialog.unread_count).toBe(4);
  });
});
