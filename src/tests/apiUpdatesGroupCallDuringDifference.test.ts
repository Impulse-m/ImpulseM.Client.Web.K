/*
 * updates.getDifference never carries a group call's participant updates: the call's own version and
 * phone.getGroupCall repair a missed one (api/group-calls.md:2455-2465). tdesktop therefore applies
 * updateGroupCallParticipants and updateGroupCallChainBlocks while a difference is being requested
 * (api_updates.cpp:894-903, 951-970) and holds everything else back.
 */

import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {ApiUpdatesManager} from '@appManagers/apiUpdatesManager';
import {Update} from '@layer';

function makeLog() {
  const makeLogger = () => Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()});
  return Object.assign(makeLogger(), {bindPrefix: makeLogger});
}

function requestingDifference() {
  const manager = new ApiUpdatesManager() as any;
  const dispatchEvent = vi.fn();
  Object.assign(manager, {
    log: makeLog(),
    appUsersManager: {saveApiUsers: vi.fn()},
    appChatsManager: {saveApiChats: vi.fn()},
    dispatchEvent
  });
  manager.updatesState.syncLoading = new Promise<void>(() => {});
  return {manager, dispatchEvent};
}

function deliver(manager: ApiUpdatesManager, update: Update) {
  manager.processUpdateMessage({_: 'updates', updates: [update], users: [], chats: [], date: 0, seq: 0});
}

const call = {_: 'inputGroupCall', id: 'call', access_hash: 'hash'} as const;

describe('updates delivered while a difference is being requested', () => {
  it('applies a group call participant leaving, which no difference will carry', () => {
    const {manager, dispatchEvent} = requestingDifference();
    const left: Update.updateGroupCallParticipants = {
      _: 'updateGroupCallParticipants',
      call,
      participants: [{
        _: 'groupCallParticipant',
        pFlags: {left: true, versioned: true, min: true},
        peer: {_: 'peerUser', user_id: 7},
        source: 77,
        date: 1
      }],
      version: 7
    };

    deliver(manager, left);

    expect(dispatchEvent).toHaveBeenCalledWith('updateGroupCallParticipants', left);
  });

  it('applies a group call chain block', () => {
    const {manager, dispatchEvent} = requestingDifference();
    const blocks: Update.updateGroupCallChainBlocks = {
      _: 'updateGroupCallChainBlocks',
      call,
      sub_chain_id: 0,
      blocks: [new Uint8Array([1])],
      next_offset: 1
    };

    deliver(manager, blocks);

    expect(dispatchEvent).toHaveBeenCalledWith('updateGroupCallChainBlocks', blocks);
  });

  it('still holds back an update the difference will carry', () => {
    const {manager, dispatchEvent} = requestingDifference();

    deliver(manager, {_: 'updateChat', chat_id: 5});

    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
