import {FullMid, splitFullMid} from '@appManagers/utils/messages/fullMid';

/**
 * The open chat's answer to updateChatParticipantRank: the member's role/tag map takes the new value (or drops it),
 * and every rendered message of that member is rendered again, so its header shows the change as the update arrives.
 * Returns the bubbles it re-rendered.
 */
export default function applyMemberRankUpdate<Rank, Bubble extends object>(options: {
  ranks: Map<PeerId, Rank>,
  memberPeerId: PeerId,
  rank: Rank | undefined,
  renderedFullMids: FullMid[],
  getFromId: (peerId: PeerId, mid: number) => PeerId | undefined,
  getBubble: (fullMid: FullMid) => Bubble | undefined,
  rerender: (fullMid: FullMid, bubble: Bubble) => void
}): Bubble[] {
  const {ranks, memberPeerId, rank} = options;
  if(rank) {
    ranks.set(memberPeerId, rank);
  } else {
    ranks.delete(memberPeerId);
  }

  const rerendered: Bubble[] = [];
  for(const fullMid of options.renderedFullMids) {
    const {peerId, mid} = splitFullMid(fullMid);
    const bubble: Bubble | undefined = options.getBubble(fullMid);
    if(!bubble || options.getFromId(peerId, mid) !== memberPeerId) {
      continue;
    }

    options.rerender(fullMid, bubble);
    rerendered.push(bubble);
  }

  return rerendered;
}
