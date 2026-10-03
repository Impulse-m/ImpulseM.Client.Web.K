import {describe, expect, test, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import applyMemberRankUpdate from '@components/chat/bubbleParts/applyMemberRankUpdate';
import {makeFullMid} from '@appManagers/utils/messages/fullMid';

// updateChatParticipantRank in an open chat: canon updates apply at once, so the headers already on screen change.
const CHAT = (500 as ChatId).toPeerId(true);
const ALICE = (7 as UserId).toPeerId();
const BOB = (8 as UserId).toPeerId();

function setup() {
  const fromIds = new Map<number, PeerId>([[1, ALICE], [2, BOB], [3, ALICE]]);
  const bubbles = new Map<string, {mid: number}>();
  const fullMids = [1, 2, 3].map((mid) => makeFullMid(CHAT, mid));
  fullMids.forEach((fullMid, index) => bubbles.set(fullMid as string, {mid: index + 1}));
  const rerender = vi.fn();
  const run = (ranks: Map<PeerId, string>, rank: string | undefined) => applyMemberRankUpdate({
    ranks,
    memberPeerId: ALICE,
    rank,
    renderedFullMids: fullMids,
    getFromId: (_peerId, mid) => fromIds.get(mid),
    getBubble: (fullMid) => bubbles.get(fullMid as string),
    rerender
  });
  return {run, rerender};
}

describe('applyMemberRankUpdate', () => {
  test('stores the new tag and re-renders only the messages of that member', () => {
    const {run, rerender} = setup();
    const ranks = new Map<PeerId, string>();

    const bubbles = run(ranks, 'Dean');

    expect(ranks.get(ALICE)).toBe('Dean');
    expect(bubbles.map((bubble) => bubble.mid)).toEqual([1, 3]);
    expect(rerender).toHaveBeenCalledTimes(2);
    expect(ranks.has(BOB)).toBe(false);
  });

  test('a cleared tag drops the member from the map and still re-renders their messages', () => {
    const {run, rerender} = setup();
    const ranks = new Map<PeerId, string>([[ALICE, 'Dean'], [BOB, 'Other']]);

    run(ranks, undefined);

    expect(ranks.has(ALICE)).toBe(false);
    expect(ranks.get(BOB)).toBe('Other');
    expect(rerender).toHaveBeenCalledTimes(2);
  });

  test('a message without a rendered bubble is skipped', () => {
    const {run, rerender} = setup();
    const ranks = new Map<PeerId, string>();
    const result = applyMemberRankUpdate({
      ranks,
      memberPeerId: ALICE,
      rank: 'Dean',
      renderedFullMids: [makeFullMid(CHAT, 1)],
      getFromId: () => ALICE,
      getBubble: (): {mid: number} | undefined => undefined,
      rerender
    });
    expect(result).toEqual([]);
    expect(rerender).not.toHaveBeenCalled();
    void run;
  });
});
