import ctx from '@environment/ctx';
import safePlay from '@helpers/dom/safePlay';
import EventListenerBase from '@helpers/eventListenerBase';
import {logger} from '@lib/logger';
import {stopStream} from '@lib/calls/helpers/getUserStream';
import type LiveKitTransport from '@lib/calls/livekit/liveKitTransport';
import type {
  LiveKitConnectOptions,
  LiveKitDisconnectCause,
  LiveKitMediaSource,
  LiveKitRemoteTrackInfo,
  LiveKitTransportState
} from '@lib/calls/livekit/liveKitTransport';
import type {LiveKitJoinParams} from '@lib/calls/livekit/liveKitJoinParams';
import {formatPhoneCallIdentity} from '@lib/calls/livekit/liveKitIdentity';

/** How long the peer may be absent from the room before the call is hung up (nothing tells a 1:1 room otherwise: G4). */
export const PEER_GONE_HANGUP_MS = 20000;

/** How long to wait for the peer to appear in the room after we connected. */
export const PEER_JOIN_TIMEOUT_MS = 45000;

export type PhoneCallConnectionState = 'connecting' | 'connected' | 'failed' | 'roomDeleted' | 'closed';

export type PhoneCallOwnKind = 'audio' | 'video' | 'presentation';

export type RemoteMediaState = {
  isMuted: boolean,
  videoState: 'active' | 'inactive',
  videoRotation: 0,
  screencastState: 'active' | 'inactive',
  isBatteryLow: boolean
};

export type PhoneCallStreams = {
  /** Remote microphone. */
  audio?: MediaStream,
  /** Remote camera. */
  video?: MediaStream,
  /** Remote screen. */
  presentation?: MediaStream,
  ownAudio?: MediaStream,
  ownVideo?: MediaStream,
  ownPresentation?: MediaStream
};

export type PhoneCallTransport = Pick<
  LiveKitTransport,
  'connect' | 'publish' | 'replace' | 'setMuted' | 'unpublish' | 'isPublished' | 'disconnect' | 'getDiagnostics' |
  'addEventListener' | 'removeEventListener' | 'state'
>;

export type PhoneCallSessionEvents = {
  connectionState: (state: PhoneCallConnectionState, cause?: LiveKitDisconnectCause) => void,
  remoteMediaState: (state: RemoteMediaState) => void,
  /** The peer was absent from the room for longer than PEER_GONE_HANGUP_MS (or never arrived within PEER_JOIN_TIMEOUT_MS). */
  peerLost: () => void,
  /** A local capture ended on its own (device unplugged, permission revoked). */
  ownTrackEnded: (kind: PhoneCallOwnKind) => void,
  encryptionError: (error: Error) => void
};

const SOURCE_BY_KIND: Record<PhoneCallOwnKind, LiveKitMediaSource> = {
  audio: 'microphone',
  video: 'camera',
  presentation: 'screen'
};


/**
 * The media side of a 1:1 call on LiveKit: owns the transport, our own streams, the remote streams and the
 * remote audio element, and turns LiveKit state into the connection and media states the call UI consumes.
 */
export default class PhoneCallSession extends EventListenerBase<PhoneCallSessionEvents> {
  public readonly audioElement: HTMLAudioElement;
  public connectionState: PhoneCallConnectionState = 'connecting';

  private readonly transport: PhoneCallTransport;
  private readonly peerIdentity: string;
  private readonly log: ReturnType<typeof logger>;
  private readonly streams: PhoneCallStreams = {};
  private readonly remoteTracks = new Map<LiveKitMediaSource, {track: MediaStreamTrack, muted: boolean}>();
  private peerPresent = false;
  private closed = false;
  private peerTimer: number | undefined;
  private remoteMediaState: RemoteMediaState = {
    isBatteryLow: false,
    screencastState: 'inactive',
    videoState: 'inactive',
    videoRotation: 0,
    isMuted: true
  };


  constructor(options: {transport: PhoneCallTransport, remoteUserId: UserId}) {
    super(false);
    this.transport = options.transport;
    this.peerIdentity = formatPhoneCallIdentity(options.remoteUserId);
    this.log = logger('CALL-LK');

    const audio: HTMLAudioElement = this.audioElement = new Audio();
    audio.autoplay = true;
    audio.setAttribute('playsinline', 'true');

    this.listen();
  }


  public getStreams(): PhoneCallStreams {
    return this.streams;
  }

  public getRemoteMediaState(): RemoteMediaState {
    return this.remoteMediaState;
  }

  public isOwnActive(kind: PhoneCallOwnKind): boolean {
    return !!this.streams[kind === 'audio' ? 'ownAudio' : kind === 'video' ? 'ownVideo' : 'ownPresentation']
      ?.getTracks()[0]?.enabled;
  }

  /**
   * Connects, then publishes what was captured: the microphone always, the camera when given.
   * Rejects with the transport's typed error; the caller decides how the call ends.
   */
  public async start(options: {
    params: LiveKitJoinParams,
    e2eeKey: Uint8Array,
    audio: MediaStream,
    video?: MediaStream
  }): Promise<void> {
    const connectOptions: LiveKitConnectOptions = {autoSubscribe: true, e2eeKey: options.e2eeKey};
    await this.transport.connect(options.params, connectOptions);
    if(this.closed) {
      throw new Error('PhoneCallSession: closed while connecting');
    }

    await this.setOwnMedia({kind: 'audio', stream: options.audio});
    if(options.video) {
      await this.setOwnMedia({kind: 'video', stream: options.video});
    }
  }

  /**
   * Makes `stream` the one we send for `kind`, or stops sending it when `stream` is undefined.
   * Audio is muted rather than unpublished so the publication (and the remote's track) stays; the
   * capture itself is always released. Camera and screen are unpublished.
   */
  public async setOwnMedia(options: {kind: PhoneCallOwnKind, stream: MediaStream | undefined}): Promise<void> {
    const {kind, stream} = options;
    const source: LiveKitMediaSource = SOURCE_BY_KIND[kind];

    if(stream) {
      const track: MediaStreamTrack = stream.getTracks()[0];
      if(this.transport.isPublished(source)) {
        await this.transport.replace({source, track});
        if(kind === 'audio') {
          await this.transport.setMuted({source, muted: false});
        }
      } else {
        await this.transport.publish({source, track});
      }

      this.adoptOwnStream({kind, stream});
      return;
    }

    if(!this.transport.isPublished(source)) {
      this.adoptOwnStream({kind, stream: undefined});
      return;
    }

    if(kind === 'audio') {
      await this.transport.setMuted({source, muted: true});
    } else {
      await this.transport.unpublish(source);
    }

    this.adoptOwnStream({kind, stream: undefined});
  }

  /** Swaps the sent track in place (device change); the caller commits it with adoptOwnStream. */
  public replaceTrack(options: {kind: PhoneCallOwnKind, track: MediaStreamTrack}): Promise<void> {
    return this.transport.replace({source: SOURCE_BY_KIND[options.kind], track: options.track});
  }

  /** Records `stream` as our current capture of `kind` and releases the previous one. */
  public adoptOwnStream(options: {kind: PhoneCallOwnKind, stream: MediaStream | undefined}): void {
    const {kind, stream} = options;
    if(this.closed) {
      // close() already released everything; a capture handed over after that must not outlive the call
      stopStream(stream);
      return;
    }

    const previous: MediaStream | undefined = this.getOwn(kind);
    this.setOwn(kind, stream);
    if(previous && previous !== stream) {
      stopStream(previous);
    }

    const track: MediaStreamTrack | undefined = stream?.getTracks()[0];
    if(track) {
      track.onended = () => {
        if(this.getOwn(kind) === stream && !this.closed) {
          this.dispatchEvent('ownTrackEnded', kind);
        }
      };
    }
  }

  public async getDiagnostics() {
    return this.transport.getDiagnostics();
  }

  /** Idempotent. Releases every capture and the transport; no state is emitted for the close. */
  public close(): void {
    if(this.closed) {
      return;
    }

    this.closed = true;
    this.clearPeerTimer();
    this.transport.disconnect();
    for(const kind of ['audio', 'video', 'presentation'] as const) {
      stopStream(this.getOwn(kind));
      this.setOwn(kind, undefined);
    }

    this.audioElement.srcObject = null;
    this.remoteTracks.clear();
    this.streams.audio = this.streams.video = this.streams.presentation = undefined;
  }


  private listen(): void {
    const transport: PhoneCallTransport = this.transport;
    transport.addEventListener('state', (state: LiveKitTransportState, cause?: LiveKitDisconnectCause) => {
      this.onTransportState(state, cause);
    });
    transport.addEventListener('remoteParticipant', ({identity, present}) => {
      if(identity !== this.peerIdentity) {
        this.log.warn('ignoring an unexpected participant in a 1:1 room');
        return;
      }

      this.onPeerPresence(present);
    });
    transport.addEventListener('remoteTrack', (info: LiveKitRemoteTrackInfo) => this.onRemoteTrack(info));
    transport.addEventListener('remoteTrackRemoved', ({identity, source}) => {
      if(identity === this.peerIdentity) {
        this.dropRemoteTrack(source);
      }
    });
    transport.addEventListener('remoteTrackMuted', ({identity, source, muted}) => {
      const entry = identity === this.peerIdentity ? this.remoteTracks.get(source) : undefined;
      if(entry) {
        entry.muted = muted;
        this.publishRemoteMediaState();
      }
    });
    transport.addEventListener('encryptionError', (error: Error) => {
      this.dispatchEvent('encryptionError', error);
    });
  }

  private onTransportState(state: LiveKitTransportState, cause?: LiveKitDisconnectCause): void {
    if(this.closed) {
      return;
    }

    switch(state) {
      case 'connecting':
      case 'reconnecting':
        this.setConnectionState('connecting');
        break;
      case 'connected':
        this.refreshConnectionState();
        if(!this.peerPresent) {
          this.startPeerTimer(PEER_JOIN_TIMEOUT_MS);
        }
        break;
      case 'disconnected':
        this.clearPeerTimer();
        if(cause === 'client') {
          this.setConnectionState('closed', cause);
        } else if(cause === 'roomDeleted') {
          this.setConnectionState('roomDeleted', cause);
        } else {
          this.setConnectionState('failed', cause);
        }
        break;
    }
  }

  private onPeerPresence(present: boolean): void {
    this.peerPresent = present;
    if(present) {
      this.clearPeerTimer();
    } else {
      this.startPeerTimer(PEER_GONE_HANGUP_MS);
    }

    this.refreshConnectionState();
  }

  private refreshConnectionState(): void {
    if(this.connectionState === 'failed' || this.connectionState === 'roomDeleted' || this.connectionState === 'closed') {
      return;
    }

    this.setConnectionState(this.transport.state === 'connected' && this.peerPresent ? 'connected' : 'connecting');
  }

  private setConnectionState(state: PhoneCallConnectionState, cause?: LiveKitDisconnectCause): void {
    if(this.connectionState === state) {
      return;
    }

    this.connectionState = state;
    this.dispatchEvent('connectionState', state, cause);
  }

  private startPeerTimer(timeout: number): void {
    this.clearPeerTimer();
    this.peerTimer = ctx.setTimeout(() => {
      this.peerTimer = undefined;
      if(!this.closed && !this.peerPresent) {
        this.dispatchEvent('peerLost');
      }
    }, timeout);
  }

  private clearPeerTimer(): void {
    if(this.peerTimer !== undefined) {
      ctx.clearTimeout(this.peerTimer);
      this.peerTimer = undefined;
    }
  }

  private onRemoteTrack(info: LiveKitRemoteTrackInfo): void {
    if(info.identity !== this.peerIdentity) {
      return;
    }

    if(info.source === 'screenAudio') {
      return;
    }

    this.remoteTracks.set(info.source, {track: info.track, muted: info.muted});
    const stream: MediaStream = new MediaStream([info.track]);
    switch(info.source) {
      case 'microphone':
        this.streams.audio = stream;
        this.audioElement.srcObject = stream;
        this.audioElement.muted = false;
        safePlay(this.audioElement);
        info.track.addEventListener('unmute', () => {
          if(this.audioElement.srcObject === stream) {
            safePlay(this.audioElement);
          }
        }, {once: true});
        break;
      case 'camera':
        this.streams.video = stream;
        break;
      case 'screen':
        this.streams.presentation = stream;
        break;
    }

    this.publishRemoteMediaState();
  }

  private dropRemoteTrack(source: LiveKitMediaSource): void {
    if(!this.remoteTracks.delete(source)) {
      return;
    }

    switch(source) {
      case 'microphone':
        this.streams.audio = undefined;
        this.audioElement.srcObject = null;
        break;
      case 'camera':
        this.streams.video = undefined;
        break;
      case 'screen':
        this.streams.presentation = undefined;
        break;
    }

    this.publishRemoteMediaState();
  }

  /** Mute, camera and screen state come from track presence and mute flags: there is no data channel (G7). */
  private publishRemoteMediaState(): void {
    const active = (source: LiveKitMediaSource): boolean => {
      const entry = this.remoteTracks.get(source);
      return !!entry && !entry.muted;
    };

    this.remoteMediaState = {
      isBatteryLow: false,
      videoRotation: 0,
      isMuted: !active('microphone'),
      videoState: active('camera') ? 'active' : 'inactive',
      screencastState: active('screen') ? 'active' : 'inactive'
    };
    this.dispatchEvent('remoteMediaState', this.remoteMediaState);
  }

  private getOwn(kind: PhoneCallOwnKind): MediaStream | undefined {
    return this.streams[kind === 'audio' ? 'ownAudio' : kind === 'video' ? 'ownVideo' : 'ownPresentation'];
  }

  private setOwn(kind: PhoneCallOwnKind, stream: MediaStream | undefined): void {
    this.streams[kind === 'audio' ? 'ownAudio' : kind === 'video' ? 'ownVideo' : 'ownPresentation'] = stream;
  }
}
