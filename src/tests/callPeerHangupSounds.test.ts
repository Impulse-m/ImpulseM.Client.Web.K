/*
 * What a 1:1 call does and plays when the peer's side goes away, on the path the user hears it: the real
 * CallsController (its sounds), the real CallInstance and PhoneCallSession, a scripted LiveKit transport.
 *
 * The peer leaving the room is not our reconnect: it plays nothing and shows nothing; the server's
 * phoneCallDiscarded (or the packet timeout) ends the call. Only OUR transport reconnecting plays the loop.
 * A deleted room is the end of the call here and now.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  appSettings: {callDevices: {speakerId: ''}},
  assertE2eeSupported: vi.fn(),
  getUserStream: vi.fn(),
  invokeCrypto: vi.fn(),
  sharedAsset: {play: vi.fn(), playIfDifferent: vi.fn(), stop: vi.fn()},
  rootScope: {myId: 77, addEventListener: vi.fn(), dispatchEvent: vi.fn()}
}));

vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@components/toast', () => ({toastNew: vi.fn()}));
vi.mock('@components/call/getAudioAsset', () => ({
  default: () => mocks.sharedAsset,
  CALL_AUDIO_ASSETS: {incoming: 'call_incoming.mp3'}
}));
vi.mock('@config/debug', () => ({default: false, MOUNT_CLASS_TO: undefined}));
vi.mock('@environment/callSupport', () => ({default: true}));
vi.mock('@environment/conferenceCallSupport', () => ({default: true}));
vi.mock('@lib/calls/callTransitionCoordinator', () => ({
  default: {run: vi.fn((callback: () => Promise<void>) => callback())}
}));
vi.mock('@lib/calls/groupCallsController', () => ({default: {groupCall: undefined, joinConference: vi.fn()}}));
vi.mock('@lib/calls/rtmpCallsController', () => ({default: {currentCall: undefined}}));
vi.mock('@lib/rootScope', () => ({default: mocks.rootScope}));
vi.mock('@lib/calls/helpers/getAudioConstraints', () => ({default: () => ({})}));
vi.mock('@lib/calls/helpers/getStream', () => ({default: vi.fn()}));
vi.mock('@lib/calls/helpers/getUserStream', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/calls/helpers/getUserStream')>();
  return {...actual, getUserStream: mocks.getUserStream};
});
vi.mock('@lib/calls/helpers/getStreamCached', () => ({default: () => vi.fn()}));
vi.mock('@lib/calls/helpers/stopTrack', () => ({default: (track: {stop: () => void}) => track.stop()}));
vi.mock('@lib/calls/localConferenceDescription', () => ({default: class LocalConferenceDescription {}}));
vi.mock('@lib/calls/streamManager', () => ({default: class StreamManager {
  public stop(): void {}
}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {invokeCrypto: mocks.invokeCrypto}}));
vi.mock('@stores/appSettings', () => ({appSettings: mocks.appSettings}));
vi.mock('@lib/calls/livekit/liveKitTransport', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');
  return {default: FakePhoneCallTransport, assertLiveKitE2eeSupported: mocks.assertE2eeSupported};
});

import {CallsController} from '@lib/calls/callsController';
import type CallInstance from '@lib/calls/callInstance';
import CALL_STATE from '@lib/calls/callState';
import deferred from './helpers/deferred';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

class FakeMediaStream {
  public readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  public getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }

  public getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  public getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

const PEER_GONE_HANGUP_MS = 12000;
const CONFIG = {call_packet_timeout_ms: PEER_GONE_HANGUP_MS, call_connect_timeout_ms: 30000};
const AUTH_KEY: Uint8Array = new Uint8Array(256).map((_, index) => index % 256);
const CALL_ID = 'call-42';
const LATE_DISCARD_MS = 300;

// LiveKit's own account of why a participant left (DisconnectReason): logged, never acted on
const CLIENT_INITIATED = 1;
const CONNECTION_TIMEOUT = 14;

type Harness = {
  controller: CallsController,
  instance: CallInstance,
  transport: FakePhoneCallTransport,
  discardCall: ReturnType<typeof vi.fn>,
  order: string[]
};

type CallOptions = {discardCall?: ReturnType<typeof vi.fn>, video?: boolean};

/** A call whose key exchange is done: joinCall has started the LiveKit session. */
async function joiningCall(options?: CallOptions): Promise<Omit<Harness, 'transport'>> {
  const order: string[] = [];
  const discardCall = options?.discardCall ?? vi.fn(async() => {
    order.push('discardCall');
  });
  const controller = new CallsController();
  controller.construct({
    appCallsManager: {discardCall},
    apiManager: {getConfig: vi.fn(async() => CONFIG)}
  } as any);
  const instance: CallInstance = (controller as any).createCallInstance({isOutgoing: true, interlocutorUserId: 7 as UserId});
  (instance as any).streamManager.stop = vi.fn();
  instance.setPhoneCall({
    _: 'phoneCall',
    id: CALL_ID,
    pFlags: {video: options?.video || undefined},
    custom_parameters: {_: 'dataJSON', data: JSON.stringify({livekit: {url: 'wss://lk.example', token: 'jwt', room: `p.${CALL_ID}`}})}
  } as any);
  instance.encryptionKey = AUTH_KEY;
  instance.dh = {g_a: new Uint8Array([1])} as any;
  instance.joinCall();
  return {controller, instance, discardCall, order};
}

async function connectedCall(options?: CallOptions): Promise<Harness> {
  const {controller, instance, discardCall, order} = await joiningCall(options);
  await vi.waitFor(() => expect(FakePhoneCallTransport.instances.length).toBe(1));
  const transport: FakePhoneCallTransport = FakePhoneCallTransport.instances[0];
  await vi.waitFor(() => expect(transport.calls).toContain(options?.video ? 'publish:camera' : 'publish:microphone'));
  const disconnect = transport.disconnect.bind(transport);
  transport.disconnect = () => {
    order.push('transport.disconnect');
    disconnect();
  };

  transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
  expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
  mocks.sharedAsset.play.mockClear();
  mocks.sharedAsset.playIfDifferent.mockClear();
  mocks.sharedAsset.stop.mockClear();
  return {controller, instance, transport, discardCall, order};
}

/** A capture track that ends for good when stopped, and records the moment in `order` as `stop:<kind>`. */
function liveTrack(kind: 'audio' | 'video', order: string[]): MediaStreamTrack {
  const track = {
    kind,
    enabled: true,
    muted: false,
    readyState: 'live' as MediaStreamTrackState,
    addEventListener: vi.fn(),
    stop: vi.fn(() => {
      if(track.readyState === 'live') {
        order.push(`stop:${kind}`);
      }

      track.readyState = 'ended';
    })
  };
  return track as unknown as MediaStreamTrack;
}

function plays(): string[] {
  return mocks.sharedAsset.play.mock.calls.map(([asset]) => asset.name);
}

function playsIfDifferent(): string[] {
  return mocks.sharedAsset.playIfDifferent.mock.calls.map(([asset]) => asset.name);
}

function discarded(options: {reason: string, duration?: number, needRating?: boolean}) {
  return {
    _: 'phoneCallDiscarded',
    id: CALL_ID,
    pFlags: {need_rating: options.needRating ? true : undefined},
    reason: {_: options.reason},
    duration: options.duration
  } as any;
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  FakePhoneCallTransport.instances = [];
  mocks.assertE2eeSupported.mockReset().mockResolvedValue(undefined);
  mocks.invokeCrypto.mockReset().mockResolvedValue([]);
  mocks.getUserStream.mockReset().mockImplementation(async(kind: string) => {
    return new FakeMediaStream([{kind: kind === 'audio' ? 'audio' : 'video', enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn()} as any]);
  });
  mocks.sharedAsset.play.mockReset();
  mocks.sharedAsset.playIfDifferent.mockReset();
  mocks.sharedAsset.stop.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the peer leaves the room of a connected 1:1 call', () => {
  it.each([
    ['CLIENT_INITIATED', CLIENT_INITIATED],
    ['CONNECTION_TIMEOUT', CONNECTION_TIMEOUT]
  ])('plays nothing and keeps the state when the peer leaves (%s); the discard then plays the end sound once', async(_name, reason) => {
    const {controller, instance, transport, discardCall} = await connectedCall();

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false, reason} as any);

    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(playsIfDifferent()).toEqual([]);
    expect(plays()).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, LATE_DISCARD_MS));
    await (controller as any).handleCallUpdate(discarded({reason: 'phoneCallDiscardReasonHangup'}));

    expect(plays()).toEqual(['end']);
    expect(playsIfDifferent()).toEqual([]);
    expect(discardCall).not.toHaveBeenCalled();
    expect(instance.discardReason).toEqual({_: 'phoneCallDiscardReasonHangup'});
    expect(transport.disconnectCount).toBe(1);
  });

  it('hangs up with Disconnect exactly once when the peer stays away for the packet timeout, and not before', async() => {
    const {instance, transport, discardCall} = await connectedCall();
    vi.useFakeTimers();

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS - 1);
    expect(discardCall).not.toHaveBeenCalled();
    // it comes back at timeout - 1: nothing, and the timer is spent
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS * 2);
    expect(discardCall).not.toHaveBeenCalled();

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS);
    expect(discardCall).toHaveBeenCalledTimes(1);
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
    expect(instance.connectionState).toBe(CALL_STATE.CLOSED);
  });
});

describe('the room is deleted', () => {
  it('ends the call at once with the end sound, sends no discard, and applies the discard that follows without a second sound', async() => {
    const {controller, instance, transport, discardCall} = await connectedCall();

    transport.emitState('disconnected', 'roomDeleted');
    await vi.waitFor(() => expect(instance.connectionState).toBe(CALL_STATE.CLOSED));
    expect(plays()).toEqual(['end']);
    expect(playsIfDifferent()).toEqual([]);

    await new Promise<void>((resolve) => setTimeout(resolve, LATE_DISCARD_MS));
    await (controller as any).handleCallUpdate(discarded({reason: 'phoneCallDiscardReasonBusy', duration: 5, needRating: true}));

    expect(plays()).toEqual(['end']);
    expect(discardCall).not.toHaveBeenCalled();
    expect(instance.discardReason).toEqual({_: 'phoneCallDiscardReasonBusy'});
    expect((instance as any).call.duration).toBe(5);
    expect((instance as any).call.pFlags.need_rating).toBe(true);
    expect(transport.disconnectCount).toBe(1);
  });
});

describe('a network loss of the room', () => {
  it('hangs up with Disconnect (the server treats the repeat as idempotent)', async() => {
    const {instance, transport, discardCall} = await connectedCall();

    transport.emitState('disconnected', 'network');

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
    expect(instance.connectionState).toBe(CALL_STATE.CLOSED);
  });
});

describe('our own transport reconnects', () => {
  it('plays the connecting loop, and stops it when the transport is back', async() => {
    const {instance, transport} = await connectedCall();

    transport.emitState('reconnecting');
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTING);
    expect(mocks.sharedAsset.playIfDifferent).toHaveBeenCalledWith({name: 'connecting', loop: true});

    mocks.sharedAsset.stop.mockClear();
    transport.emitState('connected');
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(mocks.sharedAsset.stop).toHaveBeenCalled();
  });

  it('keeps the loop quiet about the peer: our reconnect with the peer absent comes back connected', async() => {
    const {instance, transport} = await connectedCall();
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});

    transport.emitState('reconnecting');
    transport.emitState('connected');

    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
  });
});

describe('a local hang-up', () => {
  it('stops our capture at once, sends the discard, and drops the room only after the discard settled', async() => {
    const {instance, transport, order} = await connectedCall();
    const micTrack = (await mocks.getUserStream.mock.results[0].value).getTracks()[0];

    const hangingUp = instance.hangUp('phoneCallDiscardReasonHangup');

    expect(instance.connectionState).toBe(CALL_STATE.CLOSED);
    expect(micTrack.stop).toHaveBeenCalledTimes(1);
    expect(transport.disconnectCount).toBe(0);
    await hangingUp;

    expect(order).toEqual(['discardCall', 'transport.disconnect']);
    expect(plays()).toEqual(['end']);
  });

  it('takes every track it sends off the wire before the end tone plays, while the discard is still pending', async() => {
    const order: string[] = [];
    mocks.getUserStream.mockImplementation(async(kind: string) => new FakeMediaStream([liveTrack(kind === 'audio' ? 'audio' : 'video', order)]));
    const discard = deferred<void>();
    const {instance, transport, discardCall} = await connectedCall({discardCall: vi.fn(() => discard.promise), video: true});
    mocks.sharedAsset.play.mockImplementation(({name}: {name: string}) => {
      order.push(`tone:${name}`);
    });
    const sent: Array<[string, MediaStreamTrack]> = [...transport.published.entries()];
    expect(sent.map(([source]) => source), 'what the call sends before the hang-up').toEqual(['microphone', 'camera']);

    const hangingUp = instance.hangUp('phoneCallDiscardReasonHangup');

    expect(discardCall, 'phone.discardCall is on its way').toHaveBeenCalledTimes(1);
    expect(transport.disconnectCount, 'the room is still up').toBe(0);
    for(const [source, track] of sent) {
      expect.soft(track.readyState, `the ${source} track LiveKit sends has ended`).toBe('ended');
      expect.soft(transport.calls, `the ${source} track is taken off the sender`).toContain(`unpublish:${source}`);
    }
    expect.soft(order, 'the end tone plays only after every capture stopped').toEqual(['stop:audio', 'stop:video', 'tone:end']);

    discard.resolve();
    await hangingUp;
    expect(transport.disconnectCount).toBe(1);
  });

  it('publishes nothing once a hang-up came while the room was still connecting', async() => {
    const order: string[] = [];
    const capture = deferred<FakeMediaStream>();
    mocks.getUserStream.mockImplementation(() => capture.promise);
    const discard = deferred<void>();
    const {instance} = await joiningCall({discardCall: vi.fn(() => discard.promise)});
    await vi.waitFor(() => expect(FakePhoneCallTransport.instances.length).toBe(1));
    const transport: FakePhoneCallTransport = FakePhoneCallTransport.instances[0];
    const connected = deferred<void>();
    transport.hold('connect', connected.promise);
    const micTrack: MediaStreamTrack = liveTrack('audio', order);
    capture.resolve(new FakeMediaStream([micTrack]));
    await vi.waitFor(() => expect(transport.calls).toContain('connect'));

    const hangingUp = instance.hangUp('phoneCallDiscardReasonHangup');
    connected.resolve();
    await vi.waitFor(() => expect(micTrack.readyState).toBe('ended'));

    expect(transport.calls, 'the microphone captured for the call is never published after the hang-up').not.toContain('publish:microphone');
    expect(transport.isPublished('microphone')).toBe(false);

    discard.resolve();
    await hangingUp;
  });

  it('drops the room after 5 seconds when the discard never settles', async() => {
    const never: Promise<void> = new Promise<void>(() => {});
    const {instance, transport, discardCall} = await connectedCall({discardCall: vi.fn(() => never)});
    vi.useFakeTimers();

    const hangingUp = instance.hangUp('phoneCallDiscardReasonHangup');
    await vi.advanceTimersByTimeAsync(4999);
    expect(discardCall).toHaveBeenCalledTimes(1);
    expect(transport.disconnectCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await hangingUp;
    expect(transport.disconnectCount).toBe(1);
  });

  it('drops the room when the discard fails, and still reports the failure', async() => {
    const failure = new Error('rpc down');
    const {instance, transport} = await connectedCall({discardCall: vi.fn(async() => {
      throw failure;
    })});

    await expect(instance.hangUp('phoneCallDiscardReasonHangup')).rejects.toBe(failure);

    expect(transport.disconnectCount).toBe(1);
  });
});
