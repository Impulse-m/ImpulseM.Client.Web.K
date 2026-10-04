import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));

import PhoneCallSession, {
  readPhoneCallTimeouts,
  PhoneCallConnectionState
} from '@lib/calls/livekit/phoneCallSession';
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
}

type FakeTrack = MediaStreamTrack & {stop: ReturnType<typeof vi.fn>};

function track(kind: 'audio' | 'video'): FakeTrack {
  return {kind, enabled: true, muted: false, stop: vi.fn(), addEventListener: vi.fn()} as unknown as FakeTrack;
}

function stream(kind: 'audio' | 'video'): {stream: MediaStream, track: FakeTrack} {
  const fakeTrack: FakeTrack = track(kind);
  return {stream: new FakeMediaStream([fakeTrack]) as unknown as MediaStream, track: fakeTrack};
}

function setup() {
  const transport = new FakePhoneCallTransport();
  const session = new PhoneCallSession({transport, remoteUserId: 7 as UserId, timeouts: TIMEOUTS});
  const states: string[] = [];
  const events: string[] = [];
  session.addEventListener('connectionState', (state: PhoneCallConnectionState, cause?: string) => {
    states.push(cause ? `${state}:${cause}` : state);
  });
  session.addEventListener('peerLost', () => events.push('peerLost'));
  session.addEventListener('ownTrackEnded', (kind) => events.push(`ended:${kind}`));
  return {transport, session, states, events};
}

// distinct on purpose: each timer must run on its own configured value
const PEER_GONE_HANGUP_MS = 7000;
const PEER_JOIN_TIMEOUT_MS = 31000;
const TIMEOUTS = {packetTimeoutMs: PEER_GONE_HANGUP_MS, connectTimeoutMs: PEER_JOIN_TIMEOUT_MS};
const PARAMS = {url: 'wss://lk.example', token: 'jwt', room: 'p.1'};

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeMediaStream);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PhoneCallSession', () => {
  it('connects, then publishes the microphone and the camera in that order', async() => {
    const {session, transport} = setup();
    const audio = stream('audio');
    const video = stream('video');

    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: audio.stream, video: video.stream});

    expect(transport.calls).toEqual(['connect', 'publish:microphone', 'publish:camera']);
    expect(session.getStreams().ownAudio).toBe(audio.stream);
    expect(session.getStreams().ownVideo).toBe(video.stream);
    expect(session.isOwnActive('audio')).toBe(true);
    expect(session.isOwnActive('presentation')).toBe(false);
  });

  it('is connecting until the peer shows up, connected with the peer, and stays connected when it leaves', async() => {
    const {session, transport, states} = setup();
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    expect(states).toEqual([]);

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});

    expect(states).toEqual(['connected']);
    session.close();
  });

  it('ignores a participant that is not the peer', async() => {
    const {session, transport, states} = setup();
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});

    transport.dispatchEvent('remoteParticipant', {identity: 'u8', present: true});

    expect(states).toEqual([]);
    session.close();
  });

  it('reports the failure cause of a transport that dropped, and a deleted room separately', async() => {
    const failed = setup();
    await failed.session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    failed.transport.emitState('disconnected', 'network');
    expect(failed.states).toEqual(['failed:network']);

    const deleted = setup();
    await deleted.session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    deleted.transport.emitState('disconnected', 'roomDeleted');
    expect(deleted.states).toEqual(['roomDeleted:roomDeleted']);

    const rejected = setup();
    await rejected.session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    rejected.transport.emitState('disconnected', 'rejected');
    expect(rejected.states).toEqual(['failed:rejected']);
  });

  it('reports peerLost after the grace period, not before, and not when the peer returns', async() => {
    vi.useFakeTimers();
    const {session, transport, events} = setup();
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    vi.advanceTimersByTime(PEER_GONE_HANGUP_MS - 1);
    expect(events).toEqual([]);
    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: true});
    vi.advanceTimersByTime(PEER_GONE_HANGUP_MS * 2);
    expect(events).toEqual([]);

    transport.dispatchEvent('remoteParticipant', {identity: 'u7', present: false});
    vi.advanceTimersByTime(PEER_GONE_HANGUP_MS);
    expect(events).toEqual(['peerLost']);
  });

  it('reports peerLost when the peer never joins the room', async() => {
    vi.useFakeTimers();
    const {session, events} = setup();
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});

    vi.advanceTimersByTime(PEER_JOIN_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['peerLost']);
  });

  it('mutes the microphone instead of unpublishing it and releases the capture', async() => {
    const {session, transport} = setup();
    const audio = stream('audio');
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: audio.stream});

    await session.setOwnMedia({kind: 'audio', stream: undefined});

    expect(transport.calls.slice(-1)).toEqual(['setMuted:microphone:true']);
    expect(transport.isPublished('microphone')).toBe(true);
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    expect(session.isOwnActive('audio')).toBe(false);
  });

  it('unpublishes the camera and the screen when they are turned off', async() => {
    const {session, transport} = setup();
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    const camera = stream('video');
    const screen = stream('video');
    await session.setOwnMedia({kind: 'video', stream: camera.stream});
    await session.setOwnMedia({kind: 'presentation', stream: screen.stream});

    await session.setOwnMedia({kind: 'video', stream: undefined});
    await session.setOwnMedia({kind: 'presentation', stream: undefined});

    expect(transport.calls.slice(-2)).toEqual(['unpublish:camera', 'unpublish:screen']);
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
    expect(screen.track.stop).toHaveBeenCalledTimes(1);
  });

  it('announces a capture that ended by itself, only while it is still the current one', async() => {
    const {session, events} = setup();
    const audio = stream('audio');
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: audio.stream});

    audio.track.onended?.(new Event('ended'));
    expect(events).toEqual(['ended:audio']);

    const replacement = stream('audio');
    session.adoptOwnStream({kind: 'audio', stream: replacement.stream});
    audio.track.onended?.(new Event('ended'));
    expect(events).toEqual(['ended:audio']);
  });

  it('close is idempotent, releases every capture, and stops a capture handed over afterwards', async() => {
    const {session, transport, states} = setup();
    const audio = stream('audio');
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: audio.stream});

    session.close();
    session.close();

    expect(transport.disconnectCount).toBe(1);
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    expect(session.getStreams().ownAudio).toBeUndefined();

    const late = stream('audio');
    session.adoptOwnStream({kind: 'audio', stream: late.stream});
    expect(late.track.stop).toHaveBeenCalledTimes(1);
    expect(session.getStreams().ownAudio).toBeUndefined();
    expect(states).toEqual([]);
  });

  it('releaseCapture ends and unpublishes everything sent, and a capture whose publishing outlived it as it lands', async() => {
    const {session, transport} = setup();
    const audio = stream('audio');
    await session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: audio.stream});
    const camera = stream('video');
    const published = deferred<void>();
    transport.hold('publish', published.promise);
    const enabling = session.setOwnMedia({kind: 'video', stream: camera.stream});
    await vi.waitFor(() => expect(transport.calls).toContain('publish:camera'));

    session.releaseCapture();
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    expect(transport.calls, 'the microphone is taken off the sender at once').toContain('unpublish:microphone');

    published.resolve();
    await enabling;
    expect(camera.track.stop, 'the camera that landed after the release is ended').toHaveBeenCalledTimes(1);
    expect(transport.calls, 'the camera that landed after the release is taken off the sender').toContain('unpublish:camera');
    await vi.waitFor(() => expect(transport.published.size).toBe(0));
    expect(session.getStreams().ownVideo).toBeUndefined();
  });

  it('refuses to start publishing into a session that was closed while connecting', async() => {
    const {session, transport} = setup();
    let release!: () => void;
    transport.hold('connect', new Promise<void>((resolve) => {
      release = resolve;
    }));

    const starting = session.start({params: PARAMS, e2eeKey: new Uint8Array(32), audio: stream('audio').stream});
    await vi.waitFor(() => expect(transport.calls).toContain('connect'));
    session.close();
    release();

    await expect(starting).rejects.toThrow(/closed while connecting/);
    expect(transport.calls).not.toContain('publish:microphone');
  });
});

describe('readPhoneCallTimeouts', () => {
  it('takes both timeouts from help.getConfig', () => {
    expect(readPhoneCallTimeouts({call_packet_timeout_ms: 10000, call_connect_timeout_ms: 30000})).toEqual({
      packetTimeoutMs: 10000,
      connectTimeoutMs: 30000
    });
  });

  it.each([
    [{}],
    [{call_packet_timeout_ms: 10000}],
    [{call_connect_timeout_ms: 30000}],
    [{call_packet_timeout_ms: 0, call_connect_timeout_ms: 30000}],
    [{call_packet_timeout_ms: 10000, call_connect_timeout_ms: -1}],
    [undefined]
  ])('refuses a config without usable timeouts instead of reading them as zero: %j', (config) => {
    expect(() => readPhoneCallTimeouts(config as any)).toThrow(/call_packet_timeout_ms/);
  });
});
