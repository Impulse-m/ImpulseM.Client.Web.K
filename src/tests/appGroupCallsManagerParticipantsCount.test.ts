/*
 * The participants_count a member holds for a video chat once people leave it, the member itself
 * first. The leave's answer and its push carry one change at one version, a member that already
 * left still learns of the later leaves, and a page of participants states the count it was read at
 * (api/group-calls.md:2400-2471; tdesktop data_group_call.cpp:215, :726-743).
 */

import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppGroupCallsManager} from '@appManagers/appGroupCallsManager';
import {GroupCall, GroupCallParticipant, PhoneGroupParticipants, Update, Updates} from '@layer';

const CALL_ID = 'call';
const ACCESS_HASH = 'hash';
const SELF = 42;
const OTHER = 7;
const SELF_SOURCE = 4242;
const OTHER_SOURCE = 77;

function activeCall(participantsCount: number, version: number): GroupCall.groupCall {
  return {
    _: 'groupCall',
    pFlags: {},
    id: CALL_ID,
    access_hash: ACCESS_HASH,
    participants_count: participantsCount,
    unmuted_video_limit: 0,
    version
  };
}

function row(userId: number, source: number, pFlags: GroupCallParticipant['pFlags'] = {}): GroupCallParticipant {
  return {
    _: 'groupCallParticipant',
    pFlags,
    peer: {_: 'peerUser', user_id: userId},
    source,
    date: 1
  };
}

function participantsUpdate(version: number, participant: GroupCallParticipant): Update.updateGroupCallParticipants {
  return {
    _: 'updateGroupCallParticipants',
    call: {_: 'inputGroupCall', id: CALL_ID, access_hash: ACCESS_HASH},
    participants: [participant],
    version
  };
}

function page(participants: GroupCallParticipant[], count: number, version: number): PhoneGroupParticipants {
  return {
    _: 'phone.groupParticipants',
    count,
    participants,
    next_offset: '',
    chats: [],
    users: [],
    version
  };
}

/**
 * A manager wired the way the app wires it: an answer's updates and a realtime push both reach
 * the participants handler. `answers` is what each RPC answers, method by method, in order.
 */
function makeManager(answers: Record<string, unknown[]>) {
  const manager = new AppGroupCallsManager();
  const deliver = (update: Update) => {
    if(update._ === 'updateGroupCallParticipants') {
      (manager as any).processGroupCallParticipantsUpdate(update);
    } else if(update._ === 'updateGroupCall') {
      manager.saveGroupCall(update.call);
    }
  };
  const invokeApi = vi.fn(async(method: string) => {
    const queue = answers[method];
    if(!queue?.length) throw new Error(`no answer for ${method}`);
    return queue.shift();
  });

  Object.assign(manager as any, {
    apiManager: {
      invokeApi,
      invokeApiSingleProcess: async({method, processResult}: {method: string, processResult: (result: unknown) => unknown}) => {
        return processResult(await invokeApi(method));
      }
    },
    apiUpdatesManager: {
      processUpdateMessage: (updates: Updates) => {
        (updates as Updates.updates).updates.forEach(deliver);
      }
    },
    appUsersManager: {saveApiUsers: vi.fn()},
    appChatsManager: {saveApiChats: vi.fn()},
    rootScope: {myId: SELF as PeerId, dispatchEvent: vi.fn()},
    cachedStreamChannels: new Map(),
    conferenceRosterFetches: new Map(),
    groupCalls: new Map(),
    nextOffsets: new Map(),
    participantFetchGenerations: new Map(),
    participantVersions: new Map(),
    participants: new Map(),
    participantsResyncs: new Map(),
    log: Object.assign(() => {}, {warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn()})
  });

  return {manager, deliver};
}

function answer(update: Update): Updates.updates {
  return {_: 'updates', updates: [update], users: [], chats: [], date: 0, seq: 0};
}

function count(manager: AppGroupCallsManager): number {
  return (manager.getGroupCall(CALL_ID) as GroupCall.groupCall).participants_count;
}

/** Both in the call at version 5: this account and one other. */
function joinedTogether(answers: Record<string, unknown[]>) {
  const wired = makeManager(answers);
  wired.manager.saveGroupCall(activeCall(2, 5));
  wired.manager.saveApiParticipants(CALL_ID, [row(SELF, SELF_SOURCE, {self: true}), row(OTHER, OTHER_SOURCE)]);
  return wired;
}

describe('AppGroupCallsManager participants_count as members leave', () => {
  it('counts the leaver itself out once, from the leave answer and its push alike', async() => {
    const ownLeft = row(SELF, SELF_SOURCE, {self: true, left: true, versioned: true});
    const {manager, deliver} = joinedTogether({'phone.leaveGroupCall': [answer(participantsUpdate(6, ownLeft))]});

    await manager.leaveGroupCall({_: 'inputGroupCall', id: CALL_ID, access_hash: ACCESS_HASH}, SELF_SOURCE);
    expect(count(manager), 'the answer to phone.leaveGroupCall removes this account from the call').toBe(1);

    deliver(participantsUpdate(6, {...ownLeft, pFlags: {...ownLeft.pFlags}}));
    expect(count(manager), 'the push of the same leave at the same version is the same change, not a second one').toBe(1);
  });

  it('counts a later leave down for a member that already left the call', async() => {
    const ownLeft = row(SELF, SELF_SOURCE, {self: true, left: true, versioned: true});
    const {manager, deliver} = joinedTogether({'phone.leaveGroupCall': [answer(participantsUpdate(6, ownLeft))]});
    await manager.leaveGroupCall({_: 'inputGroupCall', id: CALL_ID, access_hash: ACCESS_HASH}, SELF_SOURCE);

    deliver(participantsUpdate(7, row(OTHER, OTHER_SOURCE, {left: true, versioned: true, min: true})));

    expect(count(manager), 'nobody is left in the call once the other participant leaves too').toBe(0);
    expect(manager.getCachedParticipants(CALL_ID).size).toBe(0);
  });

  it('takes the participant count a page of participants states', async() => {
    const {manager} = joinedTogether({'phone.getGroupParticipants': [page([row(OTHER, OTHER_SOURCE)], 1, 6)]});
    (manager as any).participants.delete(CALL_ID);

    await manager.getGroupCallParticipants(CALL_ID);

    expect(count(manager), 'phone.groupParticipants.count is the number of participants at the page version').toBe(1);
  });

  it('ends at the server state when the last leave is pushed before a page read ahead of it', async() => {
    const {manager, deliver} = joinedTogether({
      'phone.getGroupParticipants': [page([row(OTHER, OTHER_SOURCE)], 1, 6), page([], 0, 7)]
    });
    (manager as any).participantVersions.set(CALL_ID, 6);
    (manager.getGroupCall(CALL_ID) as GroupCall.groupCall).participants_count = 1;
    (manager as any).participants.delete(CALL_ID);

    const reading = manager.getGroupCallParticipants(CALL_ID);
    deliver(participantsUpdate(7, row(OTHER, OTHER_SOURCE, {left: true, versioned: true, min: true})));
    await reading;
    await (manager as any).participantsResyncs.get(CALL_ID);

    expect(count(manager), 'the call is empty at version 7').toBe(0);
    expect([...manager.getCachedParticipants(CALL_ID).keys()], 'the page read at version 6 lists a participant who left at 7').toEqual([]);
  });
});
