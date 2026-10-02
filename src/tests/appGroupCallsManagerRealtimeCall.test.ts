import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

const {setImpulseRealtimeCall} = vi.hoisted(() => ({setImpulseRealtimeCall: vi.fn()}));
vi.mock('@lib/impulse/realtime', () => ({setImpulseRealtimeCall}));

import {AppGroupCallsManager} from '@appManagers/appGroupCallsManager';


function makeManager(isChannel: boolean): AppGroupCallsManager {
  const manager = new AppGroupCallsManager();
  Object.assign(manager as any, {
    appChatsManager: {isChannel: vi.fn(() => isChannel)},
    getAccountNumber: () => 3
  });
  return manager;
}

describe('AppGroupCallsManager.setRealtimeCall', () => {
  it('names the call lane and, for a channel, the channel lane', () => {
    makeManager(true).setRealtimeCall(77 as any, '9001' as any, true);
    expect(setImpulseRealtimeCall).toHaveBeenLastCalledWith(3, {callId: '9001', channelId: 77});
  });

  it('names no channel for a basic group, and never a chat lane', () => {
    makeManager(false).setRealtimeCall(78 as any, '9002' as any, true);
    expect(setImpulseRealtimeCall).toHaveBeenLastCalledWith(3, {callId: '9002', channelId: undefined});
  });

  it('releases the lanes when the call is left', () => {
    makeManager(true).setRealtimeCall(77 as any, '9001' as any, false);
    expect(setImpulseRealtimeCall).toHaveBeenLastCalledWith(3, undefined);
  });
});
