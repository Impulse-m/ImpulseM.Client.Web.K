/*
 * 1-on-1 phone call. CallInstance owns the call lifecycle (DH key exchange,
 * accept/confirm, hang-up) and hands the media to PhoneCallSession, which runs
 * it over LiveKit. The server mints the LiveKit coordinates for the call
 * (`phoneCall.custom_parameters`); the media is end-to-end encrypted with a key
 * derived from the call's DH auth key (see callMediaKey.ts), so the emoji
 * fingerprint shown to the user attests the media as well.
 */

import ctx from '@environment/ctx';
import assumeType from '@helpers/assumeType';
import safeAssign from '@helpers/object/safeAssign';
import {PhoneCall, PhoneCallDiscardReason, PhoneCallProtocol} from '@layer';
import {emojiFromCodePoints} from '@vendor/emoji';
import type {CallId} from '@appManagers/appCallsManager';
import type {AppManagers} from '@lib/managers';
import {logger} from '@lib/logger';
import apiManagerProxy from '@lib/apiManagerProxy';
import {toastNew} from '@components/toast';
import CallInstanceBase from '@lib/calls/callInstanceBase';
import getAudioConstraints from '@lib/calls/helpers/getAudioConstraints';
import {getStreamTrack, getUserStream, stopStream, StreamType} from '@lib/calls/helpers/getUserStream';
import shouldMirrorVideoTrack from '@lib/calls/helpers/shouldMirrorVideoTrack';
import CALL_STATE from '@lib/calls/callState';
import {CALL_DISCARD_TEARDOWN_CAP_MS, GROUP_CALL_AMPLITUDE_ANALYSE_INTERVAL_MS} from '@lib/calls/constants';
import getCallProtocol from '@lib/calls/livekit/getCallProtocol';
import {callMediaKeyMaterial} from '@lib/calls/livekit/callMediaKey';
import {LiveKitE2eeUnsupportedError} from '@lib/calls/livekit/liveKitErrors';
import {LiveKitParamsError, parseLiveKitJoinParams, phoneCallRoomName} from '@lib/calls/livekit/liveKitJoinParams';
import LiveKitTransport, {assertLiveKitE2eeSupported} from '@lib/calls/livekit/liveKitTransport';
import PhoneCallSession, {
  readPhoneCallTimeouts,
  PhoneCallConnectionState,
  PhoneCallOwnKind,
  RemoteMediaState
} from '@lib/calls/livekit/phoneCallSession';
import StreamManager from '@lib/calls/streamManager';
import {CallMediaState, DiffieHellmanInfo} from '@lib/calls/types';

type HangUpReason = Parameters<CallInstance['hangUp']>[0];

// An update emitted by the media session and routed back into the UI.
type Update =
  {'@type': 'updatePhoneCallConnectionState', connectionState: PhoneCallConnectionState} |
  ({'@type': 'updatePhoneCallMediaState'} & RemoteMediaState);

export default class CallInstance extends CallInstanceBase<{
  state: (state: CALL_STATE) => void,
  id: (id: CallId, prevId: CallId) => void,
  muted: (muted: boolean) => void,
  mediaState: (mediaState: CallMediaState) => void,
  acceptCallOverride: (accept: () => Promise<void>) => Promise<void>,
}> {
  public dh: Partial<DiffieHellmanInfo.a & DiffieHellmanInfo.b>;
  public id: CallId;
  public call: PhoneCall;
  public interlocutorUserId: UserId;
  public protocol: PhoneCallProtocol;
  public isOutgoing: boolean;
  public encryptionKey: Uint8Array;
  // Guards the peer-g_a verification in CallsController: it spans two awaits, and
  // without a flag a second (forged) `phoneCall` update could race through them.
  public isVerifyingPeerG_a: boolean;

  public createdParticipantEntries: boolean;
  public release: () => Promise<void>;
  public _connectionState: CALL_STATE;

  public createdAt: number;
  public connectedAt: number;
  public discardReason: PhoneCallDiscardReason;

  // Kept only to satisfy CallInstanceBase (its cleanup() stops it); the media
  // session owns the actual streams and tracks.
  public streamManager: StreamManager;

  public wasTryingToJoin: boolean;

  private managers: AppManagers;
  private hangUpTimeout: number;
  private hangUpStarted = false;
  private awaitingDiscard = false;

  private joined: boolean;
  private sessionState: PhoneCallConnectionState | undefined;
  private outputMediaState: CallMediaState;
  private videoElements: Map<CallMediaState['type'], HTMLVideoElement>;

  private getEmojisFingerprintPromise: Promise<CallInstance['emojisFingerprint']>;
  private emojisFingerprint: [string, string, string, string];

  // The LiveKit media session; undefined until joinCall, cleared by stopPhoneCall.
  private session: PhoneCallSession | undefined;
  private facingMode: VideoFacingModeEnum | undefined;

  // Our own captures live in the session, outside StreamManager, so device swaps
  // share the base class generation/queue but commit into the live session.
  // Acquisitions may overlap; track replacement is serialized per kind.
  private async replaceSessionInputDevice(
    kind: 'audio' | 'video',
    constraints: MediaStreamConstraints
  ): Promise<boolean> {
    const initialSession = this.session;
    if(!initialSession || (kind === 'audio' ? this.isMuted : !this.isSharingVideo)) return true;

    return this.runInputDeviceSwap({
      kind,
      constraints,
      acquisitionFailureLogLevel: 'warn',
      release: (stream) => stopStream(stream),
      shouldAbandon: (site, generation) => {
        if(site === 'acquired') {
          if(this.session !== initialSession || this.isClosing) return true;
          if(!this.isMediaDeviceChangeCurrent(kind, generation) || (kind === 'audio' && this.isMuted)) return false;
          return undefined;
        }
        if(site === 'queued') {
          if(!this.isMediaDeviceChangeCurrent(kind, generation)) return false;
          if(this.session !== initialSession || this.isClosing) return true;
          if(kind === 'audio' && this.isMuted) return false;
          return undefined;
        }
        if(site === 'failed') {
          if(!this.isMediaDeviceChangeCurrent(kind, generation)) return false;
          if(this.session !== initialSession || this.isClosing) return true;
          return undefined;
        }
        // 'swapped': a replaced/closed call must never be rolled back into.
        if(this.session !== initialSession || this.isClosing) return true;
        if(!this.isMediaDeviceChangeCurrent(kind, generation)) return false;
        return undefined;
      },
      resolveSwap: (newTrack) => {
        const streams = initialSession.getStreams();
        const oldStream = kind === 'audio' ? streams.ownAudio : streams.ownVideo;
        const oldTrack = oldStream?.getTracks().find((track) => track.kind === kind);
        if(!oldTrack) return undefined;
        return {
          oldTrack,
          swap: () => initialSession.replaceTrack({kind, track: newTrack}),
          rollback: async() => {
            // Only restore a session that is still live and still sends the old stream.
            const current = initialSession.getStreams();
            if(this.session === initialSession && !this.isClosing && (kind === 'audio' ? current.ownAudio : current.ownVideo) === oldStream) {
              await initialSession.replaceTrack({kind, track: oldTrack});
            }
          }
        };
      },
      // A rejected replaceTrack leaves the old track in place per spec —
      // compensating would only double the churn.
      rollbackOnSwapFailure: false,
      getPendingAudioEnabled: () => !this.isMuted,
      commit: (newStream) => {
        initialSession.adoptOwnStream({kind, stream: newStream});
        if(kind === 'video') {
          const inputElement = this.videoElements.get('input');
          if(inputElement) inputElement.srcObject = newStream;
        }

        this.updateStreams();
      }
    });
  }

  public setInputVideoDeviceId(deviceId: string): Promise<boolean> {
    return this.replaceSessionInputDevice('video', {
      video: deviceId ? {deviceId: {exact: deviceId}} : true
    });
  }

  public setInputAudioDeviceId(deviceId: string): Promise<boolean> {
    return this.replaceSessionInputDevice('audio', {
      audio: getAudioConstraints(deviceId)
    });
  }

  protected getOutputDeviceElements(): Iterable<HTMLMediaElement> {
    const elements = [...super.getOutputDeviceElements()];
    if(this.session?.audioElement) elements.push(this.session.audioElement);
    return elements;
  }

  constructor(options: {
    isOutgoing: boolean,
    interlocutorUserId: UserId,
    managers: CallInstance['managers'],
    protocol?: PhoneCallProtocol
  }) {
    super();

    this.log = logger('CALL');

    if(!this.protocol) {
      this.protocol = getCallProtocol();
    }

    safeAssign(this, options);

    this.createdAt = performance.now();
    this.joined = false;
    this.videoElements = new Map();
    this.streamManager = new StreamManager(GROUP_CALL_AMPLITUDE_ANALYSE_INTERVAL_MS);

    this.addEventListener('state', (state) => {
      this.log('state', CALL_STATE[state]);

      if(state === CALL_STATE.CLOSED) {
        this.cleanup();
      }
    });
  }

  get connectionState() {
    if(this._connectionState !== undefined) {
      return this._connectionState;
    }

    switch(this.sessionState) {
      case 'connected':
        return CALL_STATE.CONNECTED;
      case 'failed':
      case 'roomDeleted':
      case 'closed':
        return CALL_STATE.CLOSED;
      default:
        return CALL_STATE.CONNECTING;
    }
  }

  get sortIndex() {
    const connectionState = this.connectionState;
    const state = CALL_STATE.CLOSED - connectionState + 1;
    let index = state * 10000000000000;
    index += 2147483647000 - (connectionState === CALL_STATE.PENDING && this.isOutgoing ? 0 : this.createdAt);
    return index;
  }

  // The P2P engine owns the RTCPeerConnection — there is no LocalConferenceDescription.
  // Media is acquired by the session; skip CallInstanceBase's stream pre-prompt.
  public requestInputSource() {
    return Promise.resolve();
  }

  public getVideoElement(type: CallMediaState['type']) {
    const streams = this.getStreams();
    if(!streams) {
      return undefined;
    }

    const stream = type === 'input' ?
      (this.isSharingScreen ? streams.ownPresentation : streams.ownVideo) :
      (streams.presentation || streams.video);
    if(!stream) {
      return undefined;
    }

    let element = this.videoElements.get(type);
    if(!element) {
      element = document.createElement('video');
      element.autoplay = true;
      element.muted = true;
      element.setAttribute('playsinline', 'true');
      // Mirror ONLY our own self-view (`type === 'input'`), never the remote
      // peer's video — same rule as callInstanceBase.tryAddTrack and every
      // other client (iOS/tgcalls, FaceTime, …). The flip is a local "looking
      // in a mirror" convenience; the wire carries un-mirrored frames, so the
      // peer sees us as in real life. Mirroring their feed would invert any
      // text they hold up. Rear-facing own camera (`facingMode === 'environment'`)
      // stays un-mirrored — handled by shouldMirrorVideoTrack.
      const track = stream.getVideoTracks()[0];
      if(type === 'input' && shouldMirrorVideoTrack(track)) {
        element.classList.add('call-video-mirror');
      }
      this.videoElements.set(type, element);
    }

    if(element.srcObject !== stream) {
      element.srcObject = stream;
    }

    return element;
  }

  public toggleScreenSharing() {
    return this.toggleStream('presentation').then(() => {
      this.dispatchEvent('mediaState', this.getMediaState('input'));
    });
  }

  public toggleVideoSharing() {
    return this.toggleStream('video').then(() => {
      this.dispatchEvent('mediaState', this.getMediaState('input'));
    });
  }

  private getOwnTrackEnabled(streamType: StreamType) {
    return !!this.session?.isOwnActive(streamType);
  }

  public getMediaState(type: CallMediaState['type']): CallMediaState {
    if(type === 'output') {
      return this.outputMediaState;
    }

    return {
      '@type': 'MediaState',
      'type': 'input',
      'muted': this.isMuted,
      'lowBattery': false,
      'screencastState': this.isSharingScreen ? 'active' : 'inactive',
      'videoRotation': 0,
      'videoState': this.isSharingVideo ? 'active' : 'inactive'
    };
  }

  public setMediaState(mediaState: CallMediaState) {
    this.outputMediaState = mediaState;
    this.dispatchEvent('mediaState', mediaState);
  }

  public get isSharingVideo() {
    return this.getOwnTrackEnabled('video');
  }

  public get isSharingAudio() {
    return this.getOwnTrackEnabled('audio');
  }

  public get isSharingScreen() {
    return this.getOwnTrackEnabled('presentation');
  }

  public get isMuted() {
    return !this.getOwnTrackEnabled('audio');
  }

  public get isClosing() {
    const {connectionState} = this;
    return connectionState === CALL_STATE.CLOSING || connectionState === CALL_STATE.CLOSED;
  }

  // The reason may be decided when the timer fires: an unanswered incoming
  // call is "missed" — unless another call is still up by then, which makes
  // it "busy".
  public setHangUpTimeout(timeout: number, reason: HangUpReason | (() => HangUpReason)) {
    this.clearHangUpTimeout();
    this.hangUpTimeout = ctx.setTimeout(() => {
      this.hangUpTimeout = undefined;
      void this.hangUp(typeof(reason) === 'function' ? reason() : reason).catch((err) => {
        this.log.error('timed P2P hangup failed', err);
      });
    }, timeout);
  }

  public clearHangUpTimeout() {
    if(this.hangUpTimeout !== undefined) {
      clearTimeout(this.hangUpTimeout);
      this.hangUpTimeout = undefined;
    }
  }

  public setPhoneCall(phoneCall: PhoneCall) {
    this.call = phoneCall;

    const {id} = phoneCall;
    if(this.id !== id) {
      const prevId = this.id;
      this.id = id;
      this.dispatchEvent('id', id, prevId);
    }
  }

  public async acceptCall() {
    if(this.isClosing) return;

    let acceptPromise: Promise<void> | undefined;
    const accept = () => acceptPromise ||= this.acceptCallInternal();
    const overrides = this.dispatchResultableEvent('acceptCallOverride', accept);
    if(overrides.length) {
      // The override owns the transaction. AppImManager uses this to run both
      // leave-current-call and the full accept RPC under one global call-switch
      // reservation; falling through here would accept outside that lock.
      await Promise.all(overrides);
      return;
    }

    await accept();
  }

  private async acceptCallInternal(): Promise<void> {
    if(this.isClosing) return;

    this.overrideConnectionState(CALL_STATE.EXCHANGING_KEYS);

    const call = this.call as PhoneCall.phoneCallRequested;
    const {g_a_hash} = call;
    try {
      const dh = await this.managers.appCallsManager.generateDh();
      if(this.isClosing) return;

      this.dh = { // ! it is correct
        g_a_hash,
        b: dh.a,
        g_b: dh.g_a,
        g_b_hash: dh.g_a_hash,
        p: dh.p
      };

      const acceptedCall = await this.managers.appCallsManager.acceptCall(
        this.id,
        this.protocol,
        this.dh.g_b,
        call.pFlags.video
      );
      if(this.isClosing && acceptedCall._ !== 'phoneCallEmpty' && acceptedCall._ !== 'phoneCallDiscarded') {
        // The server accepted while a local hangup was already closing this
        // instance. Compensate the exact echoed call instead of publishing a
        // late accepted state that can overlap the next global transition.
        await this.managers.appCallsManager.discardCall(
          acceptedCall.id,
          0,
          {_: 'phoneCallDiscardReasonHangup'},
          call.pFlags.video
        );
      }
    } catch(err) {
      this.log.error('accept call error', err);
      if(!this.isClosing) {
        try {
          await this.hangUp('phoneCallDiscardReasonHangup');
        } catch(hangUpError) {
          this.log.error('hang up after accept call error failed', hangUpError);
        }
      }
    }
  }

  public async confirmCall() {
    if(this.isClosing) return;

    // A redelivered phoneCallAccepted (getDifference, a second tab's copy of
    // the update) must not run the exchange twice: the second
    // phone.confirmCall fails on the server and that would drop a call that is
    // already connecting. tdesktop bails the same way (`confirmAcceptedCall`:
    // ExchangingKeys || _instance).
    if(this.encryptionKey || this.joined || this.connectionState === CALL_STATE.EXCHANGING_KEYS) {
      this.log.warn('ignoring a repeated phoneCallAccepted', this.id);
      return;
    }

    const {protocol, id} = this;
    const call = this.call as PhoneCall.phoneCallAccepted;
    const dh = this.dh as DiffieHellmanInfo.a;

    this.overrideConnectionState(CALL_STATE.EXCHANGING_KEYS);

    try {
      // g_b is the peer value relayed by the server; computeKey rejects a
      // degenerate/out-of-range one before it can force the call key.
      const {key, key_fingerprint} = await this.managers.appCallsManager.computeKey(
        call.g_b,
        dh.a,
        dh.p
      );
      if(this.isClosing) return;

      const confirmedCall = await this.managers.appCallsManager.confirmCall(
        id,
        protocol,
        dh.g_a,
        key_fingerprint,
        call.pFlags.video
      );
      if(this.isClosing) {
        if(confirmedCall._ !== 'phoneCallEmpty' && confirmedCall._ !== 'phoneCallDiscarded') {
          await this.managers.appCallsManager.discardCall(
            confirmedCall.id,
            0,
            {_: 'phoneCallDiscardReasonHangup'},
            call.pFlags.video
          );
        }
        return;
      }

      this.encryptionKey = key;
      // the confirm answer carries the LiveKit coordinates; the `phoneCall` update that mirrors it
      // may not have been delivered yet
      this.setPhoneCall(confirmedCall);
      this.joinCall();
    } catch(err) {
      this.log.error('confirmCall error', err);
      if(!this.isClosing) {
        try {
          await this.hangUp('phoneCallDiscardReasonHangup');
        } catch(hangUpError) {
          this.log.error('hang up after confirm call error failed', hangUpError);
        }
      }
    }
  }


  public joinCall() {
    if(this.joined) {
      return;
    }

    this.log('joinCall');
    this.joined = true;

    void Promise.resolve(this.getEmojisFingerprint()).catch((err) => {
      this.log.error('emoji fingerprint derivation failed', err);
    });

    const call = this.call as PhoneCall.phoneCall;
    void this.joinLiveKit(!!call.pFlags.video).catch(async(err) => {
      this.log.error('joinLiveKit error', err);
      if(err instanceof LiveKitParamsError) {
        this.log.error('LiveKit coordinates rejected', err.code);
        toastNew({langPackKey: 'Call.LiveKitUnavailable'});
      } else if(err instanceof LiveKitE2eeUnsupportedError) {
        toastNew({langPackKey: 'Call.E2eeUnsupported'});
      }

      try {
        await this.hangUp('phoneCallDiscardReasonDisconnect');
      } catch(hangUpError) {
        this.log.error('hang up after joinLiveKit failure failed', hangUpError);
      }
    });

    // clear the EXCHANGING_KEYS override → connectionState now follows the media session
    this.overrideConnectionState();
  }

  private async joinLiveKit(shouldStartVideo: boolean): Promise<void> {
    const call = this.call as PhoneCall.phoneCall;
    const params = parseLiveKitJoinParams({
      params: call.custom_parameters,
      expectedRoom: phoneCallRoomName(this.id)
    });

    // Fail before the browser asks for the microphone: a browser that cannot encrypt must not start a call.
    await assertLiveKitE2eeSupported();
    const timeouts = readPhoneCallTimeouts(await this.managers.apiManager.getConfig());
    const e2eeKey = callMediaKeyMaterial(this.encryptionKey);
    if(this.isClosing) {
      return;
    }

    const session = new PhoneCallSession({
      transport: new LiveKitTransport(),
      remoteUserId: this.interlocutorUserId,
      timeouts
    });
    this.session = session;
    this.bindSession(session);
    // The element can appear while the constructor is still applying a saved sink. Queue behind that
    // transaction and read the committed id only then.
    this.applyCurrentOutputDeviceToElement(session.audioElement);

    let audio: MediaStream | undefined;
    let video: MediaStream | undefined;
    try {
      audio = await getUserStream('audio');
      if(shouldStartVideo) {
        this.facingMode = 'user';
        video = await getUserStream('video', this.facingMode);
      }

      if(this.session !== session || this.isClosing) {
        throw new Error('The call closed during media capture');
      }

      await session.start({params, e2eeKey, audio, video});
    } catch(err) {
      stopStream(audio);
      stopStream(video);
      throw err;
    }
  }

  private bindSession(session: PhoneCallSession): void {
    session.addEventListener('connectionState', (state) => {
      if(this.session !== session) {
        return;
      }

      this.onUpdate({'@type': 'updatePhoneCallConnectionState', 'connectionState': state});
    });
    session.addEventListener('remoteMediaState', (state) => {
      if(this.session === session) {
        this.onUpdate({...state, '@type': 'updatePhoneCallMediaState'});
      }
    });
    session.addEventListener('peerLost', () => {
      if(this.session !== session) {
        return;
      }

      this.log.warn('the peer left the call room and did not come back');
      void this.hangUp('phoneCallDiscardReasonDisconnect').catch((err) => {
        this.log.error('hang up after the peer was lost failed', err);
      });
    });
    session.addEventListener('ownTrackEnded', (kind: PhoneCallOwnKind) => {
      void this.toggleStream(kind, false).catch((err) => {
        this.log('track-ended toggle failed', {kind, error: err});
      });
    });
    session.addEventListener('encryptionError', (error) => {
      this.log.warn('call media decryption failed', error);
    });
  }

  private onUpdate(update: Update) {
    switch(update['@type']) {
      case 'updatePhoneCallConnectionState': {
        this.sessionState = update.connectionState;
        if(update.connectionState === 'connected' && this.connectedAt === undefined) {
          this.connectedAt = performance.now();
        }

        // a live session state supersedes the EXCHANGING_KEYS override
        this._connectionState = undefined;

        if(update.connectionState === 'failed') {
          // hangUpStarted, rather than the derived CLOSED state, owns idempotency:
          // a failed transport makes connectionState CLOSED before we
          // have sent phone.discardCall. Let hangUp capture hasVideo, stop every
          // local track and publish the server discard as one transaction.
          void this.hangUp('phoneCallDiscardReasonDisconnect').catch((err) => {
            this.log.error('discard after LiveKit transport failure failed', err);
          });
          break;
        }

        if(update.connectionState === 'roomDeleted') {
          // The server deleted the room because the call is over (discarded on the other side): tear down
          // locally; the discard itself arrives, or has arrived, as a phoneCallDiscarded update.
          void this.hangUp(undefined, true).catch((err) => {
            this.log.error('local teardown after the room was deleted failed', err);
          });
          break;
        }

        this.dispatchEvent('state', this.connectionState);

        if(update.connectionState === 'closed') {
          // A locally-closed transport may arrive after the call is already
          // discarded. Release media idempotently without publishing a second
          // server mutation.
          try {
            this.stopPhoneCall();
          } catch(err) {
            this.log.error('stopPhoneCall error', err);
          }
        }
        break;
      }

      case 'updatePhoneCallMediaState': {
        this.setMediaState({
          '@type': 'MediaState',
          'type': 'output',
          'muted': update.isMuted,
          'lowBattery': update.isBatteryLow,
          'screencastState': update.screencastState === 'active' ? 'active' : 'inactive',
          'videoRotation': update.videoRotation || 0,
          'videoState': update.videoState === 'active' ? 'active' : 'inactive'
        });
        break;
      }
    }
  }

  public getEmojisFingerprint() {
    if(this.emojisFingerprint) return this.emojisFingerprint;
    if(this.getEmojisFingerprintPromise) return this.getEmojisFingerprintPromise;
    const promise = apiManagerProxy.invokeCrypto(
      'get-emojis-fingerprint',
      this.encryptionKey,
      this.dh.g_a
    ).then((codePoints) => {
      if(this.getEmojisFingerprintPromise === promise) {
        this.getEmojisFingerprintPromise = undefined;
      }
      return this.emojisFingerprint = codePoints.map(
        (codePoints) => emojiFromCodePoints(codePoints)
      ) as [string, string, string, string];
    }).catch((err) => {
      // Crypto-worker/proxy failures can be transient. Keep concurrent callers
      // coalesced onto this rejection, but do not poison the SAS for the rest
      // of the call: reopening the popup must be able to retry derivation.
      if(this.getEmojisFingerprintPromise === promise) {
        this.getEmojisFingerprintPromise = undefined;
      }
      throw err;
    });
    this.getEmojisFingerprintPromise = promise;
    return promise;
  }

  public overrideConnectionState(state?: CALL_STATE) {
    this._connectionState = state;
    this.dispatchEvent('state', this.connectionState);
  }

  public get duration() {
    return this.connectedAt !== undefined ? (performance.now() - this.connectedAt) / 1000 | 0 : 0;
  }

  public toggleMuted(): Promise<void> {
    return this.toggleStream('audio').finally(() => {
      this.dispatchEvent('muted', this.isMuted);
      this.dispatchEvent('mediaState', this.getMediaState('input'));
    });
  }

  public async hangUp(
    discardReason?: PhoneCallDiscardReason | Exclude<PhoneCallDiscardReason['_'], PhoneCallDiscardReason.phoneCallDiscardReasonMigrateConferenceCall['_']>,
    discardedByOtherParty?: boolean
  ) {
    if(this.hangUpStarted) {
      return;
    }
    this.hangUpStarted = true;

    discardReason = typeof(discardReason) === 'string' ? {_: discardReason} : discardReason;
    assumeType<PhoneCallDiscardReason>(discardReason);

    this.discardReason = discardReason;
    this.log('hangUp', discardReason);

    const hasVideo = this.isSharingVideo || this.isSharingScreen;

    // tdesktop's order (calls_call.cpp): the call shows as ended and what we capture stops at once, the discard is
    // sent, and only then is the media room dropped -- when the discard settled, or after a cap if it hangs.
    this.awaitingDiscard = !!discardedByOtherParty && !discardReason;
    this.overrideConnectionState(CALL_STATE.CLOSED);
    this.session?.releaseCapture();

    if(!discardReason || discardedByOtherParty) {
      this.closeSession();
      return;
    }

    try {
      await this.sendDiscard({reason: discardReason, hasVideo});
    } finally {
      this.closeSession();
    }
  }

  /** The call ended here because the room was deleted, and the server's phoneCallDiscarded has not arrived yet. */
  public get isAwaitingDiscard(): boolean {
    return this.awaitingDiscard;
  }

  /** Takes in the phoneCallDiscarded that follows a deleted room: its reason, duration and rating flag. No sound, no RPC. */
  public applyLateDiscard(call: PhoneCall.phoneCallDiscarded): void {
    this.awaitingDiscard = false;
    this.setPhoneCall(call);
    this.discardReason ||= call.reason;
  }

  private async sendDiscard(options: {reason: PhoneCallDiscardReason, hasVideo: boolean}): Promise<void> {
    const sent: Promise<void> = Promise.resolve(
      this.managers.appCallsManager.discardCall(this.id, this.duration, options.reason, options.hasVideo)
    );
    let timer: number | undefined;
    const capped: Promise<void> = new Promise<void>((resolve) => {
      timer = ctx.setTimeout(resolve, CALL_DISCARD_TEARDOWN_CAP_MS);
    });
    // past the cap the RPC is no longer awaited, but its failure must still not go unhandled
    sent.catch((err: unknown) => this.log.warn('phone.discardCall failed', err));
    try {
      await Promise.race([sent, capped]);
    } finally {
      ctx.clearTimeout(timer);
    }
  }

  private closeSession(): void {
    try {
      this.stopPhoneCall();
    } catch(err) {
      this.log.error('stopPhoneCall error', err);
    }
  }


  private getStreams() {
    return this.session?.getStreams();
  }

  private updateStreams() {
    if(!this.session) return;

    this.onUpdate({
      ...this.session.getRemoteMediaState(),
      '@type': 'updatePhoneCallMediaState'
    });
  }

  public async switchCameraInput() {
    const session = this.session;
    if(!session || !this.facingMode || !session.isOwnActive('video')) {
      return;
    }

    const nextFacingMode = this.facingMode === 'environment' ? 'user' : 'environment';

    let newStream: MediaStream | undefined;
    try {
      newStream = await getUserStream('video', nextFacingMode);
      const newTrack = getStreamTrack(newStream);
      if(!newTrack || this.session !== session || this.isClosing) {
        stopStream(newStream);
        return;
      }

      await session.replaceTrack({kind: 'video', track: newTrack});
      this.facingMode = nextFacingMode;
      session.adoptOwnStream({kind: 'video', stream: newStream});
      this.updateStreams();
    } catch{
      stopStream(newStream);
      this.log('switch camera failed');
      // Ignore camera switch failures; the previous track stays active.
    }
  }

  private async toggleStream(streamType: StreamType, value: boolean | undefined = undefined) {
    const session = this.session;
    if(!session) return;

    const isActive = session.isOwnActive(streamType);
    const shouldEnable = value === undefined ? !isActive : value;
    if(shouldEnable === isActive) {
      return;
    }

    if(streamType === 'audio') {
      // A mute/unmute action supersedes any microphone picker transaction
      // that acquired or installed a track from the previous capture state.
      this.beginMediaDeviceChange('audio');
    }

    try {
      if(shouldEnable) {
        await this.enableStream(session, streamType);
      } else {
        await this.disableStream(session, streamType);
      }

      this.updateStreams();
    } catch(err) {
      this.log('toggle failed', {
        streamType,
        shouldEnable,
        error: err instanceof Error ? {
          name: err.name,
          message: err.message
        } : String(err)
      });
      throw err;
    }
  }

  private async enableStream(session: PhoneCallSession, streamType: StreamType) {
    const facingMode = streamType === 'video' ? this.facingMode || 'user' : undefined;
    const newStream: MediaStream = await getUserStream(streamType, facingMode);
    const newTrack = getStreamTrack(newStream);
    if(!newTrack) {
      stopStream(newStream);
      throw new Error(`Could not enable ${streamType}: media capture returned no track`);
    }

    // set once the session has taken the capture back and released it itself
    let isReleased = false;
    try {
      // hangUp clears `this.session` and the session only stops streams already
      // registered with it. If hangup wins while the capture is pending, this
      // newly-acquired stream is otherwise orphaned and keeps the capture indicator alive.
      if(this.session !== session || this.isClosing) {
        throw new Error(`Could not enable ${streamType}: call closed during media capture`);
      }

      await session.setOwnMedia({kind: streamType, stream: newStream});
      if(this.session !== session || this.isClosing) {
        throw new Error(`Could not enable ${streamType}: call closed during publishing`);
      }

      if(streamType === 'video') {
        this.facingMode = facingMode;
      }

      if(streamType === 'video' || streamType === 'presentation') {
        // camera and screen are exclusive: the one being enabled replaces the other
        try {
          await this.toggleStream(streamType === 'video' ? 'presentation' : 'video', false);
        } catch(err) {
          try {
            await session.setOwnMedia({kind: streamType, stream: undefined});
            isReleased = true;
          } catch(rollbackError) {
            this.log('exclusive stream rollback failed', {
              streamType,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            });
          }
          throw err;
        }
      }
    } catch(err) {
      if(!isReleased) {
        stopStream(newStream);
      }
      throw err;
    }
  }

  private async disableStream(session: PhoneCallSession, streamType: StreamType) {
    if(streamType === 'audio') {
      // Fail closed before waiting for the network: include a device replacement
      // already handed to the session but not committed.
      const track = getStreamTrack(session.getStreams().ownAudio);
      if(track) track.enabled = false;
      this.pendingInputAudioTracks.forEach((pendingTrack) => {
        pendingTrack.enabled = false;
      });
    }

    await session.setOwnMedia({kind: streamType, stream: undefined});
  }

  private stopPhoneCall() {
    const {session} = this;
    if(!session) return;

    this.session = undefined;
    session.close();
  }
}
