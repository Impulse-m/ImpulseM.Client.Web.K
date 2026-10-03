import {describe, expect, test} from 'vitest';
import '@helpers/peerIdPolyfill';
import {Chat, ChannelParticipant, ChatParticipant} from '@layer';
import {
  canEditOwnMemberTag,
  canManageMemberTags,
  getMemberTagAccess,
  supportsMemberTags
} from '@appManagers/utils/chats/memberTagRights';

// api/rank.md:550-563: an admin with manage_ranks may change anyone's tag; everyone else only their own, and only
// where neither the default banned rights nor their own banned rights carry edit_rank.
const ME = 1 as UserId;
const OTHER = 2 as UserId;
const ADMIN_ID = 3 as UserId;

function basicGroup(overrides: Partial<Chat.chat> = {}): Chat.chat {
  return {_: 'chat', id: 10, title: 'g', pFlags: {}, ...overrides} as Chat.chat;
}

function supergroup(overrides: Partial<Chat.channel> = {}): Chat.channel {
  return {_: 'channel', id: 11, title: 's', pFlags: {megagroup: true}, ...overrides} as Chat.channel;
}

const member = (userId: UserId): ChatParticipant => ({_: 'chatParticipant', user_id: userId, inviter_id: 9, date: 0});
const adminParticipant = (userId: UserId, promotedBy: UserId): ChatParticipant => ({
  _: 'chatParticipantAdmin',
  user_id: userId,
  inviter_id: promotedBy,
  date: 0
});
const channelMember = (userId: UserId): ChannelParticipant => ({_: 'channelParticipant', user_id: userId, date: 0});

const banned = (flags: Record<string, true>) => ({_: 'chatBannedRights', until_date: 0, pFlags: flags}) as any;
const adminRights = (flags: Record<string, true>) => ({_: 'chatAdminRights', pFlags: flags}) as any;

function access(chat: Chat, participant: ChatParticipant | ChannelParticipant) {
  return getMemberTagAccess({chat, participant, myId: ME.toPeerId()});
}

describe('which chats carry member tags', () => {
  test('basic groups and supergroups do; channels, left and deactivated groups do not', () => {
    expect(supportsMemberTags(basicGroup())).toBe(true);
    expect(supportsMemberTags(supergroup())).toBe(true);
    expect(supportsMemberTags(supergroup({pFlags: {broadcast: true}}))).toBe(false);
    expect(supportsMemberTags(supergroup({pFlags: {megagroup: true, left: true}}))).toBe(false);
    expect(supportsMemberTags(basicGroup({pFlags: {deactivated: true}}))).toBe(false);
    expect(supportsMemberTags(basicGroup({pFlags: {left: true}}))).toBe(false);
    expect(supportsMemberTags({_: 'community'} as any)).toBe(false);
    expect(supportsMemberTags(undefined)).toBe(false);
  });
});

describe('own tag', () => {
  test('a member may set it while edit_rank is banned neither by default nor for them', () => {
    expect(canEditOwnMemberTag(basicGroup())).toBe(true);
    expect(canEditOwnMemberTag(basicGroup({default_banned_rights: banned({send_stickers: true})}))).toBe(true);
    expect(access(basicGroup(), member(ME))).toBe('self');
  });

  test.each([
    ['the default banned rights', basicGroup({default_banned_rights: banned({edit_rank: true})})],
    ['their own banned rights in a supergroup', supergroup({banned_rights: banned({edit_rank: true})})],
    ['both', supergroup({default_banned_rights: banned({edit_rank: true}), banned_rights: banned({edit_rank: true})})]
  ])('a member may not when edit_rank is banned by %s', (_name, chat) => {
    expect(canEditOwnMemberTag(chat)).toBe(false);
    expect(access(chat, chat._ === 'chat' ? member(ME) : channelMember(ME))).toBeUndefined();
  });

  test('banned rights of one kind do not hide the other: a restriction on them alone still blocks', () => {
    expect(canEditOwnMemberTag(supergroup({default_banned_rights: banned({}), banned_rights: banned({edit_rank: true})}))).toBe(false);
    expect(canEditOwnMemberTag(supergroup({default_banned_rights: banned({edit_rank: true}), banned_rights: banned({})}))).toBe(false);
  });

  test('the creator and any admin set theirs whatever the banned rights say', () => {
    const restricted = banned({edit_rank: true});
    expect(canEditOwnMemberTag(basicGroup({pFlags: {creator: true}, default_banned_rights: restricted}))).toBe(true);
    expect(canEditOwnMemberTag(supergroup({admin_rights: adminRights({delete_messages: true}), default_banned_rights: restricted}))).toBe(true);
  });
});

describe('another member\'s tag', () => {
  test('needs manage_ranks, or the creator', () => {
    expect(canManageMemberTags(basicGroup({pFlags: {creator: true}}))).toBe(true);
    expect(canManageMemberTags(supergroup({admin_rights: adminRights({manage_ranks: true})}))).toBe(true);
    expect(canManageMemberTags(supergroup({admin_rights: adminRights({delete_messages: true})}))).toBe(false);
    expect(canManageMemberTags(basicGroup())).toBe(false);
  });

  test('an admin with manage_ranks edits a plain member, a plain member does not', () => {
    const admin = basicGroup({admin_rights: adminRights({manage_ranks: true})});
    expect(access(admin, member(OTHER))).toBe('other');
    expect(access(basicGroup(), member(OTHER))).toBeUndefined();
    // being allowed to edit their own tag gives nothing over anyone else's
    expect(access(basicGroup({default_banned_rights: banned({})}), member(OTHER))).toBeUndefined();
  });

  test('another admin\'s tag needs the right to edit that admin', () => {
    const admin = supergroup({admin_rights: adminRights({manage_ranks: true})});
    const promotedByMe: ChatParticipant = adminParticipant(ADMIN_ID, ME);
    const promotedBySomeoneElse: ChatParticipant = adminParticipant(ADMIN_ID, OTHER);
    expect(access(admin, promotedByMe)).toBe('other');
    expect(access(admin, promotedBySomeoneElse)).toBeUndefined();
    // the creator edits every admin
    expect(access(supergroup({pFlags: {megagroup: true, creator: true}}), promotedBySomeoneElse)).toBe('other');
  });

  test('a banned or departed participant has no tag to edit', () => {
    const creator = supergroup({pFlags: {megagroup: true, creator: true}});
    expect(access(creator, {_: 'channelParticipantBanned', peer: {_: 'peerUser', user_id: OTHER}, kicked_by: ME, date: 0, pFlags: {left: true}, banned_rights: banned({view_messages: true})} as any)).toBeUndefined();
    expect(access(creator, {_: 'channelParticipantLeft', peer: {_: 'peerUser', user_id: OTHER}} as any)).toBeUndefined();
  });

  test('the own tag wins when both apply, and a restricted manager still manages the others', () => {
    const manager = basicGroup({
      admin_rights: adminRights({manage_ranks: true}),
      default_banned_rights: banned({edit_rank: true})
    });
    expect(access(manager, member(ME))).toBe('self');
    expect(access(manager, member(OTHER))).toBe('other');
  });
});
