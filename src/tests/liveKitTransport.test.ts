import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConnectionError,
  ConnectionErrorReason,
  DisconnectReason,
  fakeRemoteParticipant,
  fakeRemotePublication,
  fakeRemoteTrack,
  fakeState,
  FakeRoom,
  resetFakeLiveKit,
  RoomEvent,
  TrackSource,
  VideoQuality
} from '@/tests/helpers/fakeLiveKit';
import LiveKitTransport, {LiveKitTransportState} from '@lib/calls/livekit/liveKitTransport';
import {
  LiveKitConnectError,
  LiveKitE2eeUnsupportedError,
  LiveKitNotPublishedError,
  LiveKitPublishDeniedError
} from '@lib/calls/livekit/liveKitErrors';

vi.mock('livekit-client', () => import('@/tests/helpers/fakeLiveKit').then((module) => module.fakeLiveKitModule));
vi.mock('@lib/calls/livekit/liveKitE2eeWorker', () => ({
  createLiveKitE2eeWorker: () => ({fakeWorker: true})
}));

const PARAMS = {url: 'wss://lk.example', token: 'jwt', room: 'p.1'};

function mediaTrack(kind: 'audio' | 'video' = 'audio'): MediaStreamTrack {
  return {kind} as unknown as MediaStreamTrack;
}

async function connected(autoSubscribe = true): Promise<{transport: LiveKitTransport, room: FakeRoom, states: string[]}> {
  const transport: LiveKitTransport = new LiveKitTransport();
  const states: string[] = [];
  transport.addEventListener('state', (state: LiveKitTransportState, cause?: string) => {
    states.push(cause ? `${state}:${cause}` : state);
  });
  await transport.connect(PARAMS, {autoSubscribe});
  return {transport, room: fakeState.rooms[0], states};
}

describe('LiveKitTransport', () => {
  beforeEach(() => {
    resetFakeLiveKit();
  });

  it('connects with the standard room options and the caller autoSubscribe choice', async() => {
    const {transport, room, states} = await connected(false);
    expect(room.options).toEqual({adaptiveStream: false, dynacast: true, disconnectOnPageLeave: true});
    expect(room.options.e2ee).toBeUndefined();
    expect(room.connectArgs).toEqual([PARAMS.url, PARAMS.token, {autoSubscribe: false}]);
    expect(states).toEqual(['connecting', 'connected']);
    expect(transport.state).toBe('connected');
  });

  it('goes reconnecting and back to connected', async() => {
    const {room, states} = await connected();
    room.emit(RoomEvent.Reconnecting);
    room.emit(RoomEvent.SignalReconnecting);
    room.emit(RoomEvent.Reconnected);
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it.each([
    [DisconnectReason.CLIENT_INITIATED, 'client'],
    [DisconnectReason.ROOM_DELETED, 'roomDeleted'],
    [DisconnectReason.ROOM_CLOSED, 'roomDeleted'],
    [DisconnectReason.PARTICIPANT_REMOVED, 'removed'],
    [DisconnectReason.DUPLICATE_IDENTITY, 'duplicateIdentity'],
    [DisconnectReason.SERVER_SHUTDOWN, 'network'],
    [DisconnectReason.SIGNAL_CLOSE, 'network'],
    [DisconnectReason.STATE_MISMATCH, 'network'],
    [DisconnectReason.UNKNOWN_REASON, 'unknown'],
    [undefined, 'unknown']
  ])('maps disconnect reason %s to cause %s', async(reason, cause) => {
    const {transport, room, states} = await connected();
    room.emit(RoomEvent.Disconnected, reason);
    expect(states[states.length - 1]).toBe(`disconnected:${cause}`);
    expect(transport.disconnectCause).toBe(cause);
    expect(transport.state).toBe('disconnected');
  });

  it('rejects connect with cause rejected when the server refuses the token', async() => {
    fakeState.connectBehavior = async() => {
      throw new ConnectionError('token expired', ConnectionErrorReason.NotAllowed);
    };
    const transport = new LiveKitTransport();
    const states: string[] = [];
    transport.addEventListener('state', (state, cause) => states.push(cause ? `${state}:${cause}` : state));
    const failure = await transport.connect(PARAMS, {autoSubscribe: true}).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LiveKitConnectError);
    expect((failure as LiveKitConnectError).disconnectCause).toBe('rejected');
    expect(states).toEqual(['connecting', 'disconnected:rejected']);
  });

  it('classifies an unreachable server as a network failure', async() => {
    fakeState.connectBehavior = async() => {
      throw new ConnectionError('unreachable', ConnectionErrorReason.ServerUnreachable);
    };
    const failure = await new LiveKitTransport().connect(PARAMS, {autoSubscribe: true}).catch((err: unknown) => err);
    expect((failure as LiveKitConnectError).disconnectCause).toBe('network');
  });

  it('refuses to publish without the permission or for a source outside the grant', async() => {
    const {transport, room} = await connected();
    room.localParticipant.permissions = {canPublish: true, canPublishSources: [2]};
    await expect(transport.publish({source: 'camera', track: mediaTrack('video')})).rejects.toBeInstanceOf(LiveKitPublishDeniedError);
    room.localParticipant.permissions = {canPublish: false, canPublishSources: [2]};
    await expect(transport.publish({source: 'microphone', track: mediaTrack()})).rejects.toBeInstanceOf(LiveKitPublishDeniedError);
    expect(room.published).toHaveLength(0);
  });

  it('treats an empty source list with canPublish as every source', async() => {
    const {transport, room} = await connected();
    room.localParticipant.permissions = {canPublish: true, canPublishSources: []};
    await transport.publish({source: 'screenAudio', track: mediaTrack()});
    expect(room.published).toHaveLength(1);
  });

  it('publishes the caller track, mutes, replaces and unpublishes without stopping the capture', async() => {
    const {transport, room} = await connected();
    const first = mediaTrack();
    const second = mediaTrack();
    await transport.publish({source: 'microphone', track: first});
    expect(room.published[0].mediaTrack).toBe(first);
    expect(room.published[0].source).toBe(TrackSource.Microphone);

    await transport.setMuted({source: 'microphone', muted: true});
    expect(room.published[0].isMuted).toBe(true);
    await transport.setMuted({source: 'microphone', muted: false});
    expect(room.published[0].isMuted).toBe(false);

    await transport.replace({source: 'microphone', track: second});
    expect(room.published[0].track.replaced).toEqual([second]);

    await transport.unpublish('microphone');
    expect(room.unpublished).toEqual([{track: room.published[0].track, stopOnUnpublish: false}]);
    expect(transport.isPublished('microphone')).toBe(false);
  });

  it('publishing an already published source swaps the track instead of publishing twice', async() => {
    const {transport, room} = await connected();
    const next = mediaTrack();
    await transport.publish({source: 'microphone', track: mediaTrack()});
    await transport.publish({source: 'microphone', track: next});
    expect(room.published).toHaveLength(1);
    expect(room.published[0].track.replaced).toEqual([next]);
  });

  it('stops counting a publication the server took away, so it can be published again', async() => {
    const {transport, room} = await connected();
    await transport.publish({source: 'microphone', track: mediaTrack()});
    const publication = room.published[0];

    room.emit(RoomEvent.LocalTrackUnpublished, publication);
    expect(transport.isPublished('microphone')).toBe(false);
    expect(transport.getPublishedTrack('microphone')).toBeUndefined();

    await transport.publish({source: 'microphone', track: mediaTrack()});
    expect(room.published).toHaveLength(2);
    // an event about a publication that is no longer the current one changes nothing
    room.emit(RoomEvent.LocalTrackUnpublished, publication);
    expect(transport.isPublished('microphone')).toBe(true);
  });

  it('refuses mute, replace and unpublish for a source that is not published', async() => {
    const {transport} = await connected();
    await expect(transport.setMuted({source: 'camera', muted: true})).rejects.toBeInstanceOf(LiveKitNotPublishedError);
    await expect(transport.replace({source: 'camera', track: mediaTrack('video')})).rejects.toBeInstanceOf(LiveKitNotPublishedError);
    await expect(transport.unpublish('camera')).rejects.toBeInstanceOf(LiveKitNotPublishedError);
  });

  it('turns subscriptions, mute changes and participant presence into events', async() => {
    const {transport, room} = await connected();
    const events: string[] = [];
    transport.addEventListener('remoteParticipant', (info) => events.push(`participant:${info.identity}:${info.present}`));
    transport.addEventListener('remoteTrack', (info) => events.push(`track:${info.identity}:${info.source}:${info.sid}:${info.muted}`));
    transport.addEventListener('remoteTrackMuted', (info) => events.push(`muted:${info.identity}:${info.source}:${info.muted}`));
    transport.addEventListener('remoteTrackRemoved', (info) => events.push(`removed:${info.identity}:${info.source}:${info.sid}`));

    const peer = fakeRemoteParticipant('u2');
    const publication = fakeRemotePublication({sid: 'TR_1', source: TrackSource.Microphone, muted: true});
    room.emit(RoomEvent.ParticipantConnected, peer);
    room.emit(RoomEvent.TrackSubscribed, fakeRemoteTrack('audio'), publication, peer);
    room.emit(RoomEvent.TrackUnmuted, publication, peer);
    room.emit(RoomEvent.TrackMuted, publication, peer);
    room.emit(RoomEvent.TrackMuted, publication, room.localParticipant);
    room.emit(RoomEvent.TrackUnsubscribed, fakeRemoteTrack('audio'), publication, peer);
    room.emit(RoomEvent.ParticipantDisconnected, peer);

    expect(events).toEqual([
      'participant:u2:true',
      'track:u2:microphone:TR_1:true',
      'muted:u2:microphone:false',
      'muted:u2:microphone:true',
      'removed:u2:microphone:TR_1',
      'participant:u2:false'
    ]);
  });

  it('announces a participant that was already in the room when connect finished', async() => {
    const transport = new LiveKitTransport();
    const seen: string[] = [];
    transport.addEventListener('remoteParticipant', (info) => seen.push(`${info.identity}:${info.present}`));
    fakeState.connectBehavior = async() => {
      fakeState.rooms[0].remoteParticipants.set('u2', fakeRemoteParticipant('u2'));
    };
    await transport.connect(PARAMS, {autoSubscribe: true});
    expect(seen).toEqual(['u2:true']);
  });

  it('unsubscribes at once from a publication of an identity the caller does not want', async() => {
    const transport = new LiveKitTransport();
    await transport.connect(PARAMS, {autoSubscribe: true, shouldSubscribe: (identity: string) => !identity.endsWith('.p')});
    const room = fakeState.rooms[0];
    const own = fakeRemoteParticipant('u1.5.p');
    const other = fakeRemoteParticipant('u2.6');
    const ownScreen = fakeRemotePublication({sid: 'TR_own', source: TrackSource.ScreenShare});
    const otherCamera = fakeRemotePublication({sid: 'TR_cam', source: TrackSource.Camera});

    room.emit(RoomEvent.TrackPublished, ownScreen, own);
    room.emit(RoomEvent.TrackPublished, otherCamera, other);

    expect(ownScreen.subscriptions).toEqual([false]);
    expect(otherCamera.subscriptions).toEqual([]);
  });

  it('also unsubscribes from the publications of a participant that was already in the room', async() => {
    const transport = new LiveKitTransport();
    const existing = fakeRemoteParticipant('u1.5.p');
    const screen = fakeRemotePublication({sid: 'TR_own', source: TrackSource.ScreenShare});
    existing.trackPublications.set('TR_own', screen);
    fakeState.connectBehavior = async() => {
      fakeState.rooms[0].remoteParticipants.set('u1.5.p', existing);
    };

    await transport.connect(PARAMS, {autoSubscribe: true, shouldSubscribe: (identity: string) => !identity.endsWith('.p')});

    expect(screen.subscriptions).toEqual([false]);
  });

  it('reports active speakers by identity', async() => {
    const {transport, room} = await connected();
    const speakers: string[][] = [];
    transport.addEventListener('activeSpeakers', (identities) => speakers.push(identities));
    room.emit(RoomEvent.ActiveSpeakersChanged, [fakeRemoteParticipant('u2'), room.localParticipant]);
    expect(speakers).toEqual([['u2', 'u1']]);
  });

  it('emits a publish permission change for the local participant only', async() => {
    const {transport, room} = await connected();
    const seen: unknown[] = [];
    transport.addEventListener('publishPermission', (permission) => seen.push(permission));
    room.localParticipant.permissions = {canPublish: false, canPublishSources: [2]};
    room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, room.localParticipant);
    room.emit(RoomEvent.ParticipantPermissionsChanged, undefined, {...fakeRemoteParticipant('u2'), permissions: {canPublish: true, canPublishSources: []}});
    expect(seen).toEqual([{canPublish: false, sources: ['microphone']}]);
  });

  it('applies a remote video quality to the matching publication', async() => {
    const {transport, room} = await connected();
    const peer = fakeRemoteParticipant('u2');
    const camera = fakeRemotePublication({sid: 'TR_V', source: TrackSource.Camera});
    const screen = fakeRemotePublication({sid: 'TR_S', source: TrackSource.ScreenShare});
    room.emit(RoomEvent.TrackSubscribed, fakeRemoteTrack('video'), camera, peer);
    room.emit(RoomEvent.TrackSubscribed, fakeRemoteTrack('video'), screen, peer);
    transport.setRemoteVideoQuality({identity: 'u2', source: 'camera', quality: 'high'});
    expect(camera.qualities).toEqual([VideoQuality.HIGH]);
    expect(screen.qualities).toEqual([]);
  });

  it('reports diagnostics with received bytes of subscribed tracks', async() => {
    const {transport, room} = await connected();
    const peer = fakeRemoteParticipant('u2');
    room.emit(RoomEvent.ParticipantConnected, peer);
    room.emit(RoomEvent.TrackSubscribed, fakeRemoteTrack('audio', 4321), fakeRemotePublication({sid: 'TR_A', source: TrackSource.Microphone}), peer);
    const diagnostics = await transport.getDiagnostics();
    expect(diagnostics).toEqual({
      state: 'connected',
      localIdentity: 'u1',
      e2ee: false,
      remoteParticipants: ['u2'],
      remoteTracks: [{identity: 'u2', sid: 'TR_A', source: 'microphone', kind: 'audio', muted: false, bytesReceived: 4321}]
    });
  });

  it('drops every room event after disconnect and disconnects twice safely', async() => {
    const {transport, room, states} = await connected();
    const tracks: unknown[] = [];
    transport.addEventListener('remoteTrack', (info) => tracks.push(info));
    transport.disconnect();
    transport.disconnect();
    room.emit(RoomEvent.Reconnected);
    room.emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN);
    room.emit(RoomEvent.TrackSubscribed, fakeRemoteTrack('audio'), fakeRemotePublication({sid: 'TR_X', source: TrackSource.Microphone}), fakeRemoteParticipant('u2'));
    expect(tracks).toEqual([]);
    expect(states).toEqual(['connecting', 'connected', 'disconnected:client']);
    expect(room.disconnectCalls).toHaveLength(1);
    expect(room.disconnectCalls[0]).toEqual([false]);
    expect(transport.disconnectCause).toBe('client');
  });

  it('refuses media calls on a transport that is not connected', async() => {
    const transport = new LiveKitTransport();
    await expect(transport.publish({source: 'microphone', track: mediaTrack()})).rejects.toThrow(/not connected/);
  });

  describe('end-to-end encryption', () => {
    const KEY: Uint8Array = new Uint8Array(32).map((_, index) => index);

    it('hands the key to the provider and enables encryption before connecting', async() => {
      const order: string[] = [];
      fakeState.connectBehavior = async() => {
        order.push(`connect:e2ee=${fakeState.rooms[0].isE2EEEnabled}:keys=${fakeState.keyProviders[0].keys.length}`);
      };
      const transport = new LiveKitTransport();
      await transport.connect(PARAMS, {autoSubscribe: true, e2eeKey: KEY});
      expect(order).toEqual(['connect:e2ee=true:keys=1']);
      expect(Array.from(new Uint8Array(fakeState.keyProviders[0].keys[0]))).toEqual(Array.from(KEY));
      expect(fakeState.rooms[0].options.e2ee.keyProvider).toBe(fakeState.keyProviders[0]);
      expect(fakeState.rooms[0].options.e2ee.worker).toEqual({fakeWorker: true});
      expect((await transport.getDiagnostics()).e2ee).toBe(true);
    });

    it('passes exactly the key bytes of a view into a larger buffer', async() => {
      const backing = new Uint8Array(64).fill(9);
      backing.set(KEY, 16);
      await new LiveKitTransport().connect(PARAMS, {autoSubscribe: true, e2eeKey: backing.subarray(16, 48)});
      expect(Array.from(new Uint8Array(fakeState.keyProviders[0].keys[0]))).toEqual(Array.from(KEY));
    });

    it('fails with a typed error and never connects when the browser cannot encrypt', async() => {
      fakeState.e2eeSupported = false;
      const transport = new LiveKitTransport();
      const states: string[] = [];
      transport.addEventListener('state', (state) => states.push(state));
      await expect(transport.connect(PARAMS, {autoSubscribe: true, e2eeKey: KEY})).rejects.toBeInstanceOf(LiveKitE2eeUnsupportedError);
      expect(fakeState.rooms).toHaveLength(0);
      expect(states).toEqual(['connecting', 'disconnected']);
    });
  });
});
