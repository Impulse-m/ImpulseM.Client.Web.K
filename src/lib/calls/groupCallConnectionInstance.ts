import createSerializedQueue from '@helpers/createSerializedQueue';
import {nextRandomUint} from '@helpers/random';
import {DataJSON, InputGroupCall} from '@layer';
import {GroupCallConnectionType, JoinGroupCallJsonPayload} from '@appManagers/appGroupCallsManager';
import {JoinSourceGroup, makeCameraSourceGroups, makeScreenSourceGroups} from '@lib/calls/livekit/groupCallSourceGroups';
import {AppManagers} from '@lib/managers';
import {logger} from '@lib/logger';
import type GroupCallInstance from '@lib/calls/groupCallInstance';
import {groupCallRoomName, parseLiveKitJoinParams} from '@lib/calls/livekit/liveKitJoinParams';
import LiveKitTransport, {LiveKitMediaSource, LiveKitTransportState} from '@lib/calls/livekit/liveKitTransport';
import {parseGroupCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import StreamManager from '@lib/calls/streamManager';
import {toImpulseMSource} from '@lib/calls/utils';

export type GroupCallConnectionOptions = {
  type: Extract<GroupCallConnectionType, 'main'>,
  isMuted?: boolean,
  joinVideo?: boolean,
  rejoin?: boolean,
  /** Addresses the join with this exact call reference instead of the cached id and access hash. */
  callInput?: InputGroupCall
} | {
  type: Extract<GroupCallConnectionType, 'presentation'>
};

export type GroupCallConnectionInstanceOptions = {
  groupCall: GroupCallInstance,
  type: GroupCallConnectionType,
  options: GroupCallConnectionOptions,
  streamManager: StreamManager,
  managers: AppManagers,
  log?: ReturnType<typeof logger>
};


/**
 * One LiveKit connection of a group call: the main one (microphone, camera, everything remote) or the
 * presentation one (our screen share, nothing subscribed). The server decides the media identity from the
 * source we declare when we join; the LiveKit coordinates come back in the join answer.
 */
export default class GroupCallConnectionInstance {
  public readonly transport: LiveKitTransport = new LiveKitTransport();
  public readonly streamManager: StreamManager;
  public readonly type: GroupCallConnectionType;
  public readonly options: GroupCallConnectionOptions;
  /** The source declared to the server, signed like `groupCallParticipant.source`. */
  public sources: {audio?: {source: number}} = {};
  /** True once phone.joinGroupCall has accepted this media source server-side. */
  public joinAccepted = false;
  /** Exact call reference accepted by phone.joinGroupCall, retained for rollback. */
  public acceptedCallInput?: InputGroupCall;

  private readonly groupCall: GroupCallInstance;
  private readonly managers: AppManagers;
  private readonly log: ReturnType<typeof logger>;
  private readonly mediaTail = createSerializedQueue();


  constructor(options: GroupCallConnectionInstanceOptions) {
    this.groupCall = options.groupCall;
    this.type = options.type;
    this.options = options.options;
    this.streamManager = options.streamManager;
    this.managers = options.managers;
    this.log = options.log || logger('CALL-CONNECTION');
  }


  public get transportState(): LiveKitTransportState {
    return this.transport.state;
  }

  /** Declares a fresh source to the server, connects with the answer's coordinates, publishes what we capture. */
  public async join(): Promise<void> {
    const {groupCall, transport} = this;
    const ssrc: number = this.nextSsrc();
    this.sources = {audio: {source: toImpulseMSource(ssrc)}};
    const sourceGroups: JoinSourceGroup[] = (this.type === 'main' ? makeCameraSourceGroups : makeScreenSourceGroups)({
      draw: () => nextRandomUint(32),
      taken: [ssrc, ...(this.groupCall.connections.main ? [this.groupCall.connections.main.sources.audio?.source >>> 0] : [])]
    });
    const payload: JoinGroupCallJsonPayload = {ssrc, 'ssrc-groups': sourceGroups};
    const params: DataJSON = {_: 'dataJSON', data: JSON.stringify(payload)};

    const update = await this.managers.appGroupCallsManager.joinGroupCall(groupCall.id, params, this.options);

    // Store the accepted identity before parsing the coordinates or connecting: any of those can throw
    // after the server has already installed our participant and source.
    this.acceptedCallInput = update.acceptedCallInput;
    this.joinAccepted = true;

    // Take the access_hash the join actually returned. A cached call object left over from an earlier
    // session keeps a stale hash otherwise (a rejoin mints a NEW one) and every request built from it
    // fails GROUPCALL_INVALID while the media keeps flowing.
    if(update.resolvedGroupCall) {
      groupCall.groupCall = update.resolvedGroupCall;
    }

    const cachedCall = groupCall.groupCall;
    if(update.resolvedAccessHash != null && cachedCall?._ === 'groupCall') {
      cachedCall.access_hash = update.resolvedAccessHash as typeof cachedCall.access_hash;
    }

    const coordinates = parseLiveKitJoinParams({
      params: update.params,
      expectedRoom: groupCallRoomName(groupCall.id)
    });

    await transport.connect(coordinates, {
      autoSubscribe: this.type === 'main',
      // our own screen share comes back through the main room under the `.p` identity of the same peer
      shouldSubscribe: (identity: string) => !parseGroupCallIdentity(identity)?.isPresentation
    });

    if(this.options.type === 'main') {
      await this.publishInitialMedia(this.options);
    }
  }

  /**
   * Keeps the sent microphone in step with the local mute state. `track` is a capture that just arrived (the
   * microphone requested on the first unmute): it replaces what is sent, or is published (silent while
   * muted) when nothing is. Without `track` the stream manager's microphone is used, and only to open it.
   */
  public syncMicrophone(muted: boolean, track?: MediaStreamTrack): Promise<void> {
    return this.mediaTail.enqueue(async() => {
      if(this.transport.state !== 'connected') {
        return;
      }

      const capture: MediaStreamTrack | undefined = track ?? this.streamManager.inputStream.getAudioTracks()[0];
      if(this.transport.isPublished('microphone')) {
        if(capture && this.transport.getPublishedTrack('microphone') !== capture) {
          await this.transport.replace({source: 'microphone', track: capture});
        }

        await this.transport.setMuted({source: 'microphone', muted});
        return;
      }

      if(capture && (track || !muted)) {
        await this.publishIfAllowed({source: 'microphone', track: capture, muted});
      }
    });
  }

  /**
   * Hands a camera or screen capture to the transport: the camera on the main connection, the screen (with
   * its audio, when shared) on the presentation one. The capture is shown in its own tile under `main` /
   * `presentation`.
   */
  public async addInputVideoStream(stream: MediaStream): Promise<void> {
    this.groupCall.saveInputVideoStream(stream, this.type);
    this.streamManager.addStream(stream, 'input');
    if(this.type === 'presentation') {
      await this.publishScreen(stream);
      return;
    }

    const camera: MediaStreamTrack = stream.getVideoTracks()[0];
    if(!await this.publishCamera(camera)) {
      throw new Error('Camera sharing is not permitted for this participant');
    }
  }

  public publishCamera(track: MediaStreamTrack): Promise<boolean> {
    return this.mediaTail.enqueue(() => this.publishIfAllowed({source: 'camera', track, muted: false}));
  }

  public unpublish(source: LiveKitMediaSource): Promise<void> {
    return this.mediaTail.enqueue(async() => {
      if(this.transport.isPublished(source)) {
        await this.transport.unpublish(source);
      }
    });
  }

  /** Publishes the screen capture (and its audio, when the browser shared any) on the presentation connection. */
  public publishScreen(stream: MediaStream): Promise<void> {
    return this.mediaTail.enqueue(async() => {
      const video: MediaStreamTrack | undefined = stream.getVideoTracks()[0];
      if(!video || !await this.publishIfAllowed({source: 'screen', track: video, muted: false})) {
        throw new Error('Screen sharing is not permitted for this participant');
      }

      const audio: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
      if(audio) {
        await this.publishIfAllowed({source: 'screenAudio', track: audio, muted: false});
      }
    });
  }

  /** Swaps the track sent for `source` while it is `oldTrack` (a device change); false when it is not sent. */
  public async replaceTrack(options: {
    source: LiveKitMediaSource,
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  }): Promise<boolean> {
    return this.mediaTail.enqueue(async() => {
      if(this.transport.getPublishedTrack(options.source) !== options.oldTrack) {
        return false;
      }

      await this.transport.replace({source: options.source, track: options.newTrack});
      return true;
    });
  }

  public closeConnection(): void {
    this.transport.disconnect();
  }

  /** The capture stops first: closing the transport is what moves the call to closed and plays its end tone. */
  public closeConnectionAndStream(stopStream: boolean): void {
    stopStream && this.streamManager.stop();
    this.closeConnection();
  }


  private async publishInitialMedia(options: Extract<GroupCallConnectionOptions, {type: 'main'}>): Promise<void> {
    await this.mediaTail.enqueue(async() => {
      const audio: MediaStreamTrack | undefined = this.streamManager.inputStream.getAudioTracks()[0];
      if(audio) {
        // a muted join publishes the microphone silent; it is skipped when the token forbids publishing
        await this.publishIfAllowed({source: 'microphone', track: audio, muted: !!options.isMuted || !audio.enabled});
      }

      const video: MediaStreamTrack | undefined = this.streamManager.inputStream.getVideoTracks()[0];
      if(video && options.joinVideo) {
        await this.publishIfAllowed({source: 'camera', track: video, muted: false});
      }
    });
  }

  private async publishIfAllowed(options: {
    source: LiveKitMediaSource,
    track: MediaStreamTrack | undefined,
    muted: boolean
  }): Promise<boolean> {
    const {source, track, muted} = options;
    if(!track) {
      return false;
    }

    const permission = this.transport.getPublishPermission();
    if(permission && (!permission.canPublish || !permission.sources.includes(source))) {
      this.log('not publishing %s: the token does not allow it', source);
      return false;
    }

    await this.transport.publish({source, track});
    if(muted) {
      await this.transport.setMuted({source, muted: true});
    }

    return true;
  }

  private nextSsrc(): number {
    const mainSource: number | undefined = this.groupCall.connections.main?.sources.audio?.source;
    for(;;) {
      const ssrc: number = nextRandomUint(32) || 1;
      if(toImpulseMSource(ssrc) !== mainSource) {
        return ssrc;
      }
    }
  }
}
