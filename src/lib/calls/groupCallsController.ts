import getGroupCallAudioAsset from '@components/groupCall/getAudioAsset';
import {DEBUG, MOUNT_CLASS_TO} from '@config/debug';
import EventListenerBase from '@helpers/eventListenerBase';
import noop from '@helpers/noop';
import {GroupCallId, GroupCallConnectionType} from '@appManagers/appGroupCallsManager';
import {AppManagers} from '@lib/managers';
import {logger} from '@lib/logger';
import rootScope from '@lib/rootScope';
import GroupCallInstance from '@lib/calls/groupCallInstance';
import type GroupCallConnectionInstance from '@lib/calls/groupCallConnectionInstance';
import GROUP_CALL_STATE from '@lib/calls/groupCallState';
import ConferenceUnsupportedError from '@lib/calls/conferenceUnsupportedError';
import createMainStreamManager from '@lib/calls/helpers/createMainStreamManager';
import type {LiveKitDisconnectCause} from '@lib/calls/livekit/liveKitErrors';
import StreamManager from '@lib/calls/streamManager';
import type {InputGroupCall, Updates} from '@layer';
import {toastNew} from '@components/toast';

const IS_MUTED = true;

// A connection that stayed up this long is healthy: a failure after it gets its one rejoin again.
const REJOIN_RESET_MS = 60000;

export type ConferenceJoinOptions = {
  input: InputGroupCall;
  expectedCanonicalInput?: InputGroupCall.inputGroupCall;
  selfUserId: bigint;
  chatId?: ChatId;
  muted?: boolean;
  joinVideo?: boolean;
  transitionGeneration?: number;
  outboundMediaRecoveryUsed?: boolean;
};

export type ConferenceStartOptions = {
  chatId?: ChatId;
  selfUserId: bigint;
  muted?: boolean;
  joinVideo?: boolean;
};


export class GroupCallsController extends EventListenerBase<{
  instance: (instance: GroupCallInstance, isRecovery?: boolean) => void
}> {
  private audioAsset: ReturnType<typeof getGroupCallAudioAsset>;
  private log: ReturnType<typeof logger>;
  private currentGroupCall: GroupCallInstance;
  private managers: AppManagers;
  private rejoinsUsed = new WeakMap<GroupCallInstance, number>();
  private connectedAt = new WeakMap<GroupCallInstance, number>();

  public construct(managers: AppManagers) {
    this.managers = managers;
    this.audioAsset = getGroupCallAudioAsset();
    this.log = logger('GCC');

    rootScope.addEventListener('group_call_update', (groupCall) => {
      const {currentGroupCall} = this;
      if(currentGroupCall?.id === groupCall.id) {
        currentGroupCall.groupCall = groupCall;

        if(groupCall._ === 'groupCallDiscarded') {
          void currentGroupCall.hangUp(false, false, true).catch((err) => {
            this.log.error('cleanup after discarded group call failed', err);
          });
        }
      }
    });

    rootScope.addEventListener('group_call_participant', ({groupCallId, participant}) => {
      const {currentGroupCall} = this;
      if(currentGroupCall?.id === groupCallId) {
        currentGroupCall.onParticipantUpdate(participant);
      }
    });

    // A closed tab used to linger as a ghost participant until the server timed
    // it out. The SharedWorker outlives this tab, so a leave posted from
    // pagehide reaches the server. Best-effort by design: not awaited, no UI
    // teardown (the page is going away), and never a discard. LiveKit closes
    // its own sockets on page leave.
    if(typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.leaveOnPageHide());
    }
  }

  private leaveOnPageHide(): void {
    const instance = this.currentGroupCall;
    if(!instance) return;
    const target = this.resolveLeaveTarget(instance, instance.connections.main);
    if(!target) return;
    void this.managers.appGroupCallsManager.leaveGroupCall(target.input, target.source).catch(noop);
  }

  // The server-side identity + audio source a leave for `instance` is addressed
  // with — the reference phone.joinGroupCall accepted when there is one.
  private resolveLeaveTarget(
    instance: GroupCallInstance,
    connectionInstance: GroupCallConnectionInstance | undefined
  ): {input: InputGroupCall, source: number} | undefined {
    const input = connectionInstance?.acceptedCallInput ?? instance.toInputGroupCall();
    if(!input) return;
    const source = connectionInstance?.sources.audio?.source;
    return {input, source: typeof source === 'number' ? source : 0};
  }

  get groupCall() {
    return this.currentGroupCall;
  }

  public setCurrentGroupCall(groupCall: GroupCallInstance, isRecovery = false) {
    this.currentGroupCall = groupCall;

    if(groupCall) {
      this.dispatchEvent('instance', groupCall, isRecovery);
    }
  }

  public startConnectingSound() {
    this.stopConnectingSound();
    this.audioAsset.playWithTimeout({name: 'connect', loop: true}, 2500);
  }

  public stopConnectingSound() {
    this.audioAsset.stop();
    this.audioAsset.cancelDelayedPlay();
  }

  private hangUpAfterTransportFailure(instance: GroupCallInstance): void {
    void instance.hangUp().catch((err) => {
      this.log.warn('group call leave after transport failure failed', err);
    });
  }

  public async joinGroupCall(chatId: ChatId, groupCallId: GroupCallId, muted = IS_MUTED, rejoin?: boolean, joinVideo?: boolean) {
    this.audioAsset.createAudio();

    this.log(`joinGroupCall chatId=${chatId} id=${groupCallId} muted=${muted} rejoin=${rejoin}`);

    let streamManager: StreamManager;
    if(rejoin) {
      if(!this.currentGroupCall?.connections.main) {
        throw new Error('Cannot rejoin: there is no active group call');
      }

      streamManager = this.currentGroupCall.connections.main.streamManager;
    } else {
      streamManager = await createMainStreamManager(muted, joinVideo);
    }

    return this.joinGroupCallInternal(chatId, groupCallId, streamManager, muted, rejoin, joinVideo)
    .then(() => {
      // have to refresh participants because of the new connection
      const {currentGroupCall} = this;
      if(!currentGroupCall) return;
      void currentGroupCall.participants.then((participants) => {
        if(this.currentGroupCall !== currentGroupCall || currentGroupCall.state === GROUP_CALL_STATE.CLOSED) {
          return;
        }

        participants.forEach((participant) => {
          if(!participant.pFlags.self) {
            currentGroupCall.onParticipantUpdate(participant);
          }
        });
      }).catch((err) => {
        // The transport join is already accepted. Initial roster hydration is
        // best-effort and will be refreshed by later participant updates, but
        // the worker-proxy rejection still needs an observer.
        this.log.warn('initial group call participant hydration failed', err);
      });
    });
  }

  private async joinGroupCallInternal(chatId: ChatId, groupCallId: GroupCallId, streamManager: StreamManager, muted: boolean, rejoin = false, joinVideo?: boolean) {
    const log = this.log.bindPrefix('joinGroupCallInternal');
    log('start', groupCallId);

    const type: GroupCallConnectionType = 'main';

    let {currentGroupCall} = this;
    let previousConnection: GroupCallConnectionInstance | undefined;
    if(rejoin) {
      // The instance, its capture and its screen share stay; only the main connection is replaced, under a
      // new source and a new token.
      previousConnection = currentGroupCall.connections.main;
      currentGroupCall.resetRemoteMedia();
      log('update currentGroupCall', groupCallId, currentGroupCall);
    } else {
      currentGroupCall = new GroupCallInstance({
        chatId,
        id: groupCallId,
        managers: this.managers
      });
    }

    try {
      if(!rejoin) {
        currentGroupCall.fixSafariAudio();

        currentGroupCall.addEventListener('state', (state) => {
          if(this.currentGroupCall === currentGroupCall && state === GROUP_CALL_STATE.CLOSED) {
            this.setCurrentGroupCall(null);
            this.stopConnectingSound();
            void this.managers.appGroupCallsManager.setRealtimeCall(chatId, groupCallId, false).catch((err) => {
              log.warn('leaving the call lanes failed', err);
            });
            this.audioAsset.play({name: 'end'});
            rootScope.dispatchEvent('chat_update', currentGroupCall.chatId);
          }
        });

        currentGroupCall.groupCall = await this.managers.appGroupCallsManager.getGroupCallFull(groupCallId);
      }

      const connectionInstance = currentGroupCall.createConnectionInstance({
        streamManager,
        type,
        options: {
          type,
          isMuted: muted,
          joinVideo,
          rejoin
        }
      });
      // the replacement is registered, so the old transport closing no longer reads as the call ending
      previousConnection?.closeConnection();
      this.bindMainConnection(currentGroupCall, connectionInstance);

      if(!rejoin) {
        this.setCurrentGroupCall(currentGroupCall);
        log('set currentGroupCall', groupCallId, currentGroupCall);
      }

      this.startConnectingSound();
      await connectionInstance.join();
      if(!rejoin) {
        // The participant row exists once the join is accepted, and the call lane is open to participants only.
        void this.managers.appGroupCallsManager.setRealtimeCall(chatId, groupCallId, true).catch((err) => {
          log.warn('subscribing to the call lanes failed', err);
        });
      }
    } catch(err) {
      // The microphone (and camera) were captured before this join started
      // and nothing owns them yet when it fails here — the instance is not
      // current, so no UI could release them. Undo the whole join instead of
      // leaving the capture live until a reload.
      await this.rollbackFailedJoin({
        instance: currentGroupCall,
        connectionInstance: currentGroupCall.connections.main,
        streamManager
      });
      throw err;
    }
  }

  // The LiveKit connection state drives the call: sound, the joined flag, the UI state, and what a
  // lost connection turns into.
  private bindMainConnection(instance: GroupCallInstance, connection: GroupCallConnectionInstance): void {
    const log = this.log.bindPrefix('transport');
    connection.transport.addEventListener('state', (state, cause) => {
      if(instance.connections.main !== connection) {
        return;
      }

      instance.dispatchEvent('state', instance.state);

      switch(state) {
        case 'connecting':
        case 'reconnecting': {
          this.startConnectingSound();
          break;
        }

        case 'connected': {
          this.stopConnectingSound();
          this.connectedAt.set(instance, performance.now());

          if(!instance.joined) {
            instance.joined = true;
            this.audioAsset.play({name: 'start'});
            void this.managers.appGroupCallsManager.getGroupCallParticipants(instance.id).catch((err) => {
              log.warn('initial group call participant fetch failed', err);
            });
          }

          break;
        }

        case 'disconnected': {
          this.stopConnectingSound();
          void this.onTransportDisconnected(instance, connection, cause).catch((err) => {
            log.error('handling the lost group call connection failed', err);
            this.hangUpAfterTransportFailure(instance);
          });
          break;
        }
      }
    });
  }

  /**
   * What a lost main connection becomes. LiveKit already resumed and re-authenticated on its own before it
   * reports `disconnected`, so what is left is final for that connection:
   * - our own close: nothing;
   * - the same identity connected elsewhere, or the room deleted: the call is over here;
   * - removed from the room: asked whether the server still lists our source; if it does not and our own
   *   row says we left, the call is left, otherwise one rejoin;
   * - anything else (network, an unreachable or refusing server): one rejoin; the second loss leaves.
   */
  private async onTransportDisconnected(
    instance: GroupCallInstance,
    connection: GroupCallConnectionInstance,
    cause: LiveKitDisconnectCause | undefined
  ): Promise<void> {
    if(cause === 'client') {
      return;
    }

    switch(cause) {
      case 'duplicateIdentity': {
        void instance.hangUp(false, false, true).catch((err) => {
          this.log.warn('local teardown after a duplicate identity failed', err);
        });
        return;
      }

      case 'roomDeleted': {
        // Only the server deletes a call's room, and only when it ends the call. Nothing is sent from here (the
        // teardown is local, no leave RPC), so there is no reason to wait for the call's own discard update: that
        // update is applied by the manager whenever it arrives, and finds the call already left.
        if(this.currentGroupCall === instance && instance.connections.main === connection && !instance.isClosing) {
          void instance.hangUp(false, false, true).catch((err) => {
            this.log.warn('local teardown after the room was deleted failed', err);
          });
        }
        return;
      }

      case 'removed': {
        if(await this.isRemovedFromCall(instance, connection)) {
          this.hangUpAfterTransportFailure(instance);
          return;
        }

        break;
      }
    }

    await this.rejoinOnce(instance, connection, cause);
  }

  private async isRemovedFromCall(instance: GroupCallInstance, connection: GroupCallConnectionInstance): Promise<boolean> {
    const input = connection.acceptedCallInput ?? instance.toInputGroupCall();
    const source = connection.sources.audio?.source;
    if(!input || source === undefined) {
      return false;
    }

    try {
      const registered = await this.managers.appGroupCallsManager.checkGroupCall(input, [source]);
      return !registered.includes(source) && !!instance.participant?.pFlags.left;
    } catch(err) {
      // Not knowing is not a reason to leave: the rejoin below finds out.
      this.log.warn('checking the group call source failed', err);
      return false;
    }
  }

  private async rejoinOnce(
    instance: GroupCallInstance,
    connection: GroupCallConnectionInstance,
    cause: LiveKitDisconnectCause | undefined
  ): Promise<void> {
    if(this.currentGroupCall !== instance || instance.connections.main !== connection || instance.isClosing) {
      return;
    }

    const connectedAt = this.connectedAt.get(instance);
    if(connectedAt !== undefined && performance.now() - connectedAt >= REJOIN_RESET_MS) {
      this.rejoinsUsed.delete(instance);
    }

    const used = this.rejoinsUsed.get(instance) ?? 0;
    if(used >= 1) {
      this.log.warn('the group call connection was lost again, leaving', cause);
      this.hangUpAfterTransportFailure(instance);
      return;
    }

    this.rejoinsUsed.set(instance, used + 1);
    this.log.warn('the group call connection was lost, rejoining', cause);
    await this.joinGroupCall(instance.chatId, instance.id, instance.isMuted, true, instance.isSharingVideo);
  }

  // Undo everything a failed join built — close media, release the
  // microphone/camera, drop the instance — and compensate a
  // phone.joinGroupCall the server already accepted (it may have installed our
  // participant and source even though reading the coordinates or connecting
  // failed afterwards). Compensates exactly once; teardown first keeps capture
  // closed while the best-effort leave is in flight.
  private async rollbackFailedJoin(opts: {
    instance?: GroupCallInstance,
    connectionInstance?: GroupCallConnectionInstance,
    streamManager: StreamManager
  }): Promise<void> {
    const {instance, connectionInstance, streamManager} = opts;
    this.stopConnectingSound();
    if(!instance) {
      streamManager.stop();
      return;
    }

    const connectionTypes = Object.keys(instance.connections) as GroupCallConnectionType[];
    for(const type of connectionTypes) {
      instance.connections[type].closeConnectionAndStream(true);
    }
    // A join that failed before createConnectionInstance has no connection to
    // stop the stream through.
    if(!connectionTypes.length) streamManager.stop();
    instance.markHungUp();
    if(this.currentGroupCall === instance) {
      instance.dispatchEvent('state', GROUP_CALL_STATE.CLOSED);
      if(this.currentGroupCall === instance) this.setCurrentGroupCall(null);
    }
    instance.cleanup();

    if(!connectionInstance?.joinAccepted) return;
    const target = this.resolveLeaveTarget(instance, connectionInstance);
    if(!target) return;
    try {
      await this.managers.appGroupCallsManager.leaveGroupCall(target.input, target.source);
    } catch(leaveError) {
      this.log.warn('group call post-accept rollback failed', leaveError);
    }
  }

  // ===== Conference calls =====
  //
  // End-to-end encrypted conference calls are not offered by this backend (it answers METHOD_INVALID) and
  // the media layer is LiveKit. The entry points refuse before any capture or request.
  public startConference(_options: ConferenceStartOptions): Promise<GroupCallInstance> {
    return this.refuseConference();
  }

  public joinConference(_options: ConferenceJoinOptions): Promise<GroupCallInstance> {
    return this.refuseConference();
  }

  private refuseConference(): Promise<never> {
    toastNew({langPackKey: 'ConferenceCall.Unsupported'});
    return Promise.reject(new ConferenceUnsupportedError());
  }

  public inviteConferenceParticipant(userId: UserId, video?: boolean): Promise<Updates> {
    const call = this.currentGroupCall?.toInputGroupCall();
    if(!call || !this.currentGroupCall.e2e) {
      return Promise.reject(new Error('No active conference call'));
    }
    return this.managers.appCallsManager.inviteConferenceCallParticipant(call, userId, video);
  }

  public declineConferenceInvite(messageId: number): Promise<Updates> {
    return this.managers.appCallsManager.declineConferenceCallInvite(messageId);
  }
}

const groupCallsController = new GroupCallsController();
DEBUG && (MOUNT_CLASS_TO.groupCallController = groupCallsController);
export default groupCallsController;
