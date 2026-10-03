import type {
  DisconnectReason as LiveKitDisconnectReason,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  TrackPublication
} from 'livekit-client';
import EventListenerBase from '@helpers/eventListenerBase';
import {logger} from '@lib/logger';
import {loadLiveKit, LiveKitModule} from '@lib/calls/livekit/loadLiveKit';
import {createLiveKitE2eeWorker} from '@lib/calls/livekit/liveKitE2eeWorker';
import type {LiveKitJoinParams} from '@lib/calls/livekit/liveKitJoinParams';
import {
  LiveKitConnectError,
  LiveKitDisconnectCause,
  LiveKitE2eeUnsupportedError,
  LiveKitMediaSource,
  LiveKitNotPublishedError,
  LiveKitPublishDeniedError
} from '@lib/calls/livekit/liveKitErrors';

export type {LiveKitDisconnectCause, LiveKitMediaSource};

export type LiveKitTransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type LiveKitRemoteVideoQuality = 'high' | 'medium' | 'low';

export type LiveKitRemoteTrackInfo = {
  identity: string,
  sid: string,
  source: LiveKitMediaSource,
  track: MediaStreamTrack,
  muted: boolean
};

export type LiveKitPublishPermission = {
  canPublish: boolean,
  sources: LiveKitMediaSource[]
};

export type LiveKitDiagnostics = {
  state: LiveKitTransportState,
  localIdentity: string | undefined,
  e2ee: boolean,
  remoteParticipants: string[],
  remoteTracks: Array<{
    identity: string,
    sid: string,
    source: LiveKitMediaSource,
    kind: 'audio' | 'video',
    muted: boolean,
    bytesReceived: number | undefined
  }>
};

export type LiveKitConnectOptions = {
  /** Subscribe to every remote publication on its own. The presentation connection turns this off. */
  autoSubscribe: boolean,
  /**
   * With autoSubscribe, a publication of a participant for which this returns false is unsubscribed again
   * at once (a group call must not download its own screen share back from the presentation connection).
   */
  shouldSubscribe?: (identity: string) => boolean,
  /**
   * Raw key material for end-to-end media encryption. Present means the connection is encrypted
   * and refuses to run in a browser that cannot encrypt; there is no plaintext fallback.
   */
  e2eeKey?: Uint8Array
};

export type LiveKitTransportEvents = {
  state: (state: LiveKitTransportState, cause?: LiveKitDisconnectCause) => void,
  remoteTrack: (info: LiveKitRemoteTrackInfo) => void,
  remoteTrackRemoved: (info: {identity: string, sid: string, source: LiveKitMediaSource}) => void,
  remoteTrackMuted: (info: {identity: string, source: LiveKitMediaSource, muted: boolean}) => void,
  /** `reason` is the server's account of why a participant left; it is for logs only and never changes the call. */
  remoteParticipant: (info: {identity: string, present: boolean, reason?: LiveKitDisconnectReason}) => void,
  activeSpeakers: (identities: string[]) => void,
  publishPermission: (permission: LiveKitPublishPermission) => void,
  encryptionError: (error: Error) => void
};

export const LIVEKIT_ROOM_OPTIONS = {
  adaptiveStream: false,
  dynacast: true,
  disconnectOnPageLeave: true
} as const;


export default class LiveKitTransport extends EventListenerBase<LiveKitTransportEvents> {
  public state: LiveKitTransportState = 'idle';
  public disconnectCause: LiveKitDisconnectCause | undefined;

  private room: Room | undefined;
  private lk: LiveKitModule | undefined;
  private disposed = false;
  private e2eeEnabled = false;
  private shouldSubscribe: ((identity: string) => boolean) | undefined;
  private publications = new Map<LiveKitMediaSource, LocalTrackPublication>();
  private remoteTracks = new Map<string, {
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    identity: string,
    source: LiveKitMediaSource
  }>();
  private announcedParticipants = new Set<string>();
  private log: ReturnType<typeof logger> = logger('LIVEKIT');


  public async connect(params: LiveKitJoinParams, options: LiveKitConnectOptions): Promise<void> {
    if(this.state !== 'idle' || this.disposed) {
      throw new Error('LiveKitTransport.connect: the transport is already used');
    }

    this.setState('connecting');
    const lk: LiveKitModule = await loadLiveKit();
    if(this.disposed) {
      throw new LiveKitConnectError('client', 'disconnected before the connection started');
    }

    this.lk = lk;
    this.shouldSubscribe = options.shouldSubscribe;
    const roomOptions: ConstructorParameters<typeof lk.Room>[0] = {...LIVEKIT_ROOM_OPTIONS};
    let keyProvider: InstanceType<typeof lk.ExternalE2EEKeyProvider> | undefined;
    if(options.e2eeKey) {
      if(!lk.isE2EESupported()) {
        const unsupported: LiveKitE2eeUnsupportedError = new LiveKitE2eeUnsupportedError();
        this.finish('unknown');
        throw unsupported;
      }

      keyProvider = new lk.ExternalE2EEKeyProvider();
      roomOptions.e2ee = {keyProvider, worker: createLiveKitE2eeWorker()};
    }

    const room: Room = new lk.Room(roomOptions);
    this.room = room;
    this.attach(room, lk);

    try {
      if(keyProvider) {
        await keyProvider.setKey(toArrayBuffer(options.e2eeKey));
        await room.setE2EEEnabled(true);
        this.e2eeEnabled = true;
      }

      await room.connect(params.url, params.token, {autoSubscribe: options.autoSubscribe});
    } catch(err) {
      const cause: LiveKitDisconnectCause = this.disposed ? 'client' : causeOfConnectError(lk, err);
      this.finish(cause);
      throw new LiveKitConnectError(cause, err instanceof Error ? err.message : String(err));
    }

    if(this.disposed) {
      throw new LiveKitConnectError('client', 'disconnected while connecting');
    }

    this.setState('connected');
    for(const participant of room.remoteParticipants.values()) {
      this.announceParticipant(participant);
    }
  }

  public getPublishPermission(): LiveKitPublishPermission | undefined {
    const permissions = this.room?.localParticipant?.permissions;
    if(!permissions || !this.lk) {
      return undefined;
    }

    return convertPermissions(this.lk, permissions);
  }

  public async publish(options: {source: LiveKitMediaSource, track: MediaStreamTrack}): Promise<void> {
    const {source, track} = options;
    const room: Room = this.requireRoom();
    const permission: LiveKitPublishPermission | undefined = this.getPublishPermission();
    if(!permission || !permission.canPublish || !permission.sources.includes(source)) {
      throw new LiveKitPublishDeniedError(source);
    }

    const existing: LocalTrackPublication | undefined = this.publications.get(source);
    if(existing?.track) {
      await existing.track.replaceTrack(track, {userProvidedTrack: true});
      return;
    }

    const publication: LocalTrackPublication = await room.localParticipant.publishTrack(track, {
      source: toLiveKitSource(this.requireModule(), source)
    });
    if(this.disposed) {
      return;
    }

    this.publications.set(source, publication);
  }

  public async replace(options: {source: LiveKitMediaSource, track: MediaStreamTrack}): Promise<void> {
    const publication: LocalTrackPublication = this.requirePublication(options.source);
    await publication.track.replaceTrack(options.track, {userProvidedTrack: true});
  }

  public async setMuted(options: {source: LiveKitMediaSource, muted: boolean}): Promise<void> {
    const publication: LocalTrackPublication = this.requirePublication(options.source);
    if(options.muted) {
      await publication.mute();
    } else {
      await publication.unmute();
    }
  }

  public isPublished(source: LiveKitMediaSource): boolean {
    return this.publications.has(source);
  }

  /** The capture track currently sent for `source`. */
  public getPublishedTrack(source: LiveKitMediaSource): MediaStreamTrack | undefined {
    return this.publications.get(source)?.track?.mediaStreamTrack;
  }

  public async unpublish(source: LiveKitMediaSource): Promise<void> {
    const publication: LocalTrackPublication = this.requirePublication(source);
    this.publications.delete(source);
    // the capture belongs to the call, not to LiveKit: never stop the track on unpublish
    await this.requireRoom().localParticipant.unpublishTrack(publication.track, false);
  }

  public setRemoteVideoQuality(options: {
    identity: string,
    source: LiveKitMediaSource,
    quality: LiveKitRemoteVideoQuality
  }): void {
    const lk: LiveKitModule | undefined = this.lk;
    if(!lk || this.disposed) {
      return;
    }

    for(const entry of this.remoteTracks.values()) {
      if(entry.identity === options.identity && entry.source === options.source) {
        entry.publication.setVideoQuality(toLiveKitQuality(lk, options.quality));
      }
    }
  }

  public async getDiagnostics(): Promise<LiveKitDiagnostics> {
    const entries = Array.from(this.remoteTracks.values());
    const remoteTracks: LiveKitDiagnostics['remoteTracks'] = await Promise.all(entries.map(async(entry) => {
      let bytesReceived: number | undefined;
      try {
        const stats = await (entry.track as {getReceiverStats?: () => Promise<{bytesReceived?: number} | undefined>}).getReceiverStats?.();
        bytesReceived = stats?.bytesReceived;
      } catch(err) {
        this.log.warn('receiver stats unavailable', err);
      }

      return {
        identity: entry.identity,
        sid: entry.publication.trackSid,
        source: entry.source,
        kind: entry.track.kind === 'audio' ? 'audio' as const : 'video' as const,
        muted: entry.publication.isMuted,
        bytesReceived
      };
    }));

    return {
      state: this.state,
      localIdentity: this.room?.localParticipant?.identity,
      e2ee: this.e2eeEnabled && this.room?.isE2EEEnabled === true,
      remoteParticipants: Array.from(this.announcedParticipants),
      remoteTracks
    };
  }

  /** Idempotent. Emits `disconnected` with cause `client` once; later LiveKit events are dropped. */
  public disconnect(): void {
    if(this.disposed) {
      return;
    }

    const room: Room | undefined = this.room;
    this.finish('client');
    if(room) {
      room.disconnect(false).catch((err: unknown) => {
        this.log.warn('room disconnect failed', err);
      });
    }
  }


  private attach(room: Room, lk: LiveKitModule): void {
    const Event = lk.RoomEvent;
    room.on(Event.Reconnecting, () => this.whileLive(() => this.setState('reconnecting')));
    room.on(Event.SignalReconnecting, () => this.whileLive(() => this.setState('reconnecting')));
    room.on(Event.Reconnected, () => this.whileLive(() => this.setState('connected')));
    room.on(Event.Disconnected, (reason?: LiveKitDisconnectReason) => this.whileLive(() => {
      this.finish(causeOfDisconnectReason(lk, reason));
    }));
    room.on(Event.ParticipantConnected, (participant: RemoteParticipant) => this.whileLive(() => {
      this.announceParticipant(participant);
    }));
    room.on(Event.ParticipantDisconnected, (participant: RemoteParticipant, reason?: LiveKitDisconnectReason) => this.whileLive(() => {
      this.announcedParticipants.delete(participant.identity);
      this.dispatchEvent('remoteParticipant', {identity: participant.identity, present: false, reason});
    }));
    room.on(Event.TrackPublished, (publication: RemoteTrackPublication, participant: RemoteParticipant) => this.whileLive(() => {
      this.unsubscribeIfUnwanted(publication, participant);
    }));
    room.on(Event.TrackSubscribed, (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => this.whileLive(() => {
      const source: LiveKitMediaSource | undefined = fromLiveKitSource(lk, publication.source);
      if(!source) {
        return;
      }

      this.announceParticipant(participant);
      this.remoteTracks.set(publication.trackSid, {track, publication, identity: participant.identity, source});
      this.dispatchEvent('remoteTrack', {
        identity: participant.identity,
        sid: publication.trackSid,
        source,
        track: track.mediaStreamTrack,
        muted: publication.isMuted
      });
    }));
    room.on(Event.TrackUnsubscribed, (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => this.whileLive(() => {
      const source: LiveKitMediaSource | undefined = fromLiveKitSource(lk, publication.source);
      if(!source || !this.remoteTracks.delete(publication.trackSid)) {
        return;
      }

      this.dispatchEvent('remoteTrackRemoved', {identity: participant.identity, sid: publication.trackSid, source});
    }));
    const onMuteChanged = (muted: boolean, publication: TrackPublication, participant: Participant): void => this.whileLive(() => {
      if(participant.isLocal) {
        return;
      }

      const source: LiveKitMediaSource | undefined = fromLiveKitSource(lk, publication.source);
      if(source) {
        this.dispatchEvent('remoteTrackMuted', {identity: participant.identity, source, muted});
      }
    });
    room.on(Event.TrackMuted, (publication: TrackPublication, participant: Participant) => {
      onMuteChanged(true, publication, participant);
    });
    room.on(Event.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
      onMuteChanged(false, publication, participant);
    });
    // the server can take a publication away (a revoked permission): it must stop counting as published
    room.on(Event.LocalTrackUnpublished, (publication: LocalTrackPublication) => this.whileLive(() => {
      const source: LiveKitMediaSource | undefined = fromLiveKitSource(lk, publication.source);
      if(source && this.publications.get(source) === publication) {
        this.publications.delete(source);
      }
    }));
    room.on(Event.ActiveSpeakersChanged, (speakers: Participant[]) => this.whileLive(() => {
      this.dispatchEvent('activeSpeakers', speakers.map((speaker: Participant) => speaker.identity));
    }));
    room.on(Event.ParticipantPermissionsChanged, (_previous: unknown, participant: Participant) => this.whileLive(() => {
      if(!participant.isLocal || !participant.permissions) {
        return;
      }

      this.dispatchEvent('publishPermission', convertPermissions(lk, participant.permissions));
    }));
    room.on(Event.EncryptionError, (error: Error) => this.whileLive(() => {
      this.dispatchEvent('encryptionError', error);
    }));
  }

  private unsubscribeIfUnwanted(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if(this.shouldSubscribe && !this.shouldSubscribe(participant.identity)) {
      publication.setSubscribed(false);
    }
  }

  private announceParticipant(participant: RemoteParticipant): void {
    for(const publication of participant.trackPublications.values()) {
      this.unsubscribeIfUnwanted(publication as RemoteTrackPublication, participant);
    }

    if(this.announcedParticipants.has(participant.identity)) {
      return;
    }

    this.announcedParticipants.add(participant.identity);
    this.dispatchEvent('remoteParticipant', {identity: participant.identity, present: true});
  }

  private whileLive(run: () => void): void {
    if(this.disposed) {
      return;
    }

    run();
  }

  private setState(state: LiveKitTransportState, cause?: LiveKitDisconnectCause): void {
    if(this.state === state) {
      return;
    }

    this.state = state;
    this.dispatchEvent('state', state, cause);
  }

  /** Terminal: emits the final state once and silences every later event. */
  private finish(cause: LiveKitDisconnectCause): void {
    if(this.disposed) {
      return;
    }

    this.disposed = true;
    this.disconnectCause = cause;
    this.publications.clear();
    this.remoteTracks.clear();
    this.announcedParticipants.clear();
    this.state = 'disconnected';
    this.dispatchEvent('state', 'disconnected', cause);
  }

  private requireRoom(): Room {
    if(!this.room || this.disposed || this.state === 'idle' || this.state === 'connecting') {
      throw new Error('LiveKitTransport: not connected');
    }

    return this.room;
  }

  private requireModule(): LiveKitModule {
    if(!this.lk) {
      throw new Error('LiveKitTransport: not connected');
    }

    return this.lk;
  }

  private requirePublication(source: LiveKitMediaSource): LocalTrackPublication {
    this.requireRoom();
    const publication: LocalTrackPublication | undefined = this.publications.get(source);
    if(!publication?.track) {
      throw new LiveKitNotPublishedError(source);
    }

    return publication;
  }
}


function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toLiveKitSource(lk: LiveKitModule, source: LiveKitMediaSource): import('livekit-client').Track.Source {
  switch(source) {
    case 'microphone':
      return lk.Track.Source.Microphone;
    case 'camera':
      return lk.Track.Source.Camera;
    case 'screen':
      return lk.Track.Source.ScreenShare;
    case 'screenAudio':
      return lk.Track.Source.ScreenShareAudio;
  }
}

function fromLiveKitSource(lk: LiveKitModule, source: import('livekit-client').Track.Source): LiveKitMediaSource | undefined {
  switch(source) {
    case lk.Track.Source.Microphone:
      return 'microphone';
    case lk.Track.Source.Camera:
      return 'camera';
    case lk.Track.Source.ScreenShare:
      return 'screen';
    case lk.Track.Source.ScreenShareAudio:
      return 'screenAudio';
    default:
      return undefined;
  }
}

function toLiveKitQuality(lk: LiveKitModule, quality: LiveKitRemoteVideoQuality): import('livekit-client').VideoQuality {
  switch(quality) {
    case 'high':
      return lk.VideoQuality.HIGH;
    case 'medium':
      return lk.VideoQuality.MEDIUM;
    case 'low':
      return lk.VideoQuality.LOW;
  }
}

function convertPermissions(
  lk: LiveKitModule,
  permissions: NonNullable<Participant['permissions']>
): LiveKitPublishPermission {
  const all: LiveKitMediaSource[] = ['microphone', 'camera', 'screen', 'screenAudio'];
  // an empty source list with canPublish set means every source, as in the LiveKit server
  const listed: LiveKitMediaSource[] = (permissions.canPublishSources || [])
  .map((proto) => fromLiveKitSource(lk, lk.Track.sourceFromProto(proto)))
  .filter((source): source is LiveKitMediaSource => !!source);
  return {
    canPublish: permissions.canPublish,
    sources: permissions.canPublishSources?.length ? listed : all
  };
}

export function causeOfDisconnectReason(lk: LiveKitModule, reason: LiveKitDisconnectReason | undefined): LiveKitDisconnectCause {
  const Reason = lk.DisconnectReason;
  switch(reason) {
    case Reason.CLIENT_INITIATED:
      return 'client';
    // Only ROOM_DELETED is the server ending the call (it deletes a call's room as it discards the call).
    // ROOM_CLOSED is any other close of the room, so it is a lost connection like the rest.
    case Reason.ROOM_DELETED:
      return 'roomDeleted';
    case Reason.PARTICIPANT_REMOVED:
      return 'removed';
    case Reason.DUPLICATE_IDENTITY:
      return 'duplicateIdentity';
    case Reason.SERVER_SHUTDOWN:
    case Reason.STATE_MISMATCH:
    case Reason.JOIN_FAILURE:
    case Reason.MIGRATION:
    case Reason.SIGNAL_CLOSE:
    case Reason.ROOM_CLOSED:
      return 'network';
    default:
      return 'unknown';
  }
}

function causeOfConnectError(lk: LiveKitModule, err: unknown): LiveKitDisconnectCause {
  if(err instanceof lk.ConnectionError) {
    if(err.reason === lk.ConnectionErrorReason.NotAllowed) {
      return 'rejected';
    }

    if(err.reason === lk.ConnectionErrorReason.Cancelled) {
      return 'client';
    }

    return 'network';
  }

  return 'unknown';
}

/**
 * Throws LiveKitE2eeUnsupportedError unless this browser can encrypt media end to end (insertable
 * streams / script transform and WebCrypto in a secure context).
 */
export async function assertLiveKitE2eeSupported(): Promise<void> {
  const lk: LiveKitModule = await loadLiveKit();
  if(!lk.isE2EESupported() || typeof crypto?.subtle?.digest !== 'function') {
    throw new LiveKitE2eeUnsupportedError();
  }
}
