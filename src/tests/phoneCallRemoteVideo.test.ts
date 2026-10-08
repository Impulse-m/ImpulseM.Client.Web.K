/*
 * The 1:1 window's big view is the `output` video element: the peer's camera, or the peer's screen
 * while one is shared, with the matching media state that makes the window show it.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@lib/calls/helpers/getStream', () => ({default: vi.fn()}));
vi.mock('@lib/calls/helpers/getStreamCached', () => ({default: () => vi.fn()}));
vi.mock('@lib/calls/localConferenceDescription', () => ({default: class LocalConferenceDescription {}}));
vi.mock('@lib/calls/streamManager', () => ({default: class StreamManager {}}));
vi.mock('@lib/calls/callsController', () => ({default: {}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {invokeCrypto: vi.fn()}}));
vi.mock('@stores/appSettings', () => ({appSettings: {callDevices: {speakerId: ''}}}));

import CallInstance from '@lib/calls/callInstance';
import PhoneCallSession from '@lib/calls/livekit/phoneCallSession';
import {formatPhoneCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import type {LiveKitMediaSource} from '@lib/calls/livekit/liveKitTransport';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

const PEER_ID = 7 as UserId;
const STRANGER_ID = 8 as UserId;

class FakeMediaStream {
  public readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  public getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }

  public getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }

  public getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}

function videoTrack(): MediaStreamTrack {
  return {kind: 'video', enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn()} as unknown as MediaStreamTrack;
}

function setup() {
  const transport = new FakePhoneCallTransport();
  const session = new PhoneCallSession({transport, remoteUserId: PEER_ID, timeouts: {packetTimeoutMs: 20000, connectTimeoutMs: 45000}});
  transport.emitState('connected');
  const instance = Object.assign(Object.create(CallInstance.prototype), {
    dispatchEvent: vi.fn(),
    session,
    videoElements: new Map()
  }) as CallInstance;

  const sendRemote = (options: {userId: UserId, source: LiveKitMediaSource, track: MediaStreamTrack}): void => {
    transport.dispatchEvent('remoteTrack', {
      identity: formatPhoneCallIdentity(options.userId),
      sid: `TR_${options.source}`,
      source: options.source,
      track: options.track,
      muted: false
    });
  };

  const removeRemote = (source: LiveKitMediaSource): void => {
    transport.dispatchEvent('remoteTrackRemoved', {identity: formatPhoneCallIdentity(PEER_ID), sid: `TR_${source}`, source});
  };

  const bigViewTrack = (): MediaStreamTrack | undefined => {
    const video = instance.getVideoElement('output') as HTMLVideoElement | undefined;
    return (video?.srcObject as unknown as FakeMediaStream | undefined)?.getVideoTracks()[0];
  };

  return {session, instance, sendRemote, removeRemote, bigViewTrack};
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the 1:1 big view', () => {
  it('shows the peer camera, marked active', () => {
    const {session, sendRemote, bigViewTrack} = setup();
    const camera = videoTrack();

    sendRemote({userId: PEER_ID, source: 'camera', track: camera});

    expect(bigViewTrack()).toBe(camera);
    expect(session.getRemoteMediaState().videoState).toBe('active');
  });

  it('shows the peer screen over the camera while it is shared, and the camera again after', () => {
    const {session, sendRemote, removeRemote, bigViewTrack} = setup();
    const camera = videoTrack();
    const screen = videoTrack();

    sendRemote({userId: PEER_ID, source: 'camera', track: camera});
    sendRemote({userId: PEER_ID, source: 'screen', track: screen});
    expect(bigViewTrack()).toBe(screen);
    expect(session.getRemoteMediaState().screencastState).toBe('active');

    removeRemote('screen');
    expect(bigViewTrack()).toBe(camera);
    expect(session.getRemoteMediaState().screencastState).toBe('inactive');
  });

  it('shows the peer screen with no camera at all', () => {
    const {sendRemote, bigViewTrack} = setup();
    const screen = videoTrack();

    sendRemote({userId: PEER_ID, source: 'screen', track: screen});

    expect(bigViewTrack()).toBe(screen);
  });

  it('never shows a video from anybody but the peer', () => {
    const {instance, sendRemote} = setup();

    sendRemote({userId: STRANGER_ID, source: 'camera', track: videoTrack()});

    expect(instance.getVideoElement('output')).toBeUndefined();
  });
});
