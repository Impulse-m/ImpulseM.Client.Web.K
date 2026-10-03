import {ChannelParticipant, Chat, ChatParticipant} from '@layer';
import canEditAdmin from '@appManagers/utils/chats/canEditAdmin';
import getParticipantPeerId from '@appManagers/utils/chats/getParticipantPeerId';
import {isParticipantAdmin, isParticipantCreator} from '@appManagers/utils/chats/isParticipantAdmin';

/** The longest tag messages.editChatParticipantRank accepts (api/rank.md: "max 16 chars, no emojis"). */
export const MEMBER_TAG_MAX_LENGTH = 16;

export type MemberTagChat = Chat.chat | Chat.channel;

/** Whose tag the account may change: its own, or another member's as an admin with manage_ranks. */
export type MemberTagAccess = 'self' | 'other';

/**
 * Basic groups and supergroups carry member tags; a channel, a community, or a group the account has left does not.
 * tdesktop's SupportsMemberTags, plus the left/deactivated states in which nothing can be edited.
 */
export function supportsMemberTags(chat: Chat | undefined): chat is MemberTagChat {
  if(chat?._ === 'chat') {
    return !chat.pFlags.deactivated && !chat.pFlags.left;
  }

  return chat?._ === 'channel' && !!chat.pFlags.megagroup && !chat.pFlags.broadcast && !chat.pFlags.left;
}

/** Creator or an admin of any rank: admins are never held back by banned rights (tdesktop: `isAdmin || !amRestricted`). */
function isSelfAdmin(chat: MemberTagChat): boolean {
  return !!chat.pFlags.creator || !!chat.admin_rights;
}

/**
 * An admin with the manage_ranks right (or the creator) may set the tag of any member (api/rank.md:550-553).
 */
export function canManageMemberTags(chat: Chat | undefined): boolean {
  return supportsMemberTags(chat) && (!!chat.pFlags.creator || !!chat.admin_rights?.pFlags.manage_ranks);
}

/**
 * Everyone else may set their own tag only when neither the group's default banned rights nor their own banned
 * rights carry edit_rank (api/rank.md:554-563). Both are checked: a member can be restricted individually, and
 * the default rights apply to every member that is not.
 */
export function canEditOwnMemberTag(chat: Chat | undefined): boolean {
  if(!supportsMemberTags(chat)) {
    return false;
  }

  if(isSelfAdmin(chat)) {
    return true;
  }

  return !chat.default_banned_rights?.pFlags.edit_rank && !(chat as Chat.channel).banned_rights?.pFlags.edit_rank;
}

/**
 * What the account may do to the tag of `participant`. The own tag wins when both apply. Changing the tag of
 * another admin needs the right to edit that admin as well, as it does for their rights (tdesktop: canEditAdmin).
 */
export function getMemberTagAccess(options: {
  chat: Chat | undefined,
  participant: ChannelParticipant | ChatParticipant,
  myId: PeerId
}): MemberTagAccess | undefined {
  const {chat, participant, myId} = options;
  if(!supportsMemberTags(chat)) {
    return undefined;
  }

  // only someone who is in the group carries a tag: a banned or departed participant does not
  if(participant._ === 'channelParticipantBanned' || participant._ === 'channelParticipantLeft') {
    return undefined;
  }

  const peerId: PeerId = getParticipantPeerId(participant);
  if(!peerId?.isUser()) {
    return undefined;
  }

  if(peerId === myId) {
    return canEditOwnMemberTag(chat) ? 'self' : undefined;
  }

  if(!canManageMemberTags(chat)) {
    return undefined;
  }

  const targetIsAdmin: boolean = isParticipantAdmin(participant) || isParticipantCreator(participant);
  return !targetIsAdmin || canEditAdmin(chat, participant, myId) ? 'other' : undefined;
}

/** The tag a participant carries now, or '' when it has none. */
export function getMemberTag(participant: ChannelParticipant | ChatParticipant | undefined): string {
  return (participant as ChatParticipant.chatParticipant | undefined)?.rank || '';
}
