import {AppChatsManager} from '@appManagers/appChatsManager';
import {AppProfileManager} from '@appManagers/appProfileManager';
import {CHAT_LEGACY_ADMIN_RIGHTS} from '@lib/appManagers/utils/chats/constants';
import {ChatFull, ChatParticipant} from '@layer';
import '@helpers/peerIdPolyfill';

// A basic group has its own tag (messages.editChatParticipantRank, ChatParticipant.rank, updateChatParticipantRank:
// api/rank.md). Setting one is not a supergroup-only action, so it must never migrate the group.
const CHAT_ID = 500 as ChatId;
const USER_ID = 7 as UserId;

function makeChats() {
  const invokeApi = vi.fn(async(method: string, _params?: any) => {
    if(method === 'messages.editChatParticipantRank') {
      return {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0};
    }

    return true;
  });
  const processLocalUpdate = vi.fn();
  const migrateChat = vi.fn();
  const manager = Object.assign(Object.create(AppChatsManager.prototype), {
    apiManager: {invokeApi},
    apiUpdatesManager: {processLocalUpdate, processUpdateMessage: vi.fn()},
    appUsersManager: {getUserInput: (id: UserId) => ({_: 'inputUser', user_id: id}), getSelf: () => ({id: 1})},
    appPeersManager: {getInputPeerById: (peerId: PeerId) => ({_: 'inputPeer', peerId})},
    isChannel: () => false,
    isCommunity: () => false,
    migrateChat
  }) as AppChatsManager;
  return {manager, invokeApi, processLocalUpdate, migrateChat};
}

function methods(invokeApi: ReturnType<typeof vi.fn>): string[] {
  return invokeApi.mock.calls.map(([method]) => method as string);
}

describe('basic group admin tags', () => {
  test('a tag on a basic group admin is set with messages.editChatParticipantRank and never migrates the group', async() => {
    const {manager, invokeApi, migrateChat} = makeChats();
    const participant: ChatParticipant = {_: 'chatParticipant', user_id: USER_ID, inviter_id: 1, date: 0};

    const result = await manager.editAdmin(CHAT_ID, participant, {_: 'chatAdminRights', pFlags: {...CHAT_LEGACY_ADMIN_RIGHTS.pFlags}}, 'Dean');

    expect(result).toBe(CHAT_ID);
    expect(migrateChat).not.toHaveBeenCalled();
    expect(methods(invokeApi)).toEqual(['messages.editChatAdmin', 'messages.editChatParticipantRank']);
    expect(invokeApi).toHaveBeenCalledWith('messages.editChatParticipantRank', {
      peer: {_: 'inputPeer', peerId: CHAT_ID.toPeerId(true)},
      participant: {_: 'inputPeer', peerId: USER_ID.toPeerId(false)},
      rank: 'Dean'
    });
  });

  test('changing only the tag of an existing admin sends the tag and not the admin flag', async() => {
    const {manager, invokeApi, migrateChat} = makeChats();
    const participant: ChatParticipant = {_: 'chatParticipantAdmin', user_id: USER_ID, inviter_id: 1, date: 0, rank: 'Old'};

    await manager.editAdmin(CHAT_ID, participant, {_: 'chatAdminRights', pFlags: {...CHAT_LEGACY_ADMIN_RIGHTS.pFlags}}, 'New');

    expect(migrateChat).not.toHaveBeenCalled();
    expect(methods(invokeApi)).toEqual(['messages.editChatParticipantRank']);
  });

  test('an admin without a tag still takes the legacy path alone: no tag call, no migration', async() => {
    const {manager, invokeApi, migrateChat} = makeChats();

    await manager.editAdmin(CHAT_ID, USER_ID.toPeerId(false), {_: 'chatAdminRights', pFlags: {...CHAT_LEGACY_ADMIN_RIGHTS.pFlags}});

    expect(migrateChat).not.toHaveBeenCalled();
    expect(methods(invokeApi)).toEqual(['messages.editChatAdmin']);
  });

  test('rights a basic group cannot express still migrate, and go through channels.editAdmin on the supergroup only', async() => {
    const {manager, invokeApi, migrateChat} = makeChats();
    const supergroupId = 900 as ChatId;
    migrateChat.mockResolvedValue(supergroupId);
    (manager as any).getChannelInput = (id: ChatId) => ({_: 'inputChannel', channel_id: id});
    (manager as any).generateUpdateChannelParticipant = () => ({new_participant: {}});
    (manager as any).onChatUpdatedForce = vi.fn();

    await manager.editAdmin(CHAT_ID, USER_ID.toPeerId(false), {_: 'chatAdminRights', pFlags: {ban_users: true}});

    expect(migrateChat).toHaveBeenCalledTimes(1);
    expect(methods(invokeApi)).toEqual(['channels.editAdmin']);
    expect(invokeApi.mock.calls[0][1].channel).toEqual({_: 'inputChannel', channel_id: supergroupId});
  });
});

describe('updateChatParticipantRank', () => {
  const dispatched = vi.fn();

  function makeProfile(participants: ChatParticipant[]) {
    const chatFull: ChatFull.chatFull = {
      _: 'chatFull',
      id: CHAT_ID,
      participants: {_: 'chatParticipants', chat_id: CHAT_ID, participants, version: 1}
    } as any;
    // the update handlers are arrow fields, so they exist on a constructed instance only
    const manager = new AppProfileManager();
    Object.assign(manager as any, {
      getCachedProfileByPeerId: () => chatFull,
      rootScope: {dispatchEvent: dispatched},
      appPeersManager: {},
      chatsFull: {}
    });
    return {manager, chatFull};
  }

  test('sets the cached rank of that participant and leaves the participants a basic group\'s', () => {
    const member: ChatParticipant = {_: 'chatParticipant', user_id: USER_ID, inviter_id: 1, date: 0};
    const other: ChatParticipant = {_: 'chatParticipant', user_id: 8, inviter_id: 1, date: 0};
    const {manager, chatFull} = makeProfile([member, other]);

    (manager as any).onUpdateChatParticipantRank({_: 'updateChatParticipantRank', chat_id: CHAT_ID, user_id: USER_ID, rank: 'Dean', version: 2});

    const participants = (chatFull.participants as any).participants as ChatParticipant[];
    expect(participants[0].rank).toBe('Dean');
    expect(participants[1].rank).toBeUndefined();
    expect((chatFull.participants as any)._).toBe('chatParticipants');
    expect(chatFull._).toBe('chatFull');
  });

  test('announces the change so an open chat re-renders the headers of that member at once', () => {
    dispatched.mockClear();
    const {manager} = makeProfile([{_: 'chatParticipant', user_id: USER_ID, inviter_id: 1, date: 0}]);

    (manager as any).onUpdateChatParticipantRank({_: 'updateChatParticipantRank', chat_id: CHAT_ID, user_id: USER_ID, rank: 'Dean', version: 2});

    expect(dispatched).toHaveBeenCalledWith('chat_participant_rank', {chatId: CHAT_ID, userId: USER_ID, rank: 'Dean'});
  });

  test('an empty rank clears the tag', () => {
    const {manager, chatFull} = makeProfile([{_: 'chatParticipant', user_id: USER_ID, inviter_id: 1, date: 0, rank: 'Dean'}]);

    (manager as any).onUpdateChatParticipantRank({_: 'updateChatParticipantRank', chat_id: CHAT_ID, user_id: USER_ID, rank: '', version: 3});

    expect(((chatFull.participants as any).participants as ChatParticipant[])[0].rank).toBeUndefined();
  });

  test('the tag survives the participant being promoted or demoted', () => {
    const {manager, chatFull} = makeProfile([{_: 'chatParticipant', user_id: USER_ID, inviter_id: 1, date: 0, rank: 'Dean'}]);
    (manager as any).appUsersManager = {getSelf: () => ({id: 1})};

    (manager as any).onUpdateChatParticipantAdmin({_: 'updateChatParticipantAdmin', chat_id: CHAT_ID, user_id: USER_ID, is_admin: true, version: 4});

    const promoted = ((chatFull.participants as any).participants as ChatParticipant[])[0];
    expect(promoted._).toBe('chatParticipantAdmin');
    expect(promoted.rank).toBe('Dean');
  });
});
