/*
 * Another participant's screen share in a group call: the main room subscribes to it (only our own
 * `.p` identity is turned away), the router gives it a video element, and the participants grid shows
 * it as a visible tile. A screen auto-pinned from its participant row before its track arrives must not
 * blank the camera tiles that are already there.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

// jsdom has no IntersectionObserver; the tiles' icons register with the animation intersector on import.
vi.hoisted(() => {
  globalThis.IntersectionObserver ??= class {
    public observe(): void {}
    public unobserve(): void {}
    public disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
});

const lkMocks = vi.hoisted(() => ({
  rooms: [] as Array<{
    publishRemote: (options: {identity: string, source: 'camera' | 'screen', track: MediaStreamTrack}) => Promise<{
      setSubscribed: ReturnType<typeof vi.fn>
    }>
  }>,
  localIdentity: ''
}));

vi.mock('@lib/calls/livekit/loadLiveKit', async() => {
  const lk = await vi.importActual<typeof import('livekit-client')>('livekit-client');

  type Handler = (...args: unknown[]) => void;
  type FakePublication = {
    trackSid: string,
    source: unknown,
    isMuted: boolean,
    isSubscribed: boolean,
    setSubscribed: ReturnType<typeof vi.fn>,
    setVideoQuality: ReturnType<typeof vi.fn>
  };
  type FakeParticipant = {identity: string, isLocal: boolean, trackPublications: Map<string, FakePublication>};

  // The part of a LiveKit Room the transport listens to: a remote publication is announced with
  // TrackPublished and, unless the app turned its subscription off meanwhile, delivered with TrackSubscribed.
  class FakeRoom {
    public localParticipant = {identity: '', isLocal: true, permissions: undefined as unknown};
    public remoteParticipants = new Map<string, FakeParticipant>();
    public isE2EEEnabled = false;
    private handlers = new Map<string, Handler[]>();
    private autoSubscribe = false;
    private nextSid = 0;

    constructor() {
      lkMocks.rooms.push(this);
    }

    public on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    public async connect(_url: string, _token: string, options: {autoSubscribe: boolean}): Promise<void> {
      this.autoSubscribe = options.autoSubscribe;
      this.localParticipant.identity = lkMocks.localIdentity;
    }

    public async disconnect(): Promise<void> {}

    public async publishRemote(options: {identity: string, source: 'camera' | 'screen', track: MediaStreamTrack}) {
      let participant: FakeParticipant | undefined = this.remoteParticipants.get(options.identity);
      if(!participant) {
        participant = {identity: options.identity, isLocal: false, trackPublications: new Map()};
        this.remoteParticipants.set(options.identity, participant);
        this.emit(lk.RoomEvent.ParticipantConnected, participant);
      }

      const publication: FakePublication = {
        trackSid: `TR_${++this.nextSid}`,
        source: options.source === 'screen' ? lk.Track.Source.ScreenShare : lk.Track.Source.Camera,
        isMuted: false,
        isSubscribed: this.autoSubscribe,
        setSubscribed: vi.fn((subscribed: boolean) => {
          publication.isSubscribed = subscribed;
        }),
        setVideoQuality: vi.fn()
      };
      participant.trackPublications.set(publication.trackSid, publication);
      this.emit(lk.RoomEvent.TrackPublished, publication, participant);
      await Promise.resolve();
      if(publication.isSubscribed) {
        this.emit(lk.RoomEvent.TrackSubscribed, {mediaStreamTrack: options.track}, publication, participant);
      }

      return publication;
    }

    private emit(event: string, ...args: unknown[]): void {
      (this.handlers.get(event) ?? []).forEach((handler) => handler(...args));
    }
  }

  return {loadLiveKit: async() => ({...lk, Room: FakeRoom})};
});
// The app-wide bus without its worker relay: the grid hears the instance's group_call_participant here.
vi.mock('@lib/rootScope', async() => {
  const {default: EventListenerBase} = await import('@helpers/eventListenerBase');
  return {default: new EventListenerBase()};
});
vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));
vi.mock('@environment/webpSupport', () => ({default: true}));
// The tile's muted icon and status line are not under test; the group call window's module is heavy.
vi.mock('@components/groupCall', () => ({
  getGroupCallParticipantMutedState: (): number => 1
}));
vi.mock('@components/groupCall/participantMutedIcon', () => ({
  default: class MutedIconMock {
    public container = document.createElement('div');
    public setState(): void {}
    public destroy(): void {}
  }
}));
vi.mock('@components/groupCall/participantStatus', () => ({
  default: class StatusMock {
    public container = document.createElement('div');
    public setState(): void {}
  }
}));
vi.mock('@components/peerTitle', () => ({
  default: class PeerTitleMock {
    public element = document.createElement('span');
  }
}));
vi.mock('@components/call/videoCanvasBlur', () => ({
  default: (): HTMLCanvasElement => document.createElement('canvas')
}));

import {GroupCallParticipant} from '@layer';
import GroupCallInstance from '@lib/calls/groupCallInstance';
import GroupCallConnectionInstance from '@lib/calls/groupCallConnectionInstance';
import {formatGroupCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import {toImpulseMSource} from '@lib/calls/utils';
import GroupCallParticipantsVideoElement from '@components/groupCall/participantVideos';
import ListenerSetter from '@helpers/listenerSetter';
import pause from '@helpers/schedulers/pause';

const CALL_ID = '700';
const SELF_ID = 1;
const SELF_SOURCE = 5;
const SHARER_ID = 2;
const SHARER_SOURCE = 8;
const SHARER_SCREEN_SOURCE = 9;
const CAMERA_ID = 3;
const CAMERA_SOURCE = 11;
const COORDINATES = {livekit: {url: 'wss://lk.example', token: 'jwt', room: `g.${CALL_ID}`}};

function identity(options: {userId: number, source: number, presentation?: boolean}): string {
  return formatGroupCallIdentity({
    kind: 'user',
    peerId: options.userId as PeerId,
    source: toImpulseMSource(options.source),
    isPresentation: !!options.presentation
  });
}

const SELF_IDENTITY = identity({userId: SELF_ID, source: SELF_SOURCE});
const SHARER_SCREEN_IDENTITY = identity({userId: SHARER_ID, source: SHARER_SCREEN_SOURCE, presentation: true});
const CAMERA_IDENTITY = identity({userId: CAMERA_ID, source: CAMERA_SOURCE});

function videoTrack(): MediaStreamTrack {
  return Object.assign(new EventTarget(), {kind: 'video', enabled: true, muted: false, readyState: 'live'}) as unknown as MediaStreamTrack;
}

function row(options: {userId: number, source: number, cameraSource?: number, screenSource?: number, self?: boolean}): GroupCallParticipant {
  return {
    _: 'groupCallParticipant',
    pFlags: options.self ? {self: true, can_self_unmute: true} : {},
    peer: {_: 'peerUser', user_id: options.userId},
    date: 1,
    source: toImpulseMSource(options.source),
    ...(options.cameraSource !== undefined ? {
      video: {
        _: 'groupCallParticipantVideo',
        pFlags: {},
        endpoint: identity({userId: options.userId, source: options.cameraSource}),
        source_groups: []
      }
    } : {}),
    ...(options.screenSource !== undefined ? {
      presentation: {
        _: 'groupCallParticipantVideo',
        pFlags: {},
        endpoint: identity({userId: options.userId, source: options.screenSource, presentation: true}),
        source_groups: [],
        audio_source: toImpulseMSource(options.screenSource)
      }
    } : {})
  } as unknown as GroupCallParticipant;
}

async function joinCall() {
  const rows = new Map<PeerId, GroupCallParticipant>();
  const managers: any = {
    appGroupCallsManager: {
      joinGroupCall: vi.fn(async() => ({
        _: 'updateGroupCallConnection',
        pFlags: {},
        params: {_: 'dataJSON', data: JSON.stringify(COORDINATES)},
        acceptedCallInput: {_: 'inputGroupCall', id: CALL_ID, access_hash: '701'}
      })),
      getCachedParticipants: vi.fn(async() => rows),
      saveApiParticipant: vi.fn()
    }
  };
  const streamManager: any = {
    inputStream: {
      getAudioTracks: (): MediaStreamTrack[] => [],
      getVideoTracks: (): MediaStreamTrack[] => []
    },
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    stop: vi.fn()
  };
  const instance = new GroupCallInstance({id: CALL_ID as any, chatId: 0 as any, managers});
  instance.participant = row({userId: SELF_ID, source: SELF_SOURCE, self: true});
  const connection: GroupCallConnectionInstance = instance.createConnectionInstance({
    streamManager,
    type: 'main',
    options: {type: 'main', isMuted: true}
  });
  await connection.join();
  const room = lkMocks.rooms[lkMocks.rooms.length - 1];

  const addRow = (participant: GroupCallParticipant): void => {
    rows.set(participant.peer._ === 'peerUser' ? participant.peer.user_id.toPeerId() : undefined, participant);
    instance.onParticipantUpdate(participant);
  };

  return {instance, room, addRow};
}

function renderGrid(instance: GroupCallInstance) {
  const appendTo = document.createElement('div');
  document.body.append(appendTo);
  const listenerSetter = new ListenerSetter();
  const grid = new GroupCallParticipantsVideoElement({
    appendTo,
    instance,
    listenerSetter,
    displayPinned: true,
    managers: {} as any
  });
  const tileOf = (track: MediaStreamTrack): HTMLElement | undefined => {
    return [...appendTo.querySelectorAll<HTMLElement>('.group-call-participant-video-container')].find((container) => {
      const video = container.querySelector('video');
      return (video?.srcObject as unknown as {getTracks(): MediaStreamTrack[]})?.getTracks().includes(track);
    });
  };
  const isVisible = (tile: HTMLElement | undefined): boolean => !!tile?.isConnected && !tile.classList.contains('video-hidden');
  return {grid, listenerSetter, tileOf, isVisible};
}

class FakeMediaStream {
  constructor(private readonly tracks: MediaStreamTrack[] = []) {}

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

const instances: GroupCallInstance[] = [];

beforeEach(() => {
  lkMocks.rooms = [];
  lkMocks.localIdentity = SELF_IDENTITY;
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('AudioContext', class {});
  document.body.replaceChildren();
});

afterEach(() => {
  for(const instance of instances.splice(0)) instance.cleanup();
  vi.unstubAllGlobals();
});

describe('a remote screen share in a group call', () => {
  it('is delivered by the room as a remote track, while our own share is turned away', async() => {
    const {instance, room} = await joinCall();
    instances.push(instance);
    const delivered: string[] = [];
    instance.connections.main.transport.addEventListener('remoteTrack', (info) => delivered.push(`${info.identity}:${info.source}`));

    const theirs = await room.publishRemote({identity: SHARER_SCREEN_IDENTITY, source: 'screen', track: videoTrack()});
    const ours = await room.publishRemote({
      identity: identity({userId: SELF_ID, source: 7, presentation: true}),
      source: 'screen',
      track: videoTrack()
    });

    expect(theirs.setSubscribed, 'another participant\'s screen must stay subscribed').not.toHaveBeenCalledWith(false);
    expect(ours.setSubscribed).toHaveBeenCalledWith(false);
    expect(delivered).toEqual([`${SHARER_SCREEN_IDENTITY}:screen`]);
  });

  it('reaches the presentation video element and a visible tile in the grid', async() => {
    const {instance, room, addRow} = await joinCall();
    instances.push(instance);
    const sharer = row({userId: SHARER_ID, source: SHARER_SOURCE, screenSource: SHARER_SCREEN_SOURCE});
    addRow(sharer);
    const {listenerSetter, tileOf, isVisible} = renderGrid(instance);
    const screen = videoTrack();

    await room.publishRemote({identity: SHARER_SCREEN_IDENTITY, source: 'screen', track: screen});
    await pause(0);

    const result = instance.getVideoElementFromParticipantByType(sharer, 'presentation');
    expect(result, 'the presentation must have a video element').toBeDefined();
    expect((result.video.srcObject as unknown as FakeMediaStream).getTracks()).toEqual([screen]);
    expect(isVisible(tileOf(screen)), 'the screen tile must be shown').toBe(true);
    expect(instance.pinnedSource).toBe(SHARER_SCREEN_IDENTITY);
    listenerSetter.removeAll();
  });

  it('auto-pinned before its track arrives, leaves the camera tiles visible until it can be shown', async() => {
    const {instance, room, addRow} = await joinCall();
    instances.push(instance);
    addRow(row({userId: CAMERA_ID, source: CAMERA_SOURCE, cameraSource: CAMERA_SOURCE}));
    const {listenerSetter, tileOf, isVisible} = renderGrid(instance);
    const camera = videoTrack();
    await room.publishRemote({identity: CAMERA_IDENTITY, source: 'camera', track: camera});
    await pause(0);
    expect(isVisible(tileOf(camera))).toBe(true);

    addRow(row({userId: SHARER_ID, source: SHARER_SOURCE, screenSource: SHARER_SCREEN_SOURCE}));
    await pause(0);

    expect(isVisible(tileOf(camera)), 'the camera tile must stay visible while the pinned screen has no video').toBe(true);
    expect(instance.pinnedSource, 'a pin with no video yet must not apply').toBeUndefined();

    const screen = videoTrack();
    await room.publishRemote({identity: SHARER_SCREEN_IDENTITY, source: 'screen', track: screen});
    await pause(0);

    expect(instance.pinnedSource).toBe(SHARER_SCREEN_IDENTITY);
    expect(isVisible(tileOf(screen)), 'the pinned screen tile must be shown once its video is here').toBe(true);
    listenerSetter.removeAll();
  });
});
