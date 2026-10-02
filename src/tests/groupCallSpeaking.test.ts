import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

vi.mock('@lib/calls/livekit/liveKitTransport', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');
  return {default: FakePhoneCallTransport};
});

import GroupCallInstance from '@lib/calls/groupCallInstance';
import rootScope from '@lib/rootScope';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

function makeInstance() {
  const managers: any = {appGroupCallsManager: {}, appCallsManager: {}, apiUpdatesManager: {processUpdateMessage: vi.fn()}};
  const instance = new GroupCallInstance({id: 'speaking' as any, chatId: 0 as any, managers});
  const main = instance.createConnectionInstance({
    streamManager: {inputStream: {getAudioTracks: (): unknown[] => [], getVideoTracks: (): unknown[] => []}, stop: vi.fn()} as any,
    type: 'main',
    options: {type: 'main'}
  });
  const transport = main.transport as unknown as FakePhoneCallTransport;
  const events: Array<{groupCallId: unknown, peerIds: PeerId[]}> = [];
  vi.spyOn(rootScope, 'dispatchEvent').mockImplementation(((name: string, payload: any) => {
    if(name === 'group_call_speaking') events.push(payload);
  }) as any);
  return {instance, transport, events};
}

describe('group call speaking indicators', () => {
  beforeEach(() => {
    FakePhoneCallTransport.instances = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('announces the speaking peers, users and chats alike, ourselves included', () => {
    const {instance, transport, events} = makeInstance();

    transport.dispatchEvent('activeSpeakers', ['u7.100', 'c55.200', 'u42.300']);

    expect(events).toEqual([{groupCallId: 'speaking', peerIds: [7, -55, 42]}]);
    expect(instance.isSpeaking(7 as PeerId)).toBe(true);
    expect(instance.isSpeaking(-55 as PeerId)).toBe(true);
    expect(instance.isSpeaking(8 as PeerId)).toBe(false);
  });

  it('does not count a presentation, nor an identity the server never mints', () => {
    const {instance, transport, events} = makeInstance();

    transport.dispatchEvent('activeSpeakers', ['u7.100.p', 'garbage']);

    expect(events).toEqual([]);
    expect(instance.isSpeaking(7 as PeerId)).toBe(false);
  });

  it('announces only a change of the set, and the whole new set', () => {
    const {transport, events} = makeInstance();

    transport.dispatchEvent('activeSpeakers', ['u7.100']);
    transport.dispatchEvent('activeSpeakers', ['u7.100']);
    transport.dispatchEvent('activeSpeakers', ['u7.100', 'u8.101']);
    transport.dispatchEvent('activeSpeakers', ['u8.101']);
    transport.dispatchEvent('activeSpeakers', []);

    expect(events.map((event) => event.peerIds)).toEqual([[7], [7, 8], [8], []]);
  });

  it('counts a peer once however many of its identities speak', () => {
    const {transport, events} = makeInstance();

    transport.dispatchEvent('activeSpeakers', ['u7.100', 'u7.100.p', 'u7.101']);

    expect(events[0].peerIds).toEqual([7]);
  });

  it('forgets who was speaking when the remote media is reset by a rejoin', () => {
    const {instance, transport, events} = makeInstance();
    transport.dispatchEvent('activeSpeakers', ['u7.100']);

    instance.resetRemoteMedia();

    expect(instance.isSpeaking(7 as PeerId)).toBe(false);
    expect(events[events.length - 1].peerIds).toEqual([]);
    instance.resetRemoteMedia();
    expect(events).toHaveLength(2);
  });

  it('ignores speakers reported by a connection that is no longer the main one', () => {
    const {instance, transport, events} = makeInstance();
    instance.createConnectionInstance({
      streamManager: {inputStream: {getAudioTracks: (): unknown[] => [], getVideoTracks: (): unknown[] => []}, stop: vi.fn()} as any,
      type: 'main',
      options: {type: 'main', rejoin: true}
    });

    transport.dispatchEvent('activeSpeakers', ['u7.100']);

    expect(events).toEqual([]);
  });
});
