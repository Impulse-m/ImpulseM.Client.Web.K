import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  appSettings: {callDevices: {speakerId: ''}},
  assertE2eeSupported: vi.fn(),
  getUserStream: vi.fn(),
  invokeCrypto: vi.fn(),
  toastNew: vi.fn()
}));

vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@components/toast', () => ({toastNew: mocks.toastNew}));
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
vi.mock('@lib/calls/callsController', () => ({default: {dispatchEvent: vi.fn()}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {invokeCrypto: mocks.invokeCrypto}}));
vi.mock('@stores/appSettings', () => ({appSettings: mocks.appSettings}));
vi.mock('@lib/calls/livekit/liveKitTransport', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');
  return {default: FakePhoneCallTransport, assertLiveKitE2eeSupported: mocks.assertE2eeSupported};
});

import CallInstance from '@lib/calls/callInstance';
import CALL_STATE from '@lib/calls/callState';
import {LiveKitE2eeUnsupportedError} from '@lib/calls/livekit/liveKitErrors';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';
import deferred from './helpers/deferred';

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

function track(kind: 'audio' | 'video'): MediaStreamTrack & {stop: ReturnType<typeof vi.fn>} {
  return {
    kind,
    enabled: true,
    muted: false,
    stop: vi.fn(),
    addEventListener: vi.fn()
  } as unknown as MediaStreamTrack & {stop: ReturnType<typeof vi.fn>};
}

function mediaError(name: string): Error {
  return Object.assign(new Error(`getUserMedia: ${name}`), {name});
}

function livekitParams(room: string): {_: 'dataJSON', data: string} {
  return {
    _: 'dataJSON',
    data: JSON.stringify({livekit: {url: 'wss://lk.example', token: 'jwt', room}})
  };
}

// what help.getConfig answers; the peer-gone grace must be exactly the packet timeout
const PEER_GONE_HANGUP_MS = 12000;
const CONFIG = {call_packet_timeout_ms: PEER_GONE_HANGUP_MS, call_connect_timeout_ms: 30000};

const AUTH_KEY: Uint8Array = new Uint8Array(256).map((_, index) => index % 256);
// The media key material is the auth key itself, all 256 bytes (see callMediaKey.test.ts)
const AUTH_KEY_MEDIA_KEY_HEX: string = Array.from(AUTH_KEY, (byte: number) => byte.toString(16).padStart(2, '0')).join('');

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
}

function makeInstance(options?: {isOutgoing?: boolean, video?: boolean}) {
  const discardCall = vi.fn().mockResolvedValue(undefined);
  const computeKey = vi.fn().mockResolvedValue({key: AUTH_KEY, key_fingerprint: 'fp'});
  const confirmCall = vi.fn();
  const instance = new CallInstance({
    isOutgoing: options?.isOutgoing ?? true,
    interlocutorUserId: 7 as UserId,
    managers: {appCallsManager: {discardCall, computeKey, confirmCall}, apiManager: {getConfig: vi.fn(async() => CONFIG)}} as any
  });
  instance.id = 'call-42' as any;
  (instance as any).streamManager.stop = vi.fn();
  mocks.invokeCrypto.mockResolvedValue([]);
  return {instance, discardCall, computeKey, confirmCall, video: !!options?.video};
}

function lastTransport(): FakePhoneCallTransport {
  return FakePhoneCallTransport.instances[FakePhoneCallTransport.instances.length - 1];
}

async function joinWith(instance: CallInstance, call: Record<string, unknown>): Promise<FakePhoneCallTransport> {
  instance.setPhoneCall({_: 'phoneCall', id: 'call-42', pFlags: {}, ...call} as any);
  instance.encryptionKey = AUTH_KEY;
  instance.dh = {g_a: new Uint8Array([1])} as any;
  instance.joinCall();
  await vi.waitFor(() => expect(lastTransport()?.calls).toContain('connect'));
  return lastTransport();
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.clearAllMocks();
  FakePhoneCallTransport.instances = [];
  mocks.assertE2eeSupported.mockReset().mockResolvedValue(undefined);
  mocks.getUserStream.mockReset().mockImplementation(async(kind: string) => {
    return new FakeMediaStream([track(kind === 'audio' ? 'audio' : 'video')]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('1:1 call on LiveKit', () => {
  it('connects with the coordinates of the call, the DH auth key as E2EE key material and autoSubscribe', async() => {
    const {instance} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});

    const [params, options] = transport.connectArgs as [any, any];
    expect(params).toMatchObject({url: 'wss://lk.example', token: 'jwt', room: 'p.call-42'});
    expect(options.autoSubscribe).toBe(true);
    expect(hex(options.e2eeKey)).toBe(AUTH_KEY_MEDIA_KEY_HEX);
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    expect(mocks.assertE2eeSupported).toHaveBeenCalledTimes(1);
    instance.cleanup();
  });

  it.each([
    ['no parameters at all', undefined],
    ['parameters without a livekit section', {_: 'dataJSON', data: '{"ssrc":5}'}],
    ['coordinates of another room', livekitParams('p.other')]
  ])('tells the user and ends the call with Disconnect on %s', async(_title, custom_parameters) => {
    const {instance, discardCall} = makeInstance();
    instance.setPhoneCall({_: 'phoneCall', id: 'call-42', pFlags: {}, custom_parameters} as any);
    instance.encryptionKey = AUTH_KEY;
    instance.dh = {g_a: new Uint8Array([1])} as any;

    instance.joinCall();

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Call.LiveKitUnavailable'});
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
    expect(FakePhoneCallTransport.instances).toHaveLength(0);
    expect(mocks.getUserStream).not.toHaveBeenCalled();
  });

  it('fails visibly, before asking for the microphone, when the browser cannot encrypt media', async() => {
    mocks.assertE2eeSupported.mockRejectedValue(new LiveKitE2eeUnsupportedError());
    const {instance, discardCall} = makeInstance();
    instance.setPhoneCall({_: 'phoneCall', id: 'call-42', pFlags: {}, custom_parameters: livekitParams('p.call-42')} as any);
    instance.encryptionKey = AUTH_KEY;
    instance.dh = {g_a: new Uint8Array([1])} as any;

    instance.joinCall();

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'Call.E2eeUnsupported'});
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
    expect(FakePhoneCallTransport.instances).toHaveLength(0);
    expect(mocks.getUserStream).not.toHaveBeenCalled();
  });

  it('takes the coordinates from the confirmCall answer before the call update arrives', async() => {
    const {instance, confirmCall} = makeInstance({isOutgoing: true});
    // the state the caller holds when the callee accepted: no coordinates yet
    instance.setPhoneCall({_: 'phoneCallAccepted', id: 'call-42', g_b: new Uint8Array([5]), pFlags: {}} as any);
    instance.dh = {a: new Uint8Array([1]), g_a: new Uint8Array([2]), p: new Uint8Array([3])} as any;
    confirmCall.mockResolvedValue({
      _: 'phoneCall',
      id: 'call-42',
      pFlags: {},
      custom_parameters: livekitParams('p.call-42')
    });

    await instance.confirmCall();

    await vi.waitFor(() => expect(lastTransport()?.calls).toContain('connect'));
    expect((lastTransport().connectArgs as any[])[0]).toMatchObject({room: 'p.call-42', token: 'jwt'});
    expect(mocks.toastNew).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('starts the camera as well for a video call', async() => {
    const {instance} = makeInstance();
    const transport = await joinWith(instance, {
      pFlags: {video: true},
      custom_parameters: livekitParams('p.call-42')
    });

    await vi.waitFor(() => expect(transport.calls).toContain('publish:camera'));
    expect(transport.calls.indexOf('publish:microphone')).toBeLessThan(transport.calls.indexOf('publish:camera'));
    instance.cleanup();
  });

  it('connects while the microphone prompt is still open, and publishes the microphone only once it is granted', async() => {
    const prompt = deferred<MediaStream>();
    mocks.getUserStream.mockReset().mockReturnValue(prompt.promise);
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(instance.isMuted).toBe(true);
    expect(transport.calls, 'nothing is published while the prompt is open').not.toContain('publish:microphone');

    prompt.resolve(new FakeMediaStream([track('audio')]) as unknown as MediaStream);

    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    await vi.waitFor(() => expect(instance.isMuted).toBe(false));
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(discardCall).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it.each([
    ['NotAllowedError', 'NoMicrophoneAccess'],
    ['NotFoundError', 'CallSettings.MicrophoneUnavailable'],
    ['NotReadableError', 'CallSettings.MicrophoneUnavailable']
  ])('stays in the call, muted, when the microphone is refused with %s', async(errorName, toastKey) => {
    mocks.getUserStream.mockReset().mockRejectedValue(mediaError(errorName));
    const {instance, discardCall} = makeInstance();
    const mutedEvents: boolean[] = [];
    instance.addEventListener('muted', (muted) => mutedEvents.push(muted));
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});

    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: toastKey}));
    expect(mutedEvents).toEqual([true]);
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(instance.isClosing).toBe(false);
    expect(instance.isMuted).toBe(true);
    expect(transport.calls).not.toContain('publish:microphone');
    expect(transport.disconnectCount).toBe(0);
    expect(discardCall).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('keeps a video call with the microphone published when the camera is refused', async() => {
    mocks.getUserStream.mockReset().mockImplementation(async(kind: string) => {
      if(kind === 'video') {
        throw mediaError('NotAllowedError');
      }

      return new FakeMediaStream([track('audio')]);
    });
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {
      pFlags: {video: true},
      custom_parameters: livekitParams('p.call-42')
    });
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});

    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    await vi.waitFor(() => expect(mocks.toastNew).toHaveBeenCalledWith({langPackKey: 'CallSettings.CameraUnavailable'}));
    expect(transport.calls).not.toContain('publish:camera');
    expect(instance.isSharingVideo).toBe(false);
    expect(instance.isMuted).toBe(false);
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(discardCall).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('is connecting until the peer is in the room, then connected', async() => {
    const {instance} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTING);

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    expect(instance.connectedAt).toBeDefined();

    transport.emitState('reconnecting');
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTING);
    transport.emitState('connected');
    expect(instance.connectionState).toBe(CALL_STATE.CONNECTED);
    instance.cleanup();
  });

  it('maps the peer microphone, camera and screen into the remote media state', async() => {
    const {instance} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    expect(instance.getMediaState('output')).toBeUndefined();

    const remote = (source: 'microphone' | 'camera' | 'screen', muted = false) => transport.dispatchEvent('remoteTrack', {
      identity: 'u7',
      sid: `TR_${source}`,
      source,
      track: track(source === 'microphone' ? 'audio' : 'video'),
      muted
    });

    remote('microphone');
    expect(instance.getMediaState('output')).toMatchObject({muted: false, videoState: 'inactive', screencastState: 'inactive'});

    remote('camera');
    remote('screen');
    expect(instance.getMediaState('output')).toMatchObject({muted: false, videoState: 'active', screencastState: 'active'});
    expect(instance.getVideoElement('output')).toBeInstanceOf(HTMLVideoElement);

    transport.dispatchEvent('remoteTrackMuted', {identity: 'u7', source: 'microphone', muted: true});
    transport.dispatchEvent('remoteTrackMuted', {identity: 'u7', source: 'camera', muted: true});
    expect(instance.getMediaState('output')).toMatchObject({muted: true, videoState: 'inactive', screencastState: 'active'});

    transport.dispatchEvent('remoteTrackRemoved', {identity: 'u7', sid: 'TR_screen', source: 'screen'});
    expect(instance.getMediaState('output')).toMatchObject({screencastState: 'inactive'});
    instance.cleanup();
  });

  it('ignores media of any identity other than the peer', async() => {
    const {instance} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});

    transport.dispatchEvent('remoteTrack', {identity: 'u999', sid: 'TR_x', source: 'microphone', track: track('audio'), muted: false});

    expect(instance.getMediaState('output')).toBeUndefined();
    instance.cleanup();
  });

  it('hangs up with Disconnect only after the peer has been gone for the grace period', async() => {
    vi.useFakeTimers();
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS - 1);
    expect(discardCall).not.toHaveBeenCalled();

    // the peer comes back inside the grace period: nothing happens, and the timer is spent
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS * 2);
    expect(discardCall).not.toHaveBeenCalled();

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    await vi.advanceTimersByTimeAsync(PEER_GONE_HANGUP_MS);
    expect(discardCall).toHaveBeenCalledTimes(1);
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
  });

  it('gives up on a peer that never joins after exactly call_connect_timeout_ms from the config', async() => {
    vi.useFakeTimers();
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    // waitFor ticks the fake clock; start the wait from a known instant (a reconnect re-arms the join timer)
    transport.emitState('connected');

    await vi.advanceTimersByTimeAsync(CONFIG.call_connect_timeout_ms - 1);
    expect(discardCall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(discardCall).toHaveBeenCalledTimes(1);
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
  });

  it('ends the call with Disconnect, before any capture, when the config has no call timeouts', async() => {
    const {instance, discardCall} = makeInstance();
    (instance as any).managers.apiManager.getConfig.mockResolvedValue({});
    instance.setPhoneCall({_: 'phoneCall', id: 'call-42', pFlags: {}, custom_parameters: livekitParams('p.call-42')} as any);
    instance.encryptionKey = AUTH_KEY;
    instance.dh = {g_a: new Uint8Array([1])} as any;

    instance.joinCall();

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(mocks.getUserStream).not.toHaveBeenCalled();
    expect(FakePhoneCallTransport.instances).toHaveLength(0);
  });

  it('ends the call with Disconnect when the transport fails for any reason but a room deletion or our own close', async() => {
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));

    transport.emitState('disconnected', 'network');

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(discardCall.mock.calls[0][2]).toEqual({_: 'phoneCallDiscardReasonDisconnect'});
  });

  it('does not send a discard when the server deleted the room', async() => {
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));

    transport.emitState('disconnected', 'roomDeleted');

    await vi.waitFor(() => expect(instance.connectionState).toBe(CALL_STATE.CLOSED));
    expect(discardCall).not.toHaveBeenCalled();
    expect(transport.disconnectCount).toBe(1);
  });

  it('a hangup releases the microphone and the transport once', async() => {
    const {instance, discardCall} = makeInstance();
    const transport = await joinWith(instance, {custom_parameters: livekitParams('p.call-42')});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:microphone'));
    const micTrack = (await mocks.getUserStream.mock.results[0].value).getTracks()[0];

    await instance.hangUp('phoneCallDiscardReasonHangup');
    await instance.hangUp('phoneCallDiscardReasonHangup');

    expect(discardCall).toHaveBeenCalledTimes(1);
    expect(micTrack.stop).toHaveBeenCalledTimes(1);
    expect(transport.disconnectCount).toBe(1);
  });
});
