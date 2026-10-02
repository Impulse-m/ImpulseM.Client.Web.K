// A hand-written stand-in for livekit-client: only the surface LiveKitTransport touches.
// It lets a test drive the room events and observe what the transport asked the room to do.

export const RoomEvent = {
  Reconnecting: 'reconnecting',
  SignalReconnecting: 'signalReconnecting',
  Reconnected: 'reconnected',
  Disconnected: 'disconnected',
  ParticipantConnected: 'participantConnected',
  ParticipantDisconnected: 'participantDisconnected',
  TrackPublished: 'trackPublished',
  LocalTrackUnpublished: 'localTrackUnpublished',
  TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed',
  TrackMuted: 'trackMuted',
  TrackUnmuted: 'trackUnmuted',
  ActiveSpeakersChanged: 'activeSpeakersChanged',
  ParticipantPermissionsChanged: 'participantPermissionsChanged',
  EncryptionError: 'encryptionError'
} as const;

export enum DisconnectReason {
  UNKNOWN_REASON = 0,
  CLIENT_INITIATED = 1,
  DUPLICATE_IDENTITY = 2,
  SERVER_SHUTDOWN = 3,
  PARTICIPANT_REMOVED = 4,
  ROOM_DELETED = 5,
  STATE_MISMATCH = 6,
  JOIN_FAILURE = 7,
  MIGRATION = 8,
  SIGNAL_CLOSE = 9,
  ROOM_CLOSED = 10,
  USER_UNAVAILABLE = 11,
  USER_REJECTED = 12
}

export enum ConnectionErrorReason {
  NotAllowed = 0,
  ServerUnreachable = 1,
  InternalError = 2,
  Cancelled = 3,
  LeaveRequest = 4,
  Timeout = 5,
  WebSocket = 6,
  ServiceNotFound = 7
}

export class ConnectionError extends Error {
  public reason: ConnectionErrorReason;

  constructor(message: string, reason: ConnectionErrorReason) {
    super(message);
    this.reason = reason;
  }
}

export enum TrackSource {
  Camera = 'camera',
  Microphone = 'microphone',
  ScreenShare = 'screen_share',
  ScreenShareAudio = 'screen_share_audio',
  Unknown = 'unknown'
}

// protocol numbering: CAMERA = 1, MICROPHONE = 2, SCREEN_SHARE = 3, SCREEN_SHARE_AUDIO = 4
const PROTO_SOURCES: TrackSource[] = [TrackSource.Unknown, TrackSource.Camera, TrackSource.Microphone, TrackSource.ScreenShare, TrackSource.ScreenShareAudio];

export const Track = {
  Source: TrackSource,
  sourceFromProto: (proto: number): TrackSource => PROTO_SOURCES[proto] ?? TrackSource.Unknown
};

export enum VideoQuality {
  LOW = 0,
  MEDIUM = 1,
  HIGH = 2
}

export class FakeEmitter {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  public on(event: string, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  public emit(event: string, ...args: any[]): void {
    for(const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

export type FakeLocalTrack = {
  mediaStreamTrack: MediaStreamTrack,
  replaced: MediaStreamTrack[],
  replaceTrack: (track: MediaStreamTrack, options: {userProvidedTrack: boolean}) => Promise<void>
};

export type FakePublication = {
  track: FakeLocalTrack,
  mediaTrack: MediaStreamTrack,
  source: string,
  isMuted: boolean,
  mute: () => Promise<void>,
  unmute: () => Promise<void>
};

export const fakeState = {
  rooms: [] as FakeRoom[],
  e2eeSupported: true,
  connectBehavior: undefined as undefined | (() => Promise<void>),
  keyProviders: [] as Array<{keys: ArrayBuffer[]}>
};

export class FakeRoom extends FakeEmitter {
  public options: any;
  public remoteParticipants = new Map<string, any>();
  public isE2EEEnabled = false;
  public connectArgs: any[] | undefined;
  public disconnectCalls: any[][] = [];
  public published: FakePublication[] = [];
  public unpublished: Array<{track: FakeLocalTrack, stopOnUnpublish: boolean}> = [];
  public localParticipant: any;

  constructor(options: any) {
    super();
    this.options = options;
    this.localParticipant = {
      identity: 'u1',
      isLocal: true,
      permissions: {canPublish: true, canPublishSources: [1, 2, 3, 4]},
      publishTrack: async(mediaTrack: MediaStreamTrack, publishOptions: {source: string}) => {
        const track: FakeLocalTrack = {
          mediaStreamTrack: mediaTrack,
          replaced: [],
          replaceTrack: async(replacement) => {
            track.replaced.push(replacement);
          }
        };
        const publication: FakePublication = {
          track,
          mediaTrack,
          source: publishOptions.source,
          isMuted: false,
          mute: async() => {
            publication.isMuted = true;
          },
          unmute: async() => {
            publication.isMuted = false;
          }
        };
        this.published.push(publication);
        return publication;
      },
      unpublishTrack: async(track: FakeLocalTrack, stopOnUnpublish: boolean) => {
        this.unpublished.push({track, stopOnUnpublish});
      }
    };
    fakeState.rooms.push(this);
  }

  public connect = async(url: string, token: string, options: unknown): Promise<void> => {
    this.connectArgs = [url, token, options];
    await fakeState.connectBehavior?.();
  };

  public disconnect = async(...args: any[]): Promise<void> => {
    this.disconnectCalls.push(args);
  };

  public setE2EEEnabled = async(enabled: boolean): Promise<void> => {
    this.isE2EEEnabled = enabled;
  };
}

export class ExternalE2EEKeyProvider {
  public keys: ArrayBuffer[] = [];

  constructor() {
    fakeState.keyProviders.push(this);
  }

  public async setKey(key: ArrayBuffer): Promise<void> {
    this.keys.push(key);
  }
}

export function isE2EESupported(): boolean {
  return fakeState.e2eeSupported;
}

export function resetFakeLiveKit(): void {
  fakeState.rooms = [];
  fakeState.e2eeSupported = true;
  fakeState.connectBehavior = undefined;
  fakeState.keyProviders = [];
}

export function fakeRemoteParticipant(identity: string): any {
  return {identity, isLocal: false, trackPublications: new Map<string, any>()};
}

export function fakeRemotePublication(options: {sid: string, source: TrackSource, muted?: boolean}): any {
  const qualities: VideoQuality[] = [];
  return {
    trackSid: options.sid,
    source: options.source,
    isMuted: options.muted ?? false,
    subscriptions: [] as boolean[],
    setSubscribed(subscribed: boolean) {
      this.subscriptions.push(subscribed);
    },
    qualities,
    setVideoQuality: (quality: VideoQuality) => {
      qualities.push(quality);
    }
  };
}

export function fakeRemoteTrack(kind: 'audio' | 'video', bytesReceived = 0): any {
  return {
    kind,
    mediaStreamTrack: {kind, id: `${kind}-track`} as unknown as MediaStreamTrack,
    getReceiverStats: async() => ({bytesReceived})
  };
}

export const fakeLiveKitModule = {
  RoomEvent,
  DisconnectReason,
  ConnectionError,
  ConnectionErrorReason,
  Track,
  VideoQuality,
  Room: FakeRoom,
  ExternalE2EEKeyProvider,
  isE2EESupported
};
