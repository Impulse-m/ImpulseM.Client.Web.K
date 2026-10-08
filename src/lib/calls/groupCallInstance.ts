import type {AppGroupCallsManager, GroupCallConnectionType, GroupCallId, GroupCallOutputSource} from '@appManagers/appGroupCallsManager';
import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import safeAssign from '@helpers/object/safeAssign';
import pause from '@helpers/schedulers/pause';
import throttle from '@helpers/schedulers/throttle';
import {GroupCall, GroupCallParticipant, GroupCallParticipantVideo, InputGroupCall} from '@layer';
import {logger} from '@lib/logger';
import {NULL_PEER_ID} from '@appManagers/constants';
import rootScope from '@lib/rootScope';
import CallInstanceBase from '@lib/calls/callInstanceBase';
import GroupCallConnectionInstance, {GroupCallConnectionOptions} from '@lib/calls/groupCallConnectionInstance';
import GROUP_CALL_STATE from '@lib/calls/groupCallState';
import getScreenConstraints from '@lib/calls/helpers/getScreenConstraints';
import getScreenStream from '@lib/calls/helpers/getScreenStream';
import getStream from '@lib/calls/helpers/getStream';
import getVideoConstraints from '@lib/calls/helpers/getVideoConstraints';
import {findGroupCallChainUpdate, getUpdatesList, groupCallToInput} from '@lib/calls/helpers/groupCallUpdates';
import stopTrack from '@lib/calls/helpers/stopTrack';
import StreamManager, {waitForMediaTrackReplacements} from '@lib/calls/streamManager';
import getPeerId from '@appManagers/utils/peers/getPeerId';
import {AppManagers} from '@lib/managers';
import type {EncryptWorkerHost} from '@lib/calls/e2e/encryptWorkerHost';
import type {CallStatusSnapshot} from '@lib/calls/e2e/encryptWorkerProtocol';
import {
  conferenceUserIdToPeerId,
  findChainOnlyMembers
} from '@lib/calls/e2e/conferenceMembership';
import {GROUP_CALL_PARTICIPANT_VOLUME_UNIT} from '@lib/calls/constants';
import GroupCallMediaRouter, {getParticipantOutputSource, RoutedGroupCallTrack} from '@lib/calls/livekit/groupCallMediaRouter';
import {parseGroupCallIdentity} from '@lib/calls/livekit/liveKitIdentity';
import type {LiveKitMediaSource} from '@lib/calls/livekit/liveKitTransport';
import createSerializedQueue from '@helpers/createSerializedQueue';
import notifyAllowedToSpeak from '@components/groupCall/allowedToSpeakCue';

// Screen capture is requested without tab / system audio. There is no in-app
// "share system audio" toggle yet (tdesktop asks explicitly in its picker), so
// audio-less is the privacy default: the browser's picker would otherwise offer
// the audio of whatever else is playing, and the P2P path
// (callInstanceBase.requestScreen) already asks this way.
const getGroupScreenConstraints = () => getScreenConstraints(true);


// If a conference poller hasn't reached the server in this long while the call
// is alive, the watchdog forces recovery. Comfortably past the poll cadences
// (chain 1.5s, participants 5s) so transient network hiccups don't trip it.
const E2E_SYNC_STALL_MS = 15000;
// Consecutive incomplete roster polls before we surface it. The roster poll is
// on a 5s timer, so this is ~15s of a server refusing to say who is in the call.
const INCOMPLETE_ROSTER_POLLS_BEFORE_REPORT = 3;
// Consecutive watchdog recoveries that failed to advance the stale poller
// clock before the local re-hydrate loop is declared unable to fix the stall
// and the call escalates to a full controller-owned rejoin. Local recovery can
// only refresh `groupCall` and re-kick the pollers — it cannot re-anchor a
// chain cursor the server has compacted past, and tdesktop's answer to that
// state is likewise a rebuilt call. Without this cap the watchdog re-ran the
// same unproductive refresh every tick for the rest of the call.
const UNPRODUCTIVE_SYNC_RECOVERIES_BEFORE_REJOIN = 3;
// How long a server-accepted unmute stays armed waiting for a self row that
// confirms it. A stale muted row can land mid-RPC and win the post-RPC check;
// without the armed intent the server would keep listing us as unmuted while
// capture stays disabled — peers see a speaker and hear silence. Short-lived
// so a much later unmuted row cannot surprise-open the microphone.
const UNMUTE_INTENT_TTL_MS = 15000;
// Consecutive GROUPCALL_INVALID answers before we stop pretending to be in the
// call. The chain poll runs every 1.5s, so this is a few seconds of the server
// telling us this call is not ours.
const CALL_INVALID_ANSWERS_BEFORE_LEAVING = 8;
// Verification broadcasts are small and ordered. Keep a pulled message at the
// head of the host-side queue until it is accepted, but bound the delay so a
// permanent RPC error cannot wedge later rounds forever.
const E2E_OUTBOUND_MAX_ATTEMPTS = 5;
const E2E_OUTBOUND_RETRY_BASE_MS = 250;
const MEDIA_TEARDOWN_MAX_ATTEMPTS = 3;
const MEDIA_TEARDOWN_RETRY_BASE_MS = 250;
// Keep the nearest gap suffix and refetch anything beyond it. This bounds a
// relay-controlled sequence of far-future push batches without sacrificing the
// low indexes needed to restore continuity.
const MAX_E2E_PENDING_CHAIN_BLOCKS = 256;

// How often the watchdog checks for the stall above.
const E2E_WATCHDOG_INTERVAL_MS = 5000;

// How long a chain member must stay absent from COMPLETE SFU rosters before we
// remove it from the blockchain.
//
// tdesktop prunes on the first complete roster (`checkStaleParticipants`), but
// it only ever compares after re-requesting the participant list. Our roster
// poll is on a timer, so the same immediacy would race a real joiner: their
// block reaches the chain the moment `phone.joinGroupCall` accepts it, and the
// SFU can list them a beat later — pruning that window kicks people out of the
// call they just joined. The row is published as "has access" the instant it's
// detected, so the disclosure requirement is met immediately; only the removal
// waits out this window.
const CONFERENCE_STALE_GRACE_MS = 10000;
// Floor between removal attempts. A rejected removal (chain raced ahead — or a
// server that refuses to prune) must not turn the 5s roster poll into an RPC
// loop.
const CONFERENCE_PRUNE_RETRY_MS = 15000;
// Consecutive removal failures before we surface a breadcrumb. A server that
// keeps rejecting the removal while the identity keeps holding the call key is
// exactly the case the user needs told about.
const CONFERENCE_PRUNE_FAILURES_BEFORE_REPORT = 3;

// The camera row of our own participant. The server owns the real one (endpoint included); this is what the
// local row shows until it arrives.
function makeSelfVideo(): GroupCallParticipantVideo {
  return {
    _: 'groupCallParticipantVideo',
    pFlags: {},
    endpoint: '',
    source_groups: []
  };
}

function mediaCleanupError(message: string, operationError: unknown, cleanupError: unknown): Error {
  const error = new Error(message);
  (error as Error & {cause?: unknown}).cause = {operationError, cleanupError};
  return error;
}

export default class GroupCallInstance extends CallInstanceBase<{
  state: (state: GROUP_CALL_STATE) => void,
  pinned: (source?: GroupCallOutputSource) => void,
  // Fired whenever the e2e worker reports a new snapshot — UI listens for
  // verification phase + emoji fingerprint changes. Only fires when this
  // instance is a conference (i.e. `e2e` is set).
  e2eStatus: (status: CallStatusSnapshot) => void,
  // Fired when the set of authenticated e2e members that the SFU roster does
  // NOT list changes. These identities hold the current shared key, so the UI
  // must show them (see conferenceMembership.ts). `previous` lets the roster
  // list retire the rows it added.
  membersWithAccess: (change: {current: PeerId[], previous: PeerId[]}) => void,
  // A joined conference can lose active-participant authority or its key can
  // fall out of the accepted membership chain. The controller owns the rejoin.
  conferenceRecoveryRequired: (reason: string) => void
}> {
  public id: GroupCallId;
  public chatId: ChatId;
  public connections: {[k in GroupCallConnectionType]?: GroupCallConnectionInstance};
  public groupCall: GroupCall;
  public participant: GroupCallParticipant;
  /**
   * Settles once the leave the last hang-up sent is answered and its updates applied, however it ended.
   * Until then the call is still this tab's own: tdesktop ends it only after applying the leave's answer
   * (calls_group_call.cpp:2247-2254).
   */
  public leaveSettled: Promise<void> = Promise.resolve();

  // ===== E2E (conference) mode =====
  // When set, this instance is a TdE2E-encrypted conference call rather than
  // a legacy voice chat. The worker owns the private key + per-frame crypto;
  // the SFU plumbing below stays identical. `selfUserId` identifies us in the
  // e2e group_state (matches our PrivateKey's publicKey).
  public e2e?: EncryptWorkerHost;
  public selfUserId?: bigint;
  // attachE2e wires status/transforms before phone.joinGroupCall, but no chain
  // or broadcast traffic may reach the proposed anchor until the server has
  // accepted the join (and a chain-race replacement has been committed).
  private e2eActive = false;
  private e2eActivating = false;
  private e2eActivationPromise: Promise<void> | undefined;
  private e2eFatalError: Error | undefined;
  // Latest snapshot from the worker (height, group state, emoji fingerprint).
  public e2eStatus?: CallStatusSnapshot;
  // Set by the transport controller once the LiveKit connection is up. Keep the public
  // property for existing callers, but emit through its setter so UI readiness
  // cannot miss the exact transition from negotiating to joined.
  private _joined = false;

  private pinnedSources: Array<GroupCallOutputSource>;
  // the rows the media router resolves LiveKit identities against, kept in step by onParticipantUpdate
  private participantRows = new Map<PeerId, GroupCallParticipant>();
  private outputSourcesByPeer = new Map<PeerId, string[]>();
  private mediaRouter: GroupCallMediaRouter;
  private speakingPeerIds = new Set<PeerId>();
  private hadAutoPinnedSources: Set<GroupCallOutputSource>;
  private dispatchPinnedThrottled: () => void;
  private startVideoSharingPromise: Promise<void>;
  private startScreenSharingPromise: Promise<void>;
  private startScreenSharingPromiseGeneration = 0;
  private videoSharingGeneration = 0;
  private screenSharingGeneration = 0;
  private closedPresentationConnections = new WeakSet<GroupCallConnectionInstance>();
  private completedPresentationLeaves = new WeakSet<GroupCallConnectionInstance>();
  private presentationLeavePromises = new WeakMap<GroupCallConnectionInstance, Promise<void>>();
  private pendingPresentationLeaves = new Set<GroupCallConnectionInstance>();
  private presentationTransitionTail = createSerializedQueue();
  private presentationRecoveryPromise: Promise<void>;
  private adminMediaTeardownPromise: Promise<void>;
  private adminMediaTeardownGeneration = 0;
  private adminMediaBlocked = false;
  private rowAdminBlocked = false;
  private permissionBlocked = false;
  private selfParticipantRevision = 0;
  // Monotonic clock of a server-accepted unmute still waiting for capture to
  // open (see changeSelfMuted / UNMUTE_INTENT_TTL_MS). Undefined = no intent.
  private pendingUnmuteIntentAt: number | undefined;
  private selfMuteTransitionTail = createSerializedQueue();
  private selfParticipantEditTail = createSerializedQueue();
  private fatalHangUpStarted = false;
  private hungUp = false;
  private lifecycleGeneration = 0;
  private observedInputAudioTracks = new WeakSet<MediaStreamTrack>();

  private managers: AppManagers;

  constructor(options: {
    id: GroupCallInstance['id'],
    chatId: GroupCallInstance['chatId'],
    connections?: GroupCallInstance['connections'],
    managers: AppManagers
  }) {
    super();

    safeAssign(this, options);

    if(!this.log) {
      this.log = logger('GROUP-CALL');
    }

    if(!this.connections) {
      this.connections = {};
    }

    this.pinnedSources = [];
    this.mediaRouter = new GroupCallMediaRouter({
      getParticipants: () => this.participantRows.values(),
      getSelfPeerId: () => this.participant ? getPeerId(this.participant.peer) : undefined,
      onTrackRouted: (route) => this.onTrackRouted(route),
      onTrackDropped: (route) => this.onTrackDropped(route)
    });
    this.hadAutoPinnedSources = new Set();
    this.dispatchPinnedThrottled = throttle(() => {
      this.dispatchEvent('pinned', this.pinnedSource);
    }, 0, false);

    this.addEventListener('state', (state) => {
      if(state === GROUP_CALL_STATE.CLOSED) {
        this.cleanup();
      }
    });
  }

  public cleanup(): void {
    ++this.lifecycleGeneration;
    ++this.videoSharingGeneration;
    ++this.screenSharingGeneration;
    this.stopE2eChainPolling();
    // This one lives on the GLOBAL rootScope, so `super.cleanup()` — which only
    // clears this instance's own emitter — never touched it. Every conference in
    // a session left another live listener closing over a torn-down instance.
    if(this.chainBlocksListener) {
      rootScope.removeEventListener('group_call_chain_blocks', this.chainBlocksListener);
      this.chainBlocksListener = undefined;
    }
    this.membersWithAccess.clear();
    this.staleSince.clear();
    this.e2eOutboundQueue.length = 0;
    this.e2eOutboundFlushRequested = false;
    this.e2eChainPending[0].clear();
    this.e2eChainPending[1].clear();
    // Terminate the e2e worker so its Web Worker thread exits. Best-effort —
    // the controller may have already done so via its own state listener,
    // but a double-terminate is harmless (encryptWorkerHost guards).
    if(this.e2e) {
      void this.e2e.terminate().catch((): undefined => undefined);
      this.e2e = undefined;
    }
    this.e2eActive = false;
    this.e2eActivating = false;
    this.pendingUnmuteIntentAt = undefined;
    this.mediaRouter.clear();
    this.participantRows.clear();
    this.outputSourcesByPeer.clear();
    super.cleanup();
  }

  // ===== E2E (conference) hookup =====
  //
  // Called before phone.joinGroupCall so transforms and worker status are ready.
  // Chain application, polling, roster reconciliation and outbound verification
  // remain gated until activateE2e() after the server accepts the join.
  public attachE2e(
    worker: EncryptWorkerHost,
    selfUserId: bigint,
    initialOffsets?: Partial<{0: number; 1: number}>
  ): void {
    if(initialOffsets) {
      this.seedE2eChainOffsets(initialOffsets);
    }
    this.e2e = worker;
    this.selfUserId = selfUserId;

    worker.addEventListener('status', (ev) => {
      const height = ev.status.verification?.height;
      if(height !== this.verificationRoundHeight) {
        this.verificationRoundHeight = height;
        if(height !== undefined) {
          // A newer main tip replaces the verification round wholesale. Never
          // keep retrying a commit/reveal that names the abandoned height.
          this.e2eOutboundQueue = this.e2eOutboundQueue.filter((item) => item.height === height);
        }
      }

      this.e2eStatus = ev.status;
      this.dispatchEvent('e2eStatus', ev.status);

      // Conference membership lives on the e2e blockchain — the SFU doesn't push
      // `updateGroupCallParticipants` for conferences the way it does for legacy
      // voice chats. Every applied chain block re-emits this status, so when the
      // group_state member set changes (someone joined/left), re-sync the SFU
      // participant roster + count off it.
      if(this.e2eActive) this.syncConferenceMembersFromStatus();
    });
    worker.addEventListener('pendingOutbound', () => {
      this.e2eOutboundFlushRequested = true;
      if(this.e2eActive && !this.e2eActivating) void this.flushE2eOutbound();
    });
    worker.addEventListener('callFailed', (ev) => {
      const message = ev?.message || 'Encryption worker failed';
      // A newer accepted membership block can replace our public key while two
      // clients join/rejoin concurrently. The key is no longer usable, but the
      // canonical call still is: rebuild on the latest head through the same
      // controller-owned full rejoin as GROUPCALL_FORBIDDEN.
      if(message.startsWith('NOT_PARTICIPANT:') && this.e2eActive && !this.e2eActivating) {
        this.log.warn('e2e membership lost — requesting full rejoin', message);
        this.requestConferenceRecovery('membership-lost');
        return;
      }

      this.log.error('e2e: callFailed — leaving; reason:', message);
      this.e2eFatalError ??= new Error(message);
      // Leave, do NOT discard. `hangUp(true)` routes to phone.discardGroupCall,
      // which ends the conference for EVERY participant — so one client failing
      // to apply a block used to tear down everyone else's call. Our e2e state
      // being unusable is a statement about this client only; the others may be
      // perfectly healthy, and if they are not, they will each decide that for
      // themselves.
      // Before/during activation the join transaction owns rollback. Let
      // activateE2e reject into it instead of racing it with a second leave.
      if(this.e2eActive && !this.e2eActivating) this.hangUpAfterFatalFailure();
    });

    // Inbound chain delivery — sub_chain_id 0 is the block chain, 1 is the
    // verification broadcast channel. The server pushes these updates when it
    // can, but we also poll because conference push delivery is best-effort
    // (tdlib: TdE2E::Call::joined → shortPoll(0); shortPoll(1)).
    this.chainBlocksListener = ({callId, subChainId, blocks, nextOffset}) => {
      if(callId !== this.id || !this.e2e) return;
      void this.deliverE2eChainBlocks(subChainId, blocks, nextOffset).catch((err) => {
        // During post-accept activation a main-chain apply failure rejects so
        // the join transaction can roll back. Push delivery has no direct
        // caller, so observe that same rejection while the activation queue
        // retains the exact failed block for the owner to see.
        this.log.error('pushed e2e chain delivery failed', err);
      });
    };
    rootScope.addEventListener('group_call_chain_blocks', this.chainBlocksListener);
  }

  /**
   * Open the conference's network side effects after phone.joinGroupCall has
   * accepted our exact block and invite placeholders have their canonical id.
   */
  public activateE2e(): Promise<void> {
    if(this.e2eActivationPromise) return this.e2eActivationPromise;
    if(this.e2eActive) return Promise.resolve();
    if(!this.e2e) return Promise.reject(new Error('Conference encryption worker is unavailable during activation'));

    const run = this.activateE2eInternal().finally(() => {
      if(this.e2eActivationPromise === run) this.e2eActivationPromise = undefined;
    });
    this.e2eActivationPromise = run;
    return run;
  }

  private async activateE2eInternal(): Promise<void> {
    if(this.e2eFatalError) throw this.e2eFatalError;
    this.e2eActivating = true;
    this.e2eActive = true;

    try {
      // Join-response pushes and retry-head fetches can arrive while the gate is
      // closed. Restore their indexed order before opening fresh polling, so a
      // newer network response cannot overtake the accepted join block.
      await this.drainE2eChainPending();
      if(this.e2eFatalError) throw this.e2eFatalError;
      if(!this.e2e || !this.e2eActive) {
        throw new Error('Conference was closed while activating encryption');
      }

      this.syncConferenceMembersFromStatus();

      // Opening the flush gate only after the complete accepted backlog has
      // drained ensures pullOutbound sees the final verification round, not an
      // intermediate commit from the first buffered main block.
      this.e2eActivating = false;
      this.startE2eChainPolling();
      if(this.e2eOutboundFlushRequested) void this.flushE2eOutbound();
    } catch(err) {
      this.e2eActive = false;
      this.stopE2eChainPolling();
      throw err;
    } finally {
      this.e2eActivating = false;
    }
  }

  // ===== TdE2E chain polling =====
  //
  // Mirrors tdlib's per-subchain polling (TdE2E::Call::shortPoll). Both
  // subchains advance independently; we keep the next-offset cursor per
  // subchain and re-issue `phone.getGroupCallChainBlocks` on a slow tick.
  // The push from `updateGroupCallChainBlocks` advances the cursor too.
  private e2eChainPollInterval: ReturnType<typeof setInterval> | undefined;
  private e2eChainOffsets: {0: number; 1: number} = {0: 0, 1: 0};
  private e2eChainPending: {0: Map<number, Uint8Array>; 1: Map<number, Uint8Array>} = {
    0: new Map(),
    1: new Map()
  };

  /** Seed already-applied subchain cursors before attachE2e starts polling. */
  public seedE2eChainOffsets(offsets: Partial<{0: number; 1: number}>): void {
    if(this.e2e) {
      this.log.warn('seedE2eChainOffsets: ignored after e2e attach');
      return;
    }

    ([0, 1] as const).forEach((subChainId) => {
      const offset = offsets[subChainId];
      if(Number.isSafeInteger(offset) && offset >= 0) {
        this.e2eChainOffsets[subChainId] = offset;
      }
    });
  }

  /**
   * Buffer the identity-checked chain slices returned by the accepted join RPC.
   * Unlike an arbitrary push, that response is authoritative for the initial
   * verification cursor and may contain only ImpulseM's retained tail.
   */
  public deliverAcceptedE2eJoinChainBlocks(
    subChainId: number,
    blocks: Uint8Array[],
    nextOffset: number
  ): Promise<boolean> {
    if(!this.e2e || this.e2eActive) {
      this.log.warn('deliverAcceptedE2eJoinChainBlocks: ignored outside the pre-activation gate');
      return Promise.resolve(false);
    }

    const requestedOffset = subChainId === 0 || subChainId === 1 ?
      this.e2eChainOffsets[subChainId] :
      0;
    if(!this.isValidE2eChainBatch(subChainId, blocks, nextOffset, requestedOffset)) {
      return Promise.resolve(false);
    }

    const firstOffset = nextOffset - blocks.length;
    if(subChainId === 1 && requestedOffset === 0 && firstOffset > 0) {
      this.log('conference: anchored accepted join verification tail at', firstOffset);
      this.advanceE2eChainOffsets({1: firstOffset});
    }

    return this.deliverE2eChainBlocks(subChainId, blocks, nextOffset);
  }

  /**
   * Move already-attached cursors forward after a join retry re-anchors the
   * worker on a newer chain tip. Older buffered blocks belong to the abandoned
   * proposal and must not be applied to the replacement anchor.
   */
  public advanceE2eChainOffsets(offsets: Partial<{0: number; 1: number}>): void {
    ([0, 1] as const).forEach((subChainId) => {
      const offset = offsets[subChainId];
      if(!Number.isSafeInteger(offset) || offset < this.e2eChainOffsets[subChainId]) return;
      this.e2eChainOffsets[subChainId] = offset;
      const pending = this.e2eChainPending[subChainId];
      for(const pendingOffset of pending.keys()) {
        if(pendingOffset < offset) pending.delete(pendingOffset);
      }
    });
  }

  // The one member-set change detector for both the worker `status` listener
  // and activation. Cheap string-key diff avoids re-polling on unrelated status
  // churn (e.g. emoji verification phases). On a change it re-syncs the SFU
  // roster AND re-arms any unmapped-SSRC resolutions that were parked waiting
  // for exactly this: their owner's chain block applying locally.
  private syncConferenceMembersFromStatus(): void {
    const members = (this.e2eStatus?.groupState?.participants || [])
    .map((participant) => participant.userId.toString())
    .sort()
    .join(',');
    if(members === this.prevConferenceMembers) return;
    this.prevConferenceMembers = members;
    void this.refreshConferenceParticipants();
  }

  // Conference participant reconciliation (see refreshConferenceParticipants).
  // `prevConferenceMembers` is the last e2e group_state member set we synced;
  // the periodic timer is a backstop for changes the blockchain doesn't surface
  // promptly (e.g. an ungraceful disconnect that the SFU drops before a removal
  // block lands). `refreshingConferenceParticipants` de-dupes overlapping runs.
  private prevConferenceMembers = '';
  private conferenceParticipantsInterval: ReturnType<typeof setInterval> | undefined;
  private refreshingConferenceParticipants = false;
  private selfParticipantHydrationRequested = false;
  // Consecutive polls that came back with an incomplete roster. Reset by any
  // complete one; drives the breadcrumb above.
  private incompleteRosterPolls = 0;
  // Consecutive GROUPCALL_INVALID answers across the conference API paths.
  private consecutiveCallInvalid = 0;
  // Height owns the outbound commit/reveal queue for the current verification
  // round. A newer height invalidates queued broadcasts from the old round.
  private verificationRoundHeight: number | undefined;

  // ===== Chain-only members (blockchain ↔ SFU roster reconciliation) =====
  //
  // Authenticated e2e members that a COMPLETE SFU roster doesn't list. They
  // hold the current shared key, so tdlib's Encryption.md requires us to show
  // them; the protocol additionally requires removing them and rotating the key
  // (`only_left` pruning). See conferenceMembership.ts for the full rationale.
  //
  // Client-side synthetic participants: never saved into the manager cache,
  // never dispatched as `group_call_participant`, `source: 0` so no SSRC map
  // ever sees them.
  private membersWithAccess: Map<PeerId, GroupCallParticipant> = new Map();
  // user_id → when we first saw it missing, for the grace window.
  private staleSince: Map<string, number> = new Map();
  private pruningConferenceMembers = false;
  private lastPruneAttemptAt: number | undefined;
  private consecutivePruneFailures = 0;
  // Recovery triggers can arrive concurrently from the worker, chain polling,
  // roster refresh, pruning and verification broadcast. Request one
  // controller-owned rejoin and stop this instance's traffic immediately.
  private conferenceRecoveryDispatched = false;

  // ===== Conference-sync watchdog =====
  //
  // Both conference pollers (pollE2eChain, refreshConferenceParticipants) bail
  // SILENTLY when our cached `groupCall` is missing/discarded — getGroupCallInput
  // throws without it. If that state persists, media keeps flowing but the call
  // stops learning about unmutes/joins: a participant who unmutes is seen (SFU
  // speaking signal is plaintext) but not heard — their audio SSRC never enters
  // the e2e recv map, so the recv transform drops them (silence). Observed
  // live: a ~19-minute stall that only cleared on a manual re-join. These track
  // when each poller last actually REACHED the server; the watchdog re-hydrates
  // `groupCall` and re-kicks the pollers when either goes stale.
  private lastChainPollAt = 0;
  private lastParticipantsRefreshAt = 0;
  private lastPollBailReason = '';
  private e2eWatchdogInterval: ReturnType<typeof setInterval> | undefined;
  private recoveringConferenceSync = false;
  private unproductiveSyncRecoveries = 0;
  // Cooldown (per reason) for the user-facing bug breadcrumb — see reportConferenceBug.
  private reportedBugAt: Map<string, number> = new Map();

  private startE2eChainPolling(): void {
    if(this.e2eChainPollInterval) return;
    // Seed the watchdog clocks so it grants a full stall window before the
    // first successful poll lands (invitee/slug joins hydrate `groupCall`
    // lazily — see pollE2eChain).
    this.lastChainPollAt = this.lastParticipantsRefreshAt = performance.now();
    const tick = (): void => { void this.pollE2eChain(); };
    // Immediate kick — tdlib does this in `joined()`.
    tick();
    // Steady-state interval: 1500ms is a balance between latency for emoji
    // verification (commit/reveal needs both peers' broadcasts) and load.
    this.e2eChainPollInterval = setInterval(tick, 1500);

    // Backstop SFU participant poll. The blockchain-change trigger (in the
    // worker `status` handler) covers the common join/leave case; this catches
    // anything that changes the SFU roster without a chain delta. 5s matches
    // the official Android conference poll cadence.
    if(!this.conferenceParticipantsInterval) {
      this.conferenceParticipantsInterval = setInterval(() => {
        void this.refreshConferenceParticipants();
      }, 5000);
    }

    // Watchdog: detect + self-heal a silent poller stall (see field comment).
    if(!this.e2eWatchdogInterval) {
      this.e2eWatchdogInterval = setInterval(() => {
        this.e2eWatchdogTick();
      }, E2E_WATCHDOG_INTERVAL_MS);
    }
  }

  private stopE2eChainPolling(): void {
    if(this.e2eChainPollInterval) {
      clearInterval(this.e2eChainPollInterval);
      this.e2eChainPollInterval = undefined;
    }
    if(this.conferenceParticipantsInterval) {
      clearInterval(this.conferenceParticipantsInterval);
      this.conferenceParticipantsInterval = undefined;
    }
    if(this.e2eWatchdogInterval) {
      clearInterval(this.e2eWatchdogInterval);
      this.e2eWatchdogInterval = undefined;
    }
  }

  private requestConferenceRecoveryForForbidden(reason: string, err: unknown): boolean {
    if((err as ApiError)?.type !== 'GROUPCALL_FORBIDDEN') return false;
    this.requestConferenceRecovery(reason);
    return true;
  }

  private requestConferenceRecovery(reason: string): void {
    if(this.conferenceRecoveryDispatched) return;

    this.conferenceRecoveryDispatched = true;
    this.e2eActive = false;
    this.e2eOutboundFlushRequested = false;
    this.e2eOutboundQueue.length = 0;
    this.stopE2eChainPolling();
    this.log.warn('conference recovery required — requesting full rejoin', {reason});
    this.dispatchEvent('conferenceRecoveryRequired', reason);
  }

  public requestSelfParticipantHydration(): void {
    if(this.participant?.pFlags.self) {
      this.selfParticipantHydrationRequested = false;
      return;
    }
    this.selfParticipantHydrationRequested = true;
    void this.refreshConferenceParticipants();
  }

  // Reconcile the SFU participant roster + count for a conference. No-op for
  // legacy voice chats (gated on `this.e2e`) and while closed. The heavy
  // lifting (fresh fetch, leave reconciliation, count) lives in the manager;
  // here we just guard against overlapping runs and a torn-down call.
  private async refreshConferenceParticipants(): Promise<void> {
    if(!this.e2e || this.conferenceRecoveryDispatched || this.refreshingConferenceParticipants) return;
    if(this.connectionState === 'closed') return;
    this.refreshingConferenceParticipants = true;
    try {
      // `false` => the manager bailed (no cached groupCall), so the roster sync
      // isn't actually running. Only stamp the watchdog clock on a real fetch.
      const includeSelf = this.selfParticipantHydrationRequested && !this.participant?.pFlags.self;
      // Hand the manager our live audio source so it can drop a self row from a
      // lagging server snapshot instead of feeding it to the self-source kill
      // switch in onParticipantUpdate (which would end the whole call).
      const selfSource = this.connections.main?.sources?.audio?.source;
      const fetched = await this.managers.appGroupCallsManager.refreshConferenceParticipants(
        this.id,
        includeSelf ? {includeSelf: true, ...(selfSource !== undefined ? {selfSource} : {})} : undefined
      );
      if(!fetched) {
        return;
      }

      if(this.participant?.pFlags.self) {
        this.selfParticipantHydrationRequested = false;
      }

      this.lastParticipantsRefreshAt = performance.now();
      // A truncated roster can't tell "absent" from "on a page we never got", so
      // it must never drive the access list or a removal.
      if(fetched.complete) {
        this.incompleteRosterPolls = 0;
        await this.reconcileConferenceMembership(fetched.userIds);
      } else if(++this.incompleteRosterPolls >= INCOMPLETE_ROSTER_POLLS_BEFORE_REPORT) {
        // Skipping reconciliation is the SAFE response to one truncated roster,
        // but it is also exactly what a backend wants if it is hiding a chain
        // participant: no disclosure, no only_left rekey, no noise. A roster
        // that never completes is not a quiet condition — say so, and keep
        // saying it, rather than letting the defence stay silently disabled.
        this.incompleteRosterPolls = 0;
        this.reportConferenceBug(
          'the call server will not return a complete participant list — who holds the call key cannot be verified',
          {userIds: fetched.userIds.length}
        );
      }
    } catch(err) {
      if(this.requestConferenceRecoveryForForbidden('roster-forbidden', err)) return;
      this.log.warn('refreshConferenceParticipants', err);
      this.noteConferenceApiResult(err);
    } finally {
      this.refreshingConferenceParticipants = false;
    }
  }

  /**
   * Compare authenticated e2e membership against the complete SFU roster.
   *
   * The blockchain is the access list: a participant in `group_state` holds the
   * current shared key whether or not the server lists them. So anyone on the
   * chain but off the roster is (a) surfaced to the user right away and (b)
   * scheduled for the protocol's `only_left` removal, which rotates the key
   * away from them. Doing only (b) would leave the user blind whenever the
   * removal is refused; doing only (a) would leave the key shared forever.
   */
  private async reconcileConferenceMembership(rosterUserIds: string[]): Promise<void> {
    const {e2eStatus, selfUserId} = this;
    if(!this.e2e || !e2eStatus || selfUserId === undefined) return;
    if(this.connectionState === 'closed') return;

    const chainOnly = findChainOnlyMembers({
      participants: e2eStatus.groupState.participants,
      rosterUserIds,
      selfUserId
    });

    // Publish BEFORE the grace window: an identity with call access is shown
    // the moment it's known, and stays shown until the removal AND its rotated
    // key have actually been accepted (this recomputes off group_state, so the
    // row clears itself once the removal block lands).
    this.publishMembersWithAccess(chainOnly);

    // Age each identity. Rebuilding the map drops anyone who reappeared on the
    // roster, so a member who flaps starts their window over rather than
    // accumulating time towards removal.
    const now = performance.now();
    const staleSince = new Map<string, number>();
    const prunable: bigint[] = [];
    for(const userId of chainOnly) {
      const key = userId.toString();
      const since = this.staleSince.get(key) ?? now;
      staleSince.set(key, since);
      if(now - since >= CONFERENCE_STALE_GRACE_MS) {
        prunable.push(userId);
      }
    }
    this.staleSince = staleSince;

    if(!prunable.length || this.pruningConferenceMembers) return;
    if(this.lastPruneAttemptAt !== undefined &&
       now - this.lastPruneAttemptAt < CONFERENCE_PRUNE_RETRY_MS) return;

    // Detached on purpose: this runs inside the roster poller's
    // `refreshingConferenceParticipants` guard, and a removal RPC that never
    // settles (dead connection) would otherwise wedge the roster refresh for
    // the rest of the call. `pruningConferenceMembers` guards overlap instead.
    void this.pruneConferenceMembers(prunable);
  }

  // Swap in the chain-only set and tell the UI, but only on a real change —
  // this runs on every roster poll.
  private publishMembersWithAccess(userIds: bigint[]): void {
    const next = new Map<PeerId, GroupCallParticipant>();
    for(const userId of userIds) {
      const peerId = conferenceUserIdToPeerId(userId);
      // validateGroupState rejects user_ids that are not positive, so on a
      // validated chain this never fires — but the row list would read 0 as
      // ourselves (getParticipantByPeerId's NULL_PEER_ID branch) and a negative
      // id as a chat, naming the wrong party as the key holder. Report instead
      // of rendering; the identity still goes through the exact-id removal.
      if(peerId === NULL_PEER_ID || !peerId.isUser()) {
        this.reportConferenceBug(
          'an e2e member id cannot be shown as a user — it would render as ourselves or as a chat',
          {peerId, userIds: userIds.map(String)}
        );
        continue;
      }

      // The roster list is keyed by PeerId, so two chain ids that round to the
      // same one (only possible above 2^53 — see conferenceMembership.ts) can
      // only ever be ONE row. Removal still covers both, since that works off
      // exact ids, but one identity would go undisclosed until it lands. Real
      // user ids are nowhere near that range, so this means the server is
      // feeding us ids no real account has: say so rather than show one row.
      if(next.has(peerId)) {
        this.reportConferenceBug(
          'two e2e members share one displayed peer — one of them cannot be shown',
          {peerId, userIds: userIds.map(String)}
        );
        continue;
      }

      // Reuse the existing synthetic so the row keeps its identity (and its
      // sort index) across polls.
      next.set(peerId, this.membersWithAccess.get(peerId) ?? this.makeMemberWithAccess(userId));
    }

    const previous = [...this.membersWithAccess.keys()];
    const unchanged = next.size === previous.length && previous.every((peerId) => next.has(peerId));

    // Nothing to show and nothing shown — the common case, stay quiet.
    if(unchanged && !next.size) {
      return;
    }

    this.membersWithAccess = next;
    // Only announce a genuine change; re-dispatching below is repair, not news.
    if(next.size && !unchanged) {
      this.log.warn(
        'conference: e2e members absent from the SFU roster —', [...next.keys()],
        '— they hold the current call key; showing them and scheduling removal'
      );
    }

    // Re-assert on every poll even when the set is identical. The disclosure is
    // a security claim, and anything that drops one of these rows — a server
    // `left` push racing the roster, a list rebuild — would otherwise never be
    // undone, because "set unchanged" used to mean "don't touch the UI". The
    // set is tiny and this only runs while it is non-empty.
    this.dispatchEvent('membersWithAccess', {current: [...next.keys()], previous});
  }

  // The roster UI renders chain-only members through the same row widget as
  // real participants (tdesktop does the same via `updateStateWithAccess`), so
  // give it the minimal participant shape: muted, no video, `date: 0` so the
  // descending sort parks them below everyone actually connected.
  private makeMemberWithAccess(userId: bigint): GroupCallParticipant {
    return {
      _: 'groupCallParticipant',
      peer: {_: 'peerUser', user_id: userId.toString()},
      pFlags: {muted: true, can_self_unmute: true},
      source: 0,
      date: 0
    };
  }

  // Build + submit the `only_left` removal. The block carries both the trimmed
  // group_state and a fresh shared key addressed only to the survivors, so the
  // removed identity can't decrypt anything past it.
  private async pruneConferenceMembers(userIds: bigint[]): Promise<void> {
    const input = this.toInputGroupCall();
    // Re-check both here, not just at the reconcile call site: this runs
    // detached, so anything thrown escapes as an unhandled rejection rather
    // than reaching a caller.
    if(!input || !this.e2e) return;

    this.pruningConferenceMembers = true;
    this.lastPruneAttemptAt = performance.now();
    let ids = userIds.map(String);
    try {
      // The worker reads the current state only when this request reaches its
      // serialized queue, after any already-queued applyBlock. It returns the
      // exact identities represented by the block so RPC ids and key rotation
      // can never describe different membership deltas.
      const removal = await this.e2e.buildRemoveParticipantsBlock({userIds});
      if(!removal) return;
      const {block, removedUserIds} = removal;
      ids = removedUserIds.map(String);

      await this.managers.appCallsManager.deleteConferenceCallParticipants({
        call: input,
        ids,
        block,
        onlyLeft: true
      });

      this.consecutivePruneFailures = 0;
      this.log('conference: removed stale e2e members + rotated the key —', ids);
    } catch(err) {
      const type = (err as ApiError)?.type as string | undefined;
      if(this.requestConferenceRecoveryForForbidden('member-prune-forbidden', err)) return;
      ++this.consecutivePruneFailures;

      // The chain moved under us between build and submit (someone joined or
      // another client pruned first). Benign — our own state advances with the
      // new block and the next pass rebuilds on top of it.
      if(type === 'CONF_WRITE_CHAIN_INVALID' || type === 'BLOCK_INVALID') {
        this.log('conference: removal raced the chain, retrying next pass —', type);
      } else {
        this.log.error('conference: removal failed', err);
      }

      // Persistent refusal while the identity keeps holding the key is the
      // shape a hostile relay would take, so make sure it leaves a trace.
      if(this.consecutivePruneFailures >= CONFERENCE_PRUNE_FAILURES_BEFORE_REPORT) {
        this.reportConferenceBug(
          'could not remove e2e members that are absent from the call roster (they still hold the call key)',
          {ids, error: type || String(err), attempts: this.consecutivePruneFailures}
        );
      }
    } finally {
      this.pruningConferenceMembers = false;
    }
  }

  /** Peers on the e2e chain that the SFU roster doesn't list. */
  public get memberWithAccessPeerIds(): PeerId[] {
    return [...this.membersWithAccess.keys()];
  }

  /** Whether this row is a chain-only member rather than a real participant. */
  public isMemberWithAccess(peerId: PeerId): boolean {
    return this.membersWithAccess.has(peerId);
  }

  private async pollE2eChain(): Promise<void> {
    if(!this.e2e || this.conferenceRecoveryDispatched) return;
    // Lazy-hydrate `groupCall` for invitee paths (slug / inviteMessage join):
    // the join response carries `updateGroupCall` with the real id+access_hash
    // and the manager caches it, but the instance's own `groupCall` reference
    // wasn't set during joinConferenceCommon (we didn't have the id yet).
    // Pull from the cache here once it lands.
    if(!this.groupCall) {
      const cached = await this.managers.appGroupCallsManager
      .getGroupCall(this.id)
      .catch((): undefined => undefined);
      if(cached && cached._ === 'groupCall') {
        this.groupCall = cached;
        // For invitee/slug joins the real groupCall (with participants_count,
        // title, …) only lands here, AFTER the topbar/popup first rendered off
        // an undefined ref (showing the "1" fallback count). The hydration
        // itself fires no event, so nudge a re-render — otherwise the count
        // stays frozen at 1 until the next unrelated state/participant change.
        this.dispatchEvent('state', this.state);
      }
    }
    const input = this.toInputGroupCall();
    if(!input) {
      // The silent stall the watchdog exists for. Trace it on transition.
      this.notePollBail(this.groupCall ? 'groupCall discarded' : 'groupCall missing');
      return;
    }
    this.notePollBail('');
    // Poll both subchains in parallel. Each returns the slice from
    // `offset` onward; we advance `offset` by the number of blocks returned.
    // Outcomes: 'matched' — a cursor-bound slice was validated and delivered;
    // 'bare' — the server answered our call-bound request without echoing a
    // chain update (an empty mailbox shape tdlib/tdesktop accept as a healthy
    // answer — deriving a stall from it would churn the watchdog forever);
    // 'failed' — error, ambiguous container, or a slice that failed validation
    // (e.g. a cursor gap), which the watchdog must keep seeing as a stall so
    // its escalation can re-anchor via a full rejoin.
    const outcomes = await Promise.all([0, 1].map(async(sub): Promise<'matched' | 'bare' | 'failed'> => {
      const subChainId = sub as 0 | 1;
      try {
        // Bind the response to the exact cursor sent on this request. A push can
        // advance the live cursor while the RPC is in flight, so validating
        // against the later mutable value would reject an otherwise sound
        // response (or accept a batch that never answered this request).
        const requestedOffset = this.e2eChainOffsets[subChainId];
        const updates = await this.managers.appCallsManager.getGroupCallChainBlocks(
          input,
          subChainId,
          requestedOffset,
          // limit must be > 0 — server doesn't auto-pick a default. Pull a
          // generous window so we catch any backlog from a brief disconnect
          // but small enough to stay cheap.
          16
        );
        const chainUpdate = findGroupCallChainUpdate(updates, subChainId, input);
        if(!chainUpdate) {
          // Keep ordinary update side effects either way. A truly bare answer
          // (no chain update for this subchain at all) still proves
          // reachability and call recognition — the server answered our
          // call-bound request without an error — but an answer that carries
          // this subchain's update for a DIFFERENT call identity is not ours
          // to trust and must not feed the liveness clock.
          await this.managers.apiUpdatesManager.processUpdateMessage(updates);
          this.log.warn('pollE2eChain: response had no matching update for subchain', subChainId);
          const hasForeignChainUpdate = getUpdatesList(updates).some((update) => {
            return update._ === 'updateGroupCallChainBlocks' && update.sub_chain_id === subChainId;
          });
          return hasForeignChainUpdate ? 'failed' : 'bare';
        }

        // A poll has one cursor and therefore exactly one authoritative slice.
        // Reject an ambiguous container before the ordinary pipeline can echo a
        // second, unvalidated matching update back through the push listener.
        const nextMatchingChainUpdate = updates._ === 'updates' || updates._ === 'updatesCombined' ?
          findGroupCallChainUpdate({
            ...updates,
            updates: updates.updates.filter((update) => update !== chainUpdate)
          }, subChainId, input) :
          undefined;
        if(nextMatchingChainUpdate) {
          this.log.warn('pollE2eChain: response had multiple matching updates for subchain', subChainId);
          return 'failed';
        }

        const blocks = chainUpdate.blocks || [];
        if(!this.isValidE2eChainBatch(subChainId, blocks, chainUpdate.next_offset, requestedOffset)) {
          // Do not pass this container through the ordinary Updates pipeline:
          // AppCallsManager would echo the rejected chain slice back to this
          // instance as a push, bypassing the request-bound validation below.
          this.log.warn('pollE2eChain: rejected malformed response for subchain', subChainId);
          return 'failed';
        }

        // Keep all ordinary update side effects, including updateGroupCall,
        // once the identity-proven chain slice is structurally sound.
        await this.managers.apiUpdatesManager.processUpdateMessage(updates);
        const accepted = await this.deliverE2eChainBlocks(
          subChainId,
          blocks,
          chainUpdate.next_offset,
          requestedOffset
        );
        if(accepted) {
          this.noteConferenceApiResult();
          return 'matched';
        }
        this.log.warn('pollE2eChain: rejected response for subchain', subChainId);
        return 'failed';
      } catch(err) {
        if(this.requestConferenceRecoveryForForbidden('chain-forbidden', err)) return 'failed';
        // Transient errors are expected (network blips, brief auth churn).
        // Log and let the next tick retry.
        this.log.warn('pollE2eChain: subchain', subChainId, err);
        this.noteConferenceApiResult(err);
        return 'failed';
      }
    }));
    // Liveness needs BOTH subchains answered without an error or a rejected
    // slice. A 'bare' answer still counts: the reference clients derive no
    // stall signal from the echo's shape, and treating it as one kept the
    // watchdog recovering every few seconds for the whole call.
    if(outcomes.every((outcome) => outcome !== 'failed')) this.lastChainPollAt = performance.now();
  }

  /**
   * Register the outcome of a conference API call.
   *
   * GROUPCALL_INVALID means the server does not recognise this call FOR US —
   * we were removed, or it ended. Every conference path used to swallow it and
   * retry forever: the chain poll, the roster refresh and the recovery all
   * logged and moved on. Meanwhile the media already negotiated keeps flowing,
   * so the call looks alive while the client has silently stopped learning who
   * is in it — and since the recv transform is fail-closed, anything a peer
   * starts after that point is never mapped and is dropped. Observed live as
   * "I see their video but hear nothing", with the roster frozen behind it.
   *
   * Continuing in that state also means showing an encrypted-call UI whose
   * access list we can no longer verify, which is exactly what this stack is
   * supposed to refuse to do. Surface it and leave.
   */
  private noteConferenceApiResult(err?: unknown): void {
    const type = (err as ApiError)?.type as string | undefined;
    if(type !== 'GROUPCALL_INVALID') {
      // Any answer that is not "this call is not yours" clears the streak,
      // including ordinary network failures — those are the transient case the
      // pollers already retry through.
      if(!err || type) this.consecutiveCallInvalid = 0;
      return;
    }

    if(++this.consecutiveCallInvalid < CALL_INVALID_ANSWERS_BEFORE_LEAVING) {
      return;
    }

    this.consecutiveCallInvalid = 0;
    this.reportConferenceBug(
      'the call server no longer recognises this call — leaving rather than showing an encrypted call we cannot verify',
      {callId: String(this.id)}
    );
    this.hangUpAfterFatalFailure();
  }

  // Transition-logged bail tracing for pollE2eChain — logs once when the chain
  // poll starts (or stops) being unable to reach the server, not every tick.
  private notePollBail(reason: string): void {
    if(reason === this.lastPollBailReason) return;
    const wasBailing = !!this.lastPollBailReason;
    this.lastPollBailReason = reason;
    if(reason) this.log.warn('pollE2eChain: not polling —', reason);
    else if(wasBailing) this.log('pollE2eChain: reached server, resuming');
  }

  // Runs on E2E_WATCHDOG_INTERVAL_MS. If either conference poller hasn't reached
  // the server within E2E_SYNC_STALL_MS while the call is alive, force recovery.
  private e2eWatchdogTick(): void {
    if(!this.e2e || this.connectionState === 'closed' || this.recoveringConferenceSync) return;
    const now = performance.now();
    const chainStall = now - this.lastChainPollAt;
    const participantsStall = now - this.lastParticipantsRefreshAt;
    if(chainStall < E2E_SYNC_STALL_MS && participantsStall < E2E_SYNC_STALL_MS) return;

    this.log.warn(
      'conference sync stalled — chainPoll', Math.round(chainStall / 1000) + 's ago,',
      'participants', Math.round(participantsStall / 1000) + 's ago;',
      'lastBail:', this.lastPollBailReason || '(none)', '— forcing recovery'
    );
    this.reportConferenceBug('conference sync stalled (pollers not reaching the server)', {
      chainStallSec: Math.round(chainStall / 1000),
      participantsStallSec: Math.round(participantsStall / 1000),
      lastBail: this.lastPollBailReason || '(none)'
    });
    this.recoverConferenceSyncDetached('conference watchdog recovery failed');
  }

  private recoverConferenceSyncDetached(context: string): void {
    void this.recoverConferenceSync().catch((err) => {
      this.log.error(context, err);
    });
  }

  // Deduped diagnostic for the "I can't hear someone / had to re-join" class of
  // conference bug. The regular logger retains it for exported logs without
  // adding production globals or a separate console reporting path.
  private reportConferenceBug(reason: string, details: Record<string, unknown>): void {
    const monotonicNow = performance.now();
    const lastReportedAt = this.reportedBugAt.get(reason);
    if(lastReportedAt !== undefined && monotonicNow - lastReportedAt < 60000) return;
    this.reportedBugAt.set(reason, monotonicNow);

    const payload = {reason, at: new Date().toISOString(), callId: String(this.id), ...details};
    this.log.error('CONFERENCE BUG —', reason, payload);
  }

  // Re-hydrate `groupCall` (the dependency both pollers silently bail on) and
  // re-kick them. Re-seeds the manager cache from our own copy first, because
  // once the manager loses the call `getGroupCallInput` throws and getGroupCallFull
  // can't bootstrap. Guarded against overlapping runs.
  private async recoverConferenceSync(): Promise<void> {
    if(this.recoveringConferenceSync) return;
    this.recoveringConferenceSync = true;
    try {
      const chainWasStale = performance.now() - this.lastChainPollAt >= E2E_SYNC_STALL_MS;
      const participantsWereStale = performance.now() - this.lastParticipantsRefreshAt >= E2E_SYNC_STALL_MS;

      if(this.groupCall && this.groupCall._ === 'groupCall') {
        await this.managers.appGroupCallsManager.saveGroupCall(this.groupCall)
        .catch((err) => this.log.warn('recoverConferenceSync: saveGroupCall', err));
      }

      const fresh = await this.managers.appGroupCallsManager.getGroupCallFull(this.id, true)
      .catch((err): undefined => {
        if(!this.requestConferenceRecoveryForForbidden('sync-refresh-forbidden', err)) {
          this.log.warn('recoverConferenceSync: getGroupCallFull failed', err);
        }
        return undefined;
      });
      if(this.conferenceRecoveryDispatched) return;
      if(fresh && fresh._ === 'groupCall') {
        this.groupCall = fresh;
      }

      // Re-kick both pollers now that the cache should be warm. They stamp the
      // watchdog clocks themselves on success, quieting the next tick.
      await Promise.all([this.pollE2eChain(), this.refreshConferenceParticipants()]);

      // Did this recovery actually unstick the clock(s) it fired for? A local
      // re-hydrate cannot fix everything (a chain cursor the server compacted
      // past, a roster it refuses to serve) — after a few unproductive rounds
      // stop looping and rebuild the call, which re-anchors both.
      const now = performance.now();
      const chainStillStale = chainWasStale && now - this.lastChainPollAt >= E2E_SYNC_STALL_MS;
      const participantsStillStale = participantsWereStale && now - this.lastParticipantsRefreshAt >= E2E_SYNC_STALL_MS;
      if(chainStillStale || participantsStillStale) {
        if(++this.unproductiveSyncRecoveries >= UNPRODUCTIVE_SYNC_RECOVERIES_BEFORE_REJOIN) {
          this.unproductiveSyncRecoveries = 0;
          this.requestConferenceRecovery('sync-unrecoverable-locally');
        }
      } else {
        this.unproductiveSyncRecoveries = 0;
      }
    } finally {
      this.recoveringConferenceSync = false;
    }
  }

  private e2eOutboundQueue: Array<{bytes: Uint8Array; height: number; attempts: number}> = [];
  private e2eOutboundFlushPromise: Promise<void> | undefined;
  private e2eOutboundFlushRequested = false;

  private flushE2eOutbound(): Promise<void> {
    this.e2eOutboundFlushRequested = true;
    if(!this.e2eActive || this.e2eActivating) return Promise.resolve();
    if(this.e2eOutboundFlushPromise) return this.e2eOutboundFlushPromise;

    const run = this.flushE2eOutboundLoop().finally(() => {
      if(this.e2eOutboundFlushPromise !== run) return;
      this.e2eOutboundFlushPromise = undefined;
      if(this.e2eOutboundFlushRequested && this.e2e && this.e2eActive) {
        void this.flushE2eOutbound();
      }
    });
    this.e2eOutboundFlushPromise = run;
    return run;
  }

  private async flushE2eOutboundLoop(): Promise<void> {
    while(this.e2eOutboundFlushRequested && this.e2e && this.e2eActive) {
      this.e2eOutboundFlushRequested = false;
      const input = this.toInputGroupCall();
      if(!input) return;

      try {
        const messages = await this.e2e.pullOutbound();
        this.e2eOutboundQueue.push(...messages.map(({bytes, height}) => ({bytes, height, attempts: 0})));
      } catch(err) {
        this.log.error('flushE2eOutbound: pullOutbound failed', err);
        return;
      }

      while(this.e2eOutboundQueue.length && this.e2e) {
        const current = this.e2eOutboundQueue[0];
        const currentHeight = this.e2eStatus?.verification?.height;
        if(currentHeight !== undefined && current.height !== currentHeight) {
          this.e2eOutboundQueue.shift();
          continue;
        }
        try {
          await this.managers.appCallsManager.sendConferenceCallBroadcast(input, current.bytes);
          // A status event can discard this stale item while the request is in
          // flight. Do not shift the newer round that replaced it.
          if(this.e2eOutboundQueue[0] === current) this.e2eOutboundQueue.shift();
        } catch(err) {
          if(this.e2eOutboundQueue[0] !== current) continue;
          if(this.requestConferenceRecoveryForForbidden('broadcast-forbidden', err)) return;
          ++current.attempts;
          if(current.attempts >= E2E_OUTBOUND_MAX_ATTEMPTS) {
            this.e2eOutboundQueue.shift();
            this.log.error('flushE2eOutbound: broadcast exhausted retries', err);
            this.reportConferenceBug(
              'could not publish the e2e verification broadcast after bounded retries',
              {attempts: current.attempts, error: (err as Error)?.message || String(err)}
            );
            continue;
          }

          const delay = E2E_OUTBOUND_RETRY_BASE_MS * (2 ** (current.attempts - 1));
          this.log.warn('flushE2eOutbound: broadcast failed, retrying', {attempt: current.attempts, delay}, err);
          await pause(delay);
        }
      }
    }
  }

  // Serialises application after each subchain's indexed buffer has restored a
  // contiguous prefix. Push and poll can arrive in either order; next_offset
  // is the authoritative index after the last block in each batch.
  private e2eDeliveryQueue = createSerializedQueue();
  // Held so cleanup() can detach it from the global rootScope.
  private chainBlocksListener: ((payload: {callId: GroupCallId; subChainId: number; blocks: Uint8Array[]; nextOffset: number}) => void) | undefined;

  private isValidE2eChainBatch(
    subChainId: number,
    blocks: Uint8Array[],
    nextOffset: number,
    requestedOffset?: number
  ): subChainId is 0 | 1 {
    if(subChainId !== 0 && subChainId !== 1) {
      this.log.warn('deliverE2eChainBlocks: unknown sub_chain_id', subChainId);
      return false;
    }
    if(!Number.isSafeInteger(nextOffset) || nextOffset < blocks.length) {
      this.log.warn('deliverE2eChainBlocks: invalid indexed batch', {subChainId, blocks: blocks.length, nextOffset});
      return false;
    }

    if(requestedOffset !== undefined) {
      const firstOffset = nextOffset - blocks.length;
      // The verification broadcast chain is an append-only mailbox, not the
      // authenticated main blockchain. ImpulseM may compact its old broadcasts
      // and answer the very first offset=0 poll with the retained tail, so its
      // `next_offset` can be much larger than `blocks.length`. Official clients
      // anchor that first response at `next_offset - blocks.length`; rejecting
      // it forever leaves commit/reveal pending and keeps polling offset 0.
      // Main-chain gaps and every later verification gap remain rejected.
      const isInitialVerificationTail =
        subChainId === 1 &&
        requestedOffset === 0 &&
        this.e2eChainOffsets[1] === 0 &&
        firstOffset > 0;
      // A push can advance the live cursor while this request is in flight.
      // The response remains usable when its retained slice covers that live
      // cursor; only its unseen suffix is applied. This is TDLib's
      // `next_offset - current_offset <= blocks.size()` rule. Also require the
      // response not to end before the cursor it was requested for, so an old
      // unrelated slice cannot masquerade as this request's answer.
      const currentOffset = this.e2eChainOffsets[subChainId];
      const coversCurrentOffset = nextOffset <= currentOffset ||
        nextOffset - currentOffset <= blocks.length;
      const matchesRequest = nextOffset >= requestedOffset && coversCurrentOffset;
      if(!Number.isSafeInteger(requestedOffset) ||
         requestedOffset < 0 ||
         (!matchesRequest && !isInitialVerificationTail)) {
        this.log.warn('deliverE2eChainBlocks: response does not match requested cursor', {
          subChainId,
          blocks: blocks.length,
          nextOffset,
          requestedOffset
        });
        return false;
      }
    } else if(!blocks.length && nextOffset !== this.e2eChainOffsets[subChainId]) {
      // A push with no data cannot legitimately move (or rewind) the cursor.
      // Exact empty polls pass their captured requestedOffset above instead.
      this.log.warn('deliverE2eChainBlocks: empty batch does not confirm current cursor', {
        subChainId,
        nextOffset,
        currentOffset: this.e2eChainOffsets[subChainId]
      });
      return false;
    }

    return true;
  }

  private deliverE2eChainBlocks(
    subChainId: number,
    blocks: Uint8Array[],
    nextOffset: number,
    requestedOffset?: number
  ): Promise<boolean> {
    if(!this.isValidE2eChainBatch(subChainId, blocks, nextOffset, requestedOffset)) {
      return Promise.resolve(false);
    }

    const firstOffset = nextOffset - blocks.length;
    if(subChainId === 1 && requestedOffset === 0 && this.e2eChainOffsets[1] === 0 && firstOffset > 0) {
      this.log('conference: anchored initial verification tail at', firstOffset);
      this.advanceE2eChainOffsets({1: firstOffset});
    }
    const pending = this.e2eChainPending[subChainId];
    for(let i = 0; i < blocks.length; ++i) {
      const offset = firstOffset + i;
      if(offset < this.e2eChainOffsets[subChainId] || pending.has(offset)) continue;
      if(pending.size >= MAX_E2E_PENDING_CHAIN_BLOCKS) {
        let farthest = offset;
        for(const candidate of pending.keys()) farthest = Math.max(farthest, candidate);
        if(farthest <= offset) {
          this.reportConferenceBug(
            'the call server announced too many future e2e chain blocks before filling the gap',
            {subChainId, offset: this.e2eChainOffsets[subChainId], pending: pending.size}
          );
          continue;
        }
        pending.delete(farthest);
      }
      pending.set(offset, blocks[i]);
    }

    // The queue itself never rejects — one bad batch must not wedge the rest.
    return this.e2eDeliveryQueue.enqueue(async() => {
      await this.deliverE2eChainBlocksLocked(subChainId);
      return true;
    });
  }

  private async deliverE2eChainBlocksLocked(subChainId: 0 | 1): Promise<void> {
    if(!this.e2e || !this.e2eActive) return;
    const pending = this.e2eChainPending[subChainId];
    while(this.e2e) {
      const offset = this.e2eChainOffsets[subChainId];
      const block = pending.get(offset);
      if(!block) return;

      try {
        if(subChainId === 0) {
          await this.e2e.applyBlock({serverBlock: block});
        } else {
          const result = await this.e2e.receiveInbound({serverMessage: block});
          if(result.disposition === 'dropped') {
            // Consumed all the same: the cursor MUST move past it. Parking on a
            // broadcast the buffer refused re-delivered it on every poll and
            // queued every later honest commit/reveal behind it — one message
            // from any participant silenced the emoji fingerprint for good.
            this.reportConferenceBug(
              'a verification broadcast was dropped (far-future height or buffer overflow)',
              {offset, height: result.status.height}
            );
          }
        }
      } catch(err) {
        if(this.conferenceRecoveryDispatched) return;
        this.log.error(
          subChainId === 0 ?
            'deliverE2eChainBlocks: applyBlock failed' :
            'deliverE2eChainBlocks: receiveInbound failed',
          err
        );
        // Keep this exact index queued and keep the cursor in place. Advancing
        // would turn an application failure into a permanently skipped block.
        // A main-chain failure while the post-accept gate is opening is fatal:
        // reject the join transaction synchronously so it owns the one rollback
        // instead of continuing SDP and racing a worker-event leave.
        if(subChainId === 0 && this.e2eActivating) {
          this.e2eFatalError ??= err instanceof Error ? err : new Error(String(err));
          throw this.e2eFatalError;
        }
        return;
      }

      pending.delete(offset);
      this.e2eChainOffsets[subChainId] = offset + 1;
    }
  }

  private drainE2eChainPending(): Promise<void> {
    return this.e2eDeliveryQueue.enqueue(async() => {
      await this.deliverE2eChainBlocksLocked(0);
      await this.deliverE2eChainBlocksLocked(1);
    });
  }

  // Convenience: build an InputGroupCall from our cached groupCall payload.
  // Returns undefined for discarded calls (no access_hash).
  public toInputGroupCall(): InputGroupCall | undefined {
    const c = this.groupCall;
    if(!c || c._ === 'groupCallDiscarded') return undefined;
    return groupCallToInput(c);
  }

  /**
   * The LiveKit connection of the main media, in the vocabulary the call UI reads: `undefined` before the
   * connection exists, `connecting` until it is up (and while it reconnects), `closed` once it is gone.
   */
  get connectionState(): 'connecting' | 'connected' | 'closed' | undefined {
    const connection = this.connections.main;
    if(!connection) {
      return undefined;
    }

    switch(connection.transportState) {
      case 'connected':
        return 'connected';
      case 'disconnected':
        // a connection that was lost is not the end of the call while a rejoin may still replace it
        return this.hungUp || connection.transport.disconnectCause === 'client' ? 'closed' : 'connecting';
      default:
        return 'connecting';
    }
  }

  /** The call is over locally: a lost connection no longer reads as "reconnecting". */
  public markHungUp(): void {
    this.hungUp = true;
  }

  get state() {
    const {connectionState} = this;
    if(connectionState === 'closed') {
      return GROUP_CALL_STATE.CLOSED;
    } else if(connectionState !== 'connected') {
      return GROUP_CALL_STATE.CONNECTING;
    } else {
      const {participant} = this;
      // Conference invitee paths may reach `connected` before the server
      // sends our self-participant update (the SFU lists us in the next
      // `phone.getGroupCallParticipants` reply, which lands after the SDP
      // exchange completes). Treat "connected but no self yet" as MUTED —
      // we asked to join muted, and waiting for the participant payload
      // is purely informational.
      if(!participant) {
        return GROUP_CALL_STATE.MUTED;
      }
      if(!participant.pFlags.can_self_unmute) {
        return GROUP_CALL_STATE.MUTED_BY_ADMIN;
      }

      // Only claim UNMUTED if the capture track really is live. This getter
      // drives the microphone indicator, and it used to trust our own
      // participant row alone — a row the server supplies and
      // `saveApiParticipant` replaces wholesale, including swapping the whole
      // `pFlags` object and synthesising `can_self_unmute` when a minimal row
      // carries neither flag. A `left` row for our own peer therefore dropped
      // `muted: true` and flipped the button to "unmuted" while the track
      // stayed disabled: the UI told the user their microphone was open when it
      // was not. Between the row and the track, the track is the truth.
      return this.isMuted ? GROUP_CALL_STATE.MUTED : GROUP_CALL_STATE.UNMUTED;
    }
  }

  // Whether our own audio is actually being captured and sent. `setMuted`
  // toggles `track.enabled`, so this is what the microphone indicator must
  // reflect. Undefined-safe: before the connection exists there is no track,
  // and "no track" is not "transmitting".
  private isCaptureLive(): boolean {
    const tracks = this.connections.main?.streamManager?.inputStream?.getAudioTracks?.();
    if(!tracks?.length) {
      return false;
    }

    tracks.forEach((track) => this.observeInputAudioTrack(track));
    return tracks.some((track) => track.enabled && this.isInputTrackAvailable(track));
  }

  private observeInputAudioTrack(track: MediaStreamTrack | undefined): void {
    if(!track || this.observedInputAudioTracks.has(track)) return;
    this.observedInputAudioTracks.add(track);

    const dispatchCaptureState = () => {
      if(!this.isClosing) this.dispatchEvent('state', this.state);
    };
    track.addEventListener('mute', dispatchCaptureState);
    track.addEventListener('unmute', dispatchCaptureState);
    track.addEventListener('ended', dispatchCaptureState, {once: true});
  }

  get participants() {
    return this.managers.appGroupCallsManager.getCachedParticipants(this.id);
  }

  get isSharingScreen() {
    return !!this.connections.presentation;
  }

  public get joined(): boolean {
    return this._joined;
  }

  public set joined(joined: boolean) {
    if(this._joined === joined) return;
    this._joined = joined;
    this.dispatchEvent('state', this.state);
  }

  /**
   * Camera/screen runtime mutations are safe only after transport join and the
   * canonical self participant have both arrived. Changes are observable via
   * the existing `state` event.
   */
  public get isMediaRuntimeReady(): boolean {
    return this.joined && !!this.participant?.pFlags?.self && !this.isClosing;
  }

  /** The latest pin whose video is here: a screen auto-pinned from its row waits for its track. */
  get pinnedSource(): GroupCallOutputSource | undefined {
    for(let i = this.pinnedSources.length - 1; i >= 0; --i) {
      const source = this.pinnedSources[i];
      if(this.getElement(source)) {
        return source;
      }
    }

    return undefined;
  }

  public get isMuted() {
    const participant = this.participant;
    return !participant?.pFlags.can_self_unmute ||
      !!participant.pFlags.muted ||
      !this.isCaptureLive();
  }

  public get isClosing() {
    const {state} = this;
    return state === GROUP_CALL_STATE.CLOSED;
  }

  public get streamManager(): StreamManager {
    return this.connections.main.streamManager;
  }

  public pinSource(source: GroupCallOutputSource) {
    indexOfAndSplice(this.pinnedSources, source);
    this.pinnedSources.push(source);
    this.applyRemoteVideoQuality();
    this.dispatchPinnedThrottled();
  }

  public unpinSource(source: GroupCallOutputSource) {
    this.hadAutoPinnedSources.delete(source);
    indexOfAndSplice(this.pinnedSources, source);
    this.applyRemoteVideoQuality();
    this.dispatchPinnedThrottled();
  }

  public unpinAll() {
    this.pinnedSources.length = 0;
    this.applyRemoteVideoQuality();
    this.dispatchPinnedThrottled();
  }

  /** The pinned tile is received in high quality, every other remote video in medium. */
  private applyRemoteVideoQuality(): void {
    const transport = this.connections.main?.transport;
    if(!transport) {
      return;
    }

    const pinned = this.pinnedSource;
    for(const route of this.mediaRouter.getVideoRoutes()) {
      transport.setRemoteVideoQuality({
        identity: route.identity,
        source: route.mediaSource,
        quality: pinned !== undefined && route.key === String(pinned) ? 'high' : 'medium'
      });
    }
  }

  public async getParticipantByPeerId(peerId: PeerId) {
    if(NULL_PEER_ID === peerId) {
      return this.participant;
    }

    // Real SFU rows win: once a chain-only member finally shows up on the
    // roster, their live state takes over the row in place.
    return (await this.participants).get(peerId) ?? this.membersWithAccess.get(peerId);
  }

  public toggleMuted() {
    return this.requestAudioSource(true).then(() => {
      // Decide from the capture-backed state, not only participant.pFlags.
      // A delayed/minimal self row can claim "unmuted" while the local track
      // is still disabled; in that state inverting pFlags sends another mute
      // and makes it impossible for the user to open their microphone.
      return this.changeUserMuted(NULL_PEER_ID, !this.isMuted);
    });
  }

  public changeUserMuted(peerId: PeerId, muted?: boolean): Promise<void> {
    if(NULL_PEER_ID === peerId) {
      return this.selfMuteTransitionTail.enqueue(() => this.changeSelfMuted(muted));
    }

    return this.changeOtherParticipantMuted(peerId, muted);
  }

  private async changeOtherParticipantMuted(peerId: PeerId, muted?: boolean): Promise<void> {
    const participant = await this.getParticipantByPeerId(peerId);
    await this.editParticipant(participant, {muted});
  }

  private async changeSelfMuted(muted?: boolean): Promise<void> {
    const participant = await this.getParticipantByPeerId(NULL_PEER_ID);
    if(participant.pFlags.can_self_unmute) {
      muted = muted === undefined ? !participant.pFlags.muted : muted;
    }

    if(muted === undefined) {
      await this.editParticipant(participant, {muted});
      return;
    }

    // Muting is safety-sensitive: cut capture before the worker/RPC roundtrip.
    // Unmuting is the inverse transaction — keep every track disabled until
    // phone.editGroupCallParticipant has actually accepted the change. The
    // worker update processing is deliberately non-optimistic for this path,
    // so a revision change while the RPC is in flight proves a newer server
    // row arrived and must win over any rejection rollback.
    const participantRevision = this.selfParticipantRevision;
    const previousPFlags = {...participant.pFlags};
    if(muted) {
      // An explicit mute always cancels a still-armed unmute intent.
      this.pendingUnmuteIntentAt = undefined;
      this.setMuted(true);
      this.dispatchEvent('state', this.state);
    }

    try {
      await this.editParticipant(participant, {muted}, false);
      // When no self row landed during the RPC, the accepted state lives on
      // `participant` (editParticipant already applied the accepted pFlags to
      // it) — trust it. When a row DID land, the newest row wins so a genuinely
      // newer admin mute stays fail-closed; if that row is a stale "muted" echo
      // computed before our acceptance, the armed intent below lets the next
      // consistent self row open capture instead of losing the unmute forever.
      const currentParticipant = this.selfParticipantRevision === participantRevision ?
        participant :
        (this.participant || participant);
      if(!muted) {
        if(currentParticipant.pFlags.can_self_unmute && !currentParticipant.pFlags.muted) {
          this.pendingUnmuteIntentAt = undefined;
          this.setMuted(false);
          this.dispatchEvent('state', this.state);
        } else if(currentParticipant.pFlags.can_self_unmute) {
          this.pendingUnmuteIntentAt = performance.now();
        }
      }
    } catch(err) {
      // A failed microphone mutation must remain locally fail-closed. This
      // preserves an explicit mute request and prevents a rejected unmute or a
      // late thin participant row from opening current/pending capture tracks.
      this.pendingUnmuteIntentAt = undefined;
      this.setMuted(true);
      if(this.selfParticipantRevision === participantRevision && this.participant === participant) {
        participant.pFlags = {...previousPFlags};
        try {
          await this.managers.appGroupCallsManager.saveApiParticipant(this.id, participant);
        } catch(rollbackError) {
          this.log.error('mute participant rollback failed', rollbackError);
        }
      }
      this.dispatchEvent('state', this.state);
      throw err;
    }
  }

  public getElement(endpoint: GroupCallOutputSource) {
    return super.getElement(endpoint);
  }

  public getVideoElementFromParticipantByType(participant: GroupCallParticipant, type: 'video' | 'presentation') {
    let source: GroupCallOutputSource;
    if(participant.pFlags.self) {
      const connectionType: GroupCallConnectionType = type === 'video' ? 'main' : 'presentation';
      source = connectionType;
    } else {
      source = getParticipantOutputSource(participant, type);
      if(source === undefined) return;
    }

    const element = this.getElement(source) as HTMLVideoElement;
    if(!element) return;

    const clone = element.cloneNode() as typeof element;
    clone.srcObject = element.srcObject;
    return {video: clone, source};
  }

  public createConnectionInstance(options: {
    streamManager: StreamManager,
    type: GroupCallConnectionType,
    options: GroupCallConnectionOptions,
  }) {
    const connection = this.connections[options.type] = new GroupCallConnectionInstance({
      groupCall: this,
      log: this.log.bindPrefix(options.type),
      managers: this.managers,
      ...options
    });
    if(options.type === 'main') {
      this.observeInputAudioTrack(options.streamManager.inputStream.getAudioTracks()[0]);
      this.bindMainTransport(connection);
    }
    return connection;
  }

  // Everything remote arrives on the main connection: tracks go to the media router.
  private bindMainTransport(connection: GroupCallConnectionInstance): void {
    const {transport} = connection;
    const isCurrent = () => this.connections.main === connection;
    transport.addEventListener('remoteTrack', (info) => {
      if(isCurrent()) this.mediaRouter.onRemoteTrack(info);
    });
    transport.addEventListener('remoteTrackRemoved', (info) => {
      if(isCurrent()) this.mediaRouter.onRemoteTrackRemoved(info);
    });
    transport.addEventListener('activeSpeakers', (identities) => {
      if(isCurrent()) this.onActiveSpeakers(identities);
    });
    transport.addEventListener('publishPermission', ({canPublish}) => {
      if(isCurrent()) this.onPublishPermission(canPublish);
    });
    transport.addEventListener('state', (state) => {
      // the token can already forbid publishing at join (forced mute): reconcile with it once connected
      const permission = state === 'connected' && isCurrent() ? transport.getPublishPermission() : undefined;
      if(permission) this.onPublishPermission(permission.canPublish);
    });
  }

  /** Whether LiveKit currently reports `peerId` as speaking (a presentation never speaks for its owner). */
  public isSpeaking(peerId: PeerId): boolean {
    return this.speakingPeerIds.has(peerId);
  }

  private onActiveSpeakers(identities: string[]): void {
    const peerIds = new Set<PeerId>();
    for(const identity of identities) {
      const parsed = parseGroupCallIdentity(identity);
      if(parsed && !parsed.isPresentation) {
        peerIds.add(parsed.peerId);
      }
    }

    const changed = peerIds.size !== this.speakingPeerIds.size ||
      [...peerIds].some((peerId) => !this.speakingPeerIds.has(peerId));
    if(!changed) {
      return;
    }

    this.speakingPeerIds = peerIds;
    rootScope.dispatchEvent('group_call_speaking', {groupCallId: this.id, peerIds: [...peerIds]});
  }

  private clearSpeaking(): void {
    if(this.speakingPeerIds.size) {
      this.speakingPeerIds = new Set();
      rootScope.dispatchEvent('group_call_speaking', {groupCallId: this.id, peerIds: []});
    }
  }

  /** Forgets everything rendered for remote participants (a rejoin re-delivers it on the new connection). */
  public resetRemoteMedia(): void {
    for(const route of this.mediaRouter.getRoutes()) {
      this.removeOutputTrack(route.key, route.kind);
    }

    this.mediaRouter.clear();
    this.clearSpeaking();
  }

  // The microphone track's enabled flag is the local mute; the transport mirrors it so the server and the
  // other participants see the track muted as well.
  public setMuted(muted?: boolean): void {
    super.setMuted(muted);

    const connectionInstance = this.connections.main;
    if(!connectionInstance) {
      return;
    }

    const audioTrack = connectionInstance.streamManager?.inputStream?.getAudioTracks?.()[0];
    void connectionInstance.syncMicrophone(!audioTrack?.enabled).catch((err) => {
      // the local capture is already cut (or opened): a failed sync must not leave the UI believing
      // otherwise, so it is only reported
      this.log.warn('syncing the microphone mute to the server failed', err);
    });
  }

  public changeRaiseHand(raise: boolean) {
    return this.editParticipant(this.participant, {raiseHand: raise});
  }

  private assertMediaRuntimeReady(): void {
    if(!this.isMediaRuntimeReady) {
      throw new Error('Conference media is not ready until join and the self participant are confirmed');
    }
    if(!this.participant.pFlags.can_self_unmute) {
      throw new Error('Conference media cannot start while the participant is muted by an admin');
    }
  }

  private enqueuePresentationTransition(operation: () => Promise<void>): Promise<void> {
    return this.presentationTransitionTail.enqueue(operation);
  }

  private leavePresentationConnection(connectionInstance: GroupCallConnectionInstance): Promise<void> {
    if(!connectionInstance.joinAccepted || this.completedPresentationLeaves.has(connectionInstance)) {
      return Promise.resolve();
    }

    const pending = this.presentationLeavePromises.get(connectionInstance);
    if(pending) return pending;

    const acceptedCallInput = connectionInstance.acceptedCallInput ?? this.toInputGroupCall();
    if(!acceptedCallInput) {
      return Promise.reject(new Error('Cannot leave presentation without its accepted call identity'));
    }

    this.pendingPresentationLeaves.add(connectionInstance);
    const leave = this.managers.appGroupCallsManager.leaveGroupCallPresentation(acceptedCallInput).then(() => {
      this.completedPresentationLeaves.add(connectionInstance);
      this.pendingPresentationLeaves.delete(connectionInstance);
    }).finally(() => {
      this.presentationLeavePromises.delete(connectionInstance);
    });
    this.presentationLeavePromises.set(connectionInstance, leave);
    return leave;
  }

  private async drainPendingPresentationLeaves(): Promise<void> {
    for(const connectionInstance of [...this.pendingPresentationLeaves]) {
      await this.leavePresentationConnection(connectionInstance);
    }
  }

  private async removePresentationConnection(
    connectionInstance: GroupCallConnectionInstance,
    leaveServer: boolean
  ): Promise<void> {
    const isCurrent = this.connections.presentation === connectionInstance;
    if(isCurrent) {
      delete this.connections.presentation;
      this.unpinSource('presentation');
    }

    if(!this.closedPresentationConnections.has(connectionInstance)) {
      this.closedPresentationConnections.add(connectionInstance);
      connectionInstance.closeConnectionAndStream(true);
    }

    let saveParticipant: Promise<void> | undefined;
    if(isCurrent && this.participant?.presentation) {
      delete this.participant.presentation;
      saveParticipant = this.managers.appGroupCallsManager.saveApiParticipant(this.id, this.participant);
    }
    if(isCurrent) this.dispatchEvent('state', this.state);

    if(saveParticipant) {
      void saveParticipant.catch((err) => {
        this.log.error('save detached presentation participant failed', err);
      });
    }

    // A failed initial negotiation can happen after phone.joinGroupCall already
    // accepted the presentation source but before answer SDP was installed.
    // stopScreenSharing may have already detached the local connection while
    // that RPC was in flight. Re-check acceptance on the later rollback and
    // compensate exactly once even though the connection is no longer current.
    if(leaveServer) await this.leavePresentationConnection(connectionInstance);
  }

  private bindPresentationRuntimeRecovery(connectionInstance: GroupCallConnectionInstance): void {
    const recover = (label: string, err?: unknown) => {
      if(this.connections.presentation !== connectionInstance || this.isClosing) return;
      if(err) this.log.error(label, err);
      else this.log.warn(label);
      void this.recoverPresentationConnection(connectionInstance).catch((recoveryError) => {
        this.log.error('screen sharing recovery failed', recoveryError);
      });
    };

    connectionInstance.transport.addEventListener('state', (state, cause) => {
      // 'client' is our own close; everything else (network loss, the token being refused, removal from
      // the room) leaves the screen without a transport while the capture is still alive
      if(state === 'disconnected' && cause !== 'client') {
        recover(`screen sharing transport lost (${cause})`);
      }
    });
  }

  public recoverPresentationConnection(expectedConnection: GroupCallConnectionInstance): Promise<void> {
    if(this.connections.presentation !== expectedConnection || this.isClosing) {
      return Promise.resolve();
    }
    if(this.presentationRecoveryPromise) return this.presentationRecoveryPromise;

    const generation = this.screenSharingGeneration;
    const recovery = this.enqueuePresentationTransition(() => {
      return this.recoverPresentationConnectionInternal(expectedConnection, generation);
    });
    const trackedRecovery = recovery.finally(() => {
      if(this.presentationRecoveryPromise === trackedRecovery) {
        this.presentationRecoveryPromise = undefined;
      }
    });
    this.presentationRecoveryPromise = trackedRecovery;
    return trackedRecovery;
  }

  private async recoverPresentationConnectionInternal(
    expectedConnection: GroupCallConnectionInstance,
    generation: number
  ): Promise<void> {
    if(generation !== this.screenSharingGeneration ||
       this.connections.presentation !== expectedConnection ||
       this.isClosing) {
      return;
    }
    await this.drainPendingPresentationLeaves();

    const streamManager = expectedConnection.streamManager;
    const videoTrack = streamManager.inputStream.getVideoTracks()[0];
    if(!videoTrack || videoTrack.readyState === 'ended') {
      await this.removePresentationConnection(expectedConnection, true);
      return;
    }

    // Preserve the active capture and rebuild only the missing presentation
    // transport. Reopening getDisplayMedia here would show a second picker and
    // discard a perfectly healthy screen track.
    this.closedPresentationConnections.add(expectedConnection);
    expectedConnection.closeConnectionAndStream(false);

    let replacement: GroupCallConnectionInstance | undefined;
    try {
      replacement = this.createConnectionInstance({
        streamManager,
        type: 'presentation',
        options: {type: 'presentation'}
      });
      await replacement.join();
      await replacement.publishScreen(streamManager.inputStream);

      if(generation !== this.screenSharingGeneration ||
         this.connections.presentation !== replacement ||
         !this.isMediaRuntimeReady) {
        throw new Error('Screen sharing recovery was cancelled while reconnecting');
      }
      this.bindPresentationRuntimeRecovery(replacement);
      this.dispatchEvent('state', this.state);
    } catch(err) {
      let cleanupError: unknown;
      if(!replacement) streamManager.stop();
      if(replacement) {
        try {
          await this.removePresentationConnection(replacement, true);
        } catch(rollbackError) {
          this.log.error('screen sharing recovery rollback failed', rollbackError);
          cleanupError = rollbackError;
        }
      }
      if(!replacement?.joinAccepted) {
        try {
          await this.removePresentationConnection(expectedConnection, true);
        } catch(rollbackError) {
          this.log.error('stale presentation leave failed', rollbackError);
          cleanupError ??= rollbackError;
        }
      }
      if(cleanupError) {
        throw mediaCleanupError('Screen sharing recovery and cleanup failed', err, cleanupError);
      }
      throw err;
    }
  }

  private async removeInputTracks(
    connectionInstance: GroupCallConnectionInstance,
    tracks: MediaStreamTrack[]
  ): Promise<void> {
    for(const track of tracks) {
      stopTrack(track);
      connectionInstance.streamManager.removeTrack(track);
    }

    // a stopped capture must stop being sent as well: the camera of the main connection, or the screen of
    // the presentation one
    if(connectionInstance.type === 'presentation') {
      await connectionInstance.unpublish('screen');
      await connectionInstance.unpublish('screenAudio');
    } else if(tracks.some((track) => track.kind === 'video')) {
      await connectionInstance.unpublish('camera');
    }

    this.dispatchEvent('state', this.state);
  }

  public async startScreenSharingInternal(generation = this.screenSharingGeneration, acquiredStream?: MediaStream): Promise<void> {
    let stream: MediaStream | undefined = acquiredStream;
    let connectionInstance: GroupCallConnectionInstance | undefined;
    try {
      const type: GroupCallConnectionType = 'presentation';

      // Staleness first: a generation bumped while the picker was open (stop,
      // admin mute, hangUp) must surface as cancellation, not as whatever
      // runtime-readiness error that later teardown also produced.
      if(generation !== this.screenSharingGeneration) {
        throw new Error('Screen sharing request was cancelled before media became ready');
      }
      this.assertMediaRuntimeReady();
      await this.drainPendingPresentationLeaves();
      stream ??= await getScreenStream(getGroupScreenConstraints());
      // The screen-picker can stay open for seconds; the user can hang up
      // before it resolves. hangUp() already walked this.connections and never
      // saw the presentation connection (it didn't exist yet), so building it
      // now would leave the screen capture live forever — release and bail.
      if(generation !== this.screenSharingGeneration || !this.isMediaRuntimeReady) {
        throw new Error('Screen sharing request was cancelled before media became ready');
      }
      const videoTrack = stream.getVideoTracks()[0];
      if(!videoTrack) throw new Error('Screen capture did not provide a video track');
      const streamManager = new StreamManager();

      connectionInstance = this.createConnectionInstance({
        streamManager,
        type,
        options: {
          type
        }
      });

      videoTrack.addEventListener('ended', () => {
        if(this.connections.presentation) { // maybe user has stopped screensharing through browser's ui
          void this.stopScreenSharing().catch((err) => this.log.error('stop screen sharing after capture ended', err));
        }
      }, {once: true});

      await connectionInstance.join();
      await connectionInstance.addInputVideoStream(stream);

      if(generation !== this.screenSharingGeneration || !this.isMediaRuntimeReady) {
        throw new Error('Screen sharing request was cancelled while connecting');
      }
      this.bindPresentationRuntimeRecovery(connectionInstance);
    } catch(err) {
      this.log.error('start screen sharing error', err);
      let cleanupError: unknown;
      if(connectionInstance) {
        try {
          await this.removePresentationConnection(connectionInstance, true);
        } catch(rollbackError) {
          this.log.error('start screen sharing rollback failed', rollbackError);
          cleanupError = rollbackError;
        }
      }
      // The failure may precede addInputVideoStream, in which case closing the
      // connection's still-empty StreamManager cannot release the capture.
      stream?.getTracks().forEach((track) => {
        if(track.readyState !== 'ended') stopTrack(track);
      });
      if(cleanupError) {
        throw mediaCleanupError('Screen sharing start and cleanup failed', err, cleanupError);
      }
      throw err;
    }
  }

  public startScreenSharing() {
    if(this.startScreenSharingPromise &&
       this.startScreenSharingPromiseGeneration === this.screenSharingGeneration) {
      return this.startScreenSharingPromise;
    }
    const generation = ++this.screenSharingGeneration;
    // Acquire OUTSIDE the presentation transition tail. getDisplayMedia blocks
    // until the user acts on the picker, and everything queued behind it —
    // stopScreenSharing, and through it the hangUp/recovery cleanup that awaits
    // the tail — would sit frozen exactly as long: a conference recovery fired
    // while the picker was open used to leave a dead call (transport already
    // closed, rejoin unable to start) until the picker was dismissed.
    const start = (async() => {
      this.assertMediaRuntimeReady();
      const stream = await getScreenStream(getGroupScreenConstraints());
      return this.enqueuePresentationTransition(() => this.startScreenSharingInternal(generation, stream));
    })();
    const trackedStart = start.finally(() => {
      if(this.startScreenSharingPromise === trackedStart) {
        this.startScreenSharingPromise = undefined;
      }
    });
    this.startScreenSharingPromiseGeneration = generation;
    this.startScreenSharingPromise = trackedStart;
    return trackedStart;
  }

  public stopScreenSharing() {
    ++this.screenSharingGeneration;
    const connectionInstance = this.connections.presentation;
    // Detach synchronously so UI/capture state flips at once, but serialize the
    // source-less leave RPC behind any in-flight join/recovery. A late leave for
    // an old accepted source must complete before a new presentation can join,
    // otherwise phone.leaveGroupCallPresentation would tear down the new one.
    const detach = connectionInstance ?
      this.removePresentationConnection(connectionInstance, false) :
      Promise.resolve();

    return this.enqueuePresentationTransition(async() => {
      await detach;
      if(connectionInstance) await this.removePresentationConnection(connectionInstance, true);
      await this.drainPendingPresentationLeaves();
    });
  }

  public toggleScreenSharing() {
    if(this.isSharingScreen) {
      return this.stopScreenSharing();
    } else {
      return this.startScreenSharing();
    }
  }

  public async startVideoSharingInternal(generation = this.videoSharingGeneration): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: getVideoConstraints()
    };

    this.assertMediaRuntimeReady();
    const participant = this.participant;
    const previousVideo = participant.video;
    const hadPreviousVideo = Object.prototype.hasOwnProperty.call(participant, 'video');
    let participantEditStarted = false;
    let mediaStoppedDuringCancellation = false;
    let stream: MediaStream | undefined;
    let connectionInstance: GroupCallConnectionInstance | undefined;
    try {
      stream = await getStream(constraints, false);
      // The call can be hung up during the `getUserMedia` window. After that
      // cleanup() has already run streamManager.stop(), so adding this stream
      // would leak the camera (LED stuck on) — release it instead.
      if(generation !== this.videoSharingGeneration || !this.isMediaRuntimeReady) {
        throw new Error('Camera request completed after conference media stopped being ready');
      }
      if(!stream.getVideoTracks()[0]) throw new Error('Camera capture did not provide a video track');
      connectionInstance = this.connections.main;
      await connectionInstance.addInputVideoStream(stream);

      if(generation !== this.videoSharingGeneration || !this.isMediaRuntimeReady) {
        throw new Error('Camera sharing request was cancelled while publishing');
      }

      participantEditStarted = true;
      await this.editParticipant(participant, {
        videoPaused: false,
        videoStopped: false
      });
      participantEditStarted = false;

      // An admin mute/user stop can land after negotiation but while the
      // participant RPC is in flight. The start RPC may still be accepted
      // after that newer stop, so publish a final stopped state and remove the
      // sender again before reporting cancellation.
      if(generation !== this.videoSharingGeneration ||
         !this.isMediaRuntimeReady ||
         !this.participant.pFlags.can_self_unmute) {
        const cancellationError = new Error('Camera sharing was cancelled while publishing participant state');
        try {
          // An admin mute already owns a retrying stop transaction. Await that
          // exact compensation instead of publishing a duplicate stopped edit;
          // an ordinary user cancellation has no such owner and compensates here.
          if(this.adminMediaTeardownPromise) {
            await this.adminMediaTeardownPromise;
          } else {
            await this.stopVideoSharing(true);
          }
          mediaStoppedDuringCancellation = true;
        } catch(cleanupError) {
          throw mediaCleanupError('Camera sharing cancellation cleanup failed', cancellationError, cleanupError);
        }
        throw cancellationError;
      }
    } catch(err) {
      this.log.error('startVideoSharing error', err, constraints);
      let participantRollbackPromise: Promise<void> | undefined;
      if(participantEditStarted && this.participant === participant) {
        if(hadPreviousVideo) participant.video = previousVideo;
        else delete participant.video;
        participantRollbackPromise = (async() => {
          try {
            await this.managers.appGroupCallsManager.saveApiParticipant(this.id, participant);
          } catch(rollbackError) {
            this.log.error('startVideoSharing participant rollback failed', rollbackError);
          }
        })();
        this.dispatchEvent('state', this.state);
      }
      if(connectionInstance && stream && !mediaStoppedDuringCancellation) {
        try {
          await this.removeInputTracks(connectionInstance, stream.getTracks());
        } catch(rollbackError) {
          this.log.error('startVideoSharing rollback failed', rollbackError);
        }
      } else if(stream && !mediaStoppedDuringCancellation) {
        stream.getTracks().forEach((track) => stopTrack(track));
      }
      await participantRollbackPromise;
      throw err;
    }
  }

  public startVideoSharing() {
    if(this.startVideoSharingPromise) return this.startVideoSharingPromise;
    const generation = ++this.videoSharingGeneration;
    return this.startVideoSharingPromise = this.startVideoSharingInternal(generation).finally(() => {
      this.startVideoSharingPromise = undefined;
    });
  }

  public async stopVideoSharing(
    forceParticipantUpdate = false,
    shouldContinue: () => boolean = () => true
  ) {
    ++this.videoSharingGeneration;
    const connectionInstance = this.connections.main;
    const track = connectionInstance.streamManager.inputStream.getVideoTracks()[0];
    const shouldPublishStopped = forceParticipantUpdate || !!track || !!this.participant?.video;
    if(!shouldPublishStopped) {
      return;
    }

    // `stopTrack` only flips `readyState` to "ended"; the StreamItem and the
    // track stay in `streamManager` until the asynchronous `ended` event
    // listener fires later. We do it synchronously here so that:
    //   1. `isSharingVideo` (which reads streamManager.items) flips to
    //      `false` immediately — without this, a fast follow-up
    //      toggleVideoSharing() click reads stale `true` and ends up calling
    //      stopVideoSharing() again instead of startVideoSharing(), and the
    //      toggle "does nothing".
    //   2. `appendToConference` below iterates `inputStream.getTracks()` to
    //      pick a replacement; if the stopped track is still listed, it
    //      replaces senders with the stopped track instead of `undefined`
    //      (the "clear sender" comment) — and remote sees a frozen frame
    //      until the next negotiation. Removing it makes `findIndex` return
    //      -1, so `appendToConference` correctly clears the sender.
    // The async `ended` listener still fires later; removeTrack is idempotent.
    if(track) await this.removeInputTracks(connectionInstance, [track]);

    // An authoritative unmute can supersede an admin teardown while the
    // sender replacement above is still in flight. The user may already have
    // started a newer camera track by the time it resolves; never let the old
    // transaction publish `videoStopped` after that newer start.
    if(!shouldContinue()) return;

    await this.editParticipant(this.participant, {
      videoStopped: true
    });
  }

  public toggleVideoSharing() {
    if(this.isSharingVideo) {
      return this.stopVideoSharing();
    } else {
      return this.startVideoSharing();
    }
  }

  // CallInstanceBase hook for mid-call device swap. Walks every connection
  // we own (main + presentation) so screen-sharing keeps working when the
  // user picks a different camera while presenting. A connection that does not
  // send `oldTrack` is skipped: a later publish picks up the new capture from
  // the stream manager.
  protected async replaceSenderTrack(
    kind: 'audio' | 'video',
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ): Promise<void> {
    if(kind === 'audio') this.observeInputAudioTrack(newTrack);
    const sources: LiveKitMediaSource[] = kind === 'audio' ? ['microphone'] : ['camera', 'screen'];
    const replacements: Promise<void>[] = [];
    for(const type in this.connections) {
      const connectionInstance = this.connections[type as GroupCallConnectionType];
      if(!connectionInstance) continue;
      for(const source of sources) {
        replacements.push(connectionInstance.replaceTrack({source, oldTrack, newTrack}).then((): void => undefined));
      }
    }
    await waitForMediaTrackReplacements(replacements);
  }

  // CallInstanceBase hook: a capture that arrives after the join (the microphone requested on the first
  // unmute, say) is published on the main connection.
  protected async publishInputStream(stream: MediaStream): Promise<void> {
    const connectionInstance = this.connections.main;
    const audio = stream.getAudioTracks()[0];
    if(connectionInstance && audio) {
      this.observeInputAudioTrack(audio);
      await connectionInstance.syncMicrophone(!audio.enabled, audio);
    }
  }

  public async hangUp(discard = false, rejoin = false, isDiscarded = false) {
    if(rejoin || isDiscarded) {
      return this.closeAndLeave(discard, rejoin, isDiscarded);
    }

    let settleLeave: () => void;
    this.leaveSettled = new Promise<void>((resolve) => settleLeave = resolve);
    try {
      return await this.closeAndLeave(discard, rejoin, isDiscarded);
    } finally {
      settleLeave();
    }
  }

  private async closeAndLeave(discard: boolean, rejoin: boolean, isDiscarded: boolean) {
    if(!rejoin) {
      this.markHungUp();
    }

    const presentationCleanup = this.stopScreenSharing();
    for(const type in this.connections) {
      const connection = this.connections[type as GroupCallConnectionType];
      connection.closeConnectionAndStream(!rejoin);
    }

    this.dispatchEvent('state', this.state);

    if(isDiscarded) {
      try {
        await presentationCleanup;
      } catch(err) {
        this.log.error('presentation cleanup during conference recovery failed', err);
        try {
          // Recovery replaces the main transport instead of sending a main
          // leave, so it cannot rely on that RPC to remove a stale presentation
          // source. Retry the exact accepted presentation identity, but do not
          // strand the whole main recovery if the presentation RPC stays down.
          await this.retryMediaTeardown(
            'presentation cleanup during conference recovery',
            () => this.stopScreenSharing()
          );
        } catch(retryError) {
          this.log.error('presentation cleanup exhausted during conference recovery', retryError);
        }
      }
      return;
    }

    if(!rejoin) {
      let d: Parameters<AppGroupCallsManager['hangUp']>[1];
      try {
        d = discard || (/* this.joined ?  */this.connections.main.sources.audio.source/*  : undefined */);
      } catch(err) {
        d = 0;
      }

      const [presentationResult, leaveResult] = await Promise.allSettled([
        presentationCleanup,
        this.managers.appGroupCallsManager.hangUp(this.id, d)
      ]);
      if(leaveResult.status === 'rejected') throw leaveResult.reason;
      if(presentationResult.status === 'rejected') {
        // The main leave removes every source, so a presentation-specific
        // failure is reconciled once the main RPC succeeds.
        this.log.error('presentation cleanup failed before main leave', presentationResult.reason);
      }
    } else {
      await presentationCleanup;
    }
  }

  private hangUpAfterFatalFailure(): void {
    if(this.fatalHangUpStarted) return;
    this.fatalHangUpStarted = true;
    try {
      void (this.hangUp() as Promise<void> | undefined)?.catch((err) => {
        this.log.error('leave after fatal conference failure failed', err);
      });
    } catch(err) {
      this.log.error('leave after fatal conference failure failed', err);
    }
  }

  private async retryMediaTeardown(
    label: string,
    operation: () => Promise<void>,
    shouldContinue: () => boolean = () => true
  ): Promise<void> {
    let lastError: unknown;
    for(let attempt = 0; attempt < MEDIA_TEARDOWN_MAX_ATTEMPTS; ++attempt) {
      if(!shouldContinue()) return;
      try {
        await operation();
        return;
      } catch(err) {
        // A newer authoritative self row can restore media permission while an
        // older admin-mute cleanup is waiting on its RPC. Do not let the retry
        // wake up later and tear down camera/screen media started after that
        // unmute.
        if(!shouldContinue()) return;
        lastError = err;
        this.log.error(`${label} failed`, err);
        if(attempt + 1 < MEDIA_TEARDOWN_MAX_ATTEMPTS) {
          await pause(MEDIA_TEARDOWN_RETRY_BASE_MS * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async enforceAdminMediaTeardown(
    stopScreen: boolean,
    stopVideo: boolean,
    generation: number
  ): Promise<void> {
    const shouldContinue = () => {
      return generation === this.adminMediaTeardownGeneration &&
        this.adminMediaBlocked &&
        !this.isClosing;
    };
    const teardown: Promise<void>[] = [];
    if(stopScreen) {
      teardown.push(this.retryMediaTeardown(
        'stop screen sharing after admin mute',
        () => this.stopScreenSharing(),
        shouldContinue
      ));
    }
    if(stopVideo) {
      teardown.push(this.retryMediaTeardown(
        'stop video sharing after admin mute',
        () => this.stopVideoSharing(true, shouldContinue),
        shouldContinue
      ));
    }

    const results = await Promise.allSettled(teardown);
    if(shouldContinue() && results.some((result) => result.status === 'rejected')) {
      // Repeated metadata cleanup failures leave the server believing camera or
      // presentation media is active. Leaving the call is the only fail-closed
      // reconciliation that removes every source atomically.
      this.hangUpAfterFatalFailure();
    }
  }

  public async editParticipant(participant: GroupCallParticipant, options: Partial<{
    muted: boolean,
    volume: number,
    raiseHand: boolean,
    videoStopped: boolean,
    videoPaused: boolean,
    presentationPaused: boolean
  }>, optimistic = true) {
    if(!Object.keys(options).length) {
      return;
    }

    // let processUpdate = true;
    if(participant) {
      // const {currentGroupCall} = this;
      // const isCurrentCall = currentGroupCall?.id === groupCallId;
      const isCurrentCall = true;
      const isUpdatingMeInCurrentCall = isCurrentCall && participant.pFlags.self;

      if(isUpdatingMeInCurrentCall) {
        if(options.muted !== undefined && !this.isSharingAudio) {
          delete options.muted;

          if(!Object.keys(options).length) {
            return;
          }
        }
      }

      // if(isCurrentCall) {
      const muted = options.muted;
      if(muted !== undefined) {
        /* const isAdmin = appChatsManager.hasRights(currentGroupCall.chatId, 'manage_call');
          if(isAdmin) {
            if(muted) {
              participant.pFlags.muted = true;
              delete participant.pFlags.can_self_unmute;
            } else {
              participant.pFlags.can_self_unmute = true;
            }
          } else  */if(participant.pFlags.self) {
          if(muted) {
            participant.pFlags.muted = true;
          } else if(participant.pFlags.can_self_unmute) {
            delete participant.pFlags.muted;
          }
        }/*  else {
            if(muted) {
              participant.pFlags.muted_by_you = true;
            } else {
              delete participant.pFlags.muted_by_you;
            }
          } */
      }
      // }

      /* const a: [keyof GroupCallParticipant['pFlags'], keyof typeof options][] = [
        ['muted', 'muted']
      ];

      a.forEach(([key, optionKey]) => {
        const value = options[optionKey];
        if(value === undefined) {
          return;
        }

        if(value) {
          participant.pFlags[key] = true;
        } else {
          delete participant.pFlags[key];
        }
      }); */

      if(options.raiseHand !== undefined) {
        if(options.raiseHand) participant.raise_hand_rating = '1';
        else delete participant.raise_hand_rating;
      }

      if(isUpdatingMeInCurrentCall) {
        if(options.videoStopped !== undefined) {
          if(options.videoStopped) delete participant.video;
          else participant.video = makeSelfVideo();
        }

        this.dispatchEvent('state', this.state);
      }

      // rootScope.dispatchEvent('group_call_participant', {groupCallId, participant});

      /* if(participant.pFlags.self) {
        processUpdate = false;
      } */
    }

    const isSelf = !!participant?.pFlags.self;
    const managerParticipant = isSelf ? {
      ...participant,
      pFlags: {...participant.pFlags}
    } : participant;
    const invoke = () => {
      return this.managers.appGroupCallsManager.editParticipant(
        this.id,
        managerParticipant,
        options,
        optimistic
      );
    };

    if(!isSelf) return invoke();

    // Every self edit carries a complete participant row into the worker cache.
    // Serialize those snapshots so an unrelated optimistic video/hand update
    // cannot echo the in-flight mute's locally-mutated pFlags and masquerade as
    // a newer authoritative mute revision during rollback.
    return this.selfParticipantEditTail.enqueue(invoke);
  }

  // The self row (`can_self_unmute`) and the LiveKit publish permission are two views of the same admin
  // decision; media stays blocked while either of them says so.
  private get isAdminBlocked(): boolean {
    return this.rowAdminBlocked || this.permissionBlocked;
  }

  // An admin lifted our forced mute. The row still says `muted`, so we stay muted — the cue is what tells
  // the user the microphone button works again (tdesktop notifyAboutAllowedToSpeak, gated on having joined
  // exactly like `_hadJoinedState`). The microphone goes out again, silent, so unmuting is a flag flip.
  private onAdminMediaBlockLifted(): void {
    if(this.joined) {
      notifyAllowedToSpeak();
    }

    const connectionInstance = this.connections.main;
    const audioTrack = connectionInstance?.streamManager?.inputStream?.getAudioTracks?.()[0];
    if(connectionInstance && audioTrack) {
      void connectionInstance.syncMicrophone(true, audioTrack).catch((err) => {
        this.log.warn('republishing the microphone after the forced mute was lifted failed', err);
      });
    }
  }

  // Include acquisitions/negotiations that have not published a track or participant row yet. stop*
  // increments the matching generation immediately, so their late continuations release capture instead of
  // starting media after the admin mute.
  private scheduleAdminMediaTeardown(options: {participant?: GroupCallParticipant, changed: boolean}): void {
    const {participant, changed} = options;
    const stopScreen = !!this.startScreenSharingPromise ||
      this.isSharingScreen ||
      this.pendingPresentationLeaves.size > 0 ||
      !!participant?.presentation;
    const stopVideo = !!this.startVideoSharingPromise ||
      this.isSharingVideo ||
      !!participant?.video;
    if((stopScreen || stopVideo) && (!this.adminMediaTeardownPromise || changed)) {
      const generation = this.adminMediaTeardownGeneration;
      const previousTeardown = this.adminMediaTeardownPromise;
      const teardown = (async() => {
        if(previousTeardown) await previousTeardown.catch(() => {});
        if(generation !== this.adminMediaTeardownGeneration || !this.adminMediaBlocked) return;
        await this.enforceAdminMediaTeardown(stopScreen, stopVideo, generation);
      })();
      const trackedTeardown = teardown.finally(() => {
        if(this.adminMediaTeardownPromise === trackedTeardown) {
          this.adminMediaTeardownPromise = undefined;
        }
      });
      this.adminMediaTeardownPromise = trackedTeardown;
    }
  }

  /**
   * LiveKit changed what we may publish (the server applies a forced mute as a permission change). Revoked:
   * the same fail-closed path as an admin mute row — capture cut, camera and screen torn down. Granted
   * again: the cue, and the microphone back out silent.
   */
  public onPublishPermission(canPublish: boolean): void {
    if(this.isClosing) {
      return;
    }

    this.permissionBlocked = !canPublish;
    const blocked = this.isAdminBlocked;
    if(blocked === this.adminMediaBlocked) {
      return;
    }

    this.adminMediaBlocked = blocked;
    ++this.adminMediaTeardownGeneration;
    if(blocked) {
      this.pendingUnmuteIntentAt = undefined;
      this.setMuted(true);
      this.scheduleAdminMediaTeardown({participant: this.participant, changed: true});
    } else {
      this.onAdminMediaBlockLifted();
    }

    this.dispatchEvent('state', this.state);
  }

  public onParticipantUpdate(participant: GroupCallParticipant) {
    const connectionInstance = this.connections.main;

    const peerId = getPeerId(participant.peer);
    const hasLeft = !!participant.pFlags.left;
    if(hasLeft) {
      this.participantRows.delete(peerId);
    } else {
      this.participantRows.set(peerId, participant);
    }

    if(participant.presentation && !hasLeft) {
      const source = participant.presentation.endpoint;
      if(source && !this.hadAutoPinnedSources.has(source)) {
        this.hadAutoPinnedSources.add(source);
        this.pinSource(participant.pFlags.self ? 'presentation' : source);
      }
    }

    if(participant.pFlags.self) {
      ++this.selfParticipantRevision;
      this.participant = participant;

      if(hasLeft) {
        // The server removed us — an admin kicked us, or our slot was taken
        // over. This row used to be ignored, so the call only ended once ICE
        // timed out 15-30 s later, and an unmuted microphone kept feeding our
        // SFU slot meanwhile while the popup still showed "unmuted". tdesktop
        // applySelfUpdate rejoins when the row carries our ssrc and hangs up
        // otherwise; a rejoin is a separate feature, so fail closed either
        // way: cut capture synchronously, then leave. A row that arrives while
        // our own leave is already tearing the connection down changes nothing.
        if(this.isClosing) return;
        this.setMuted(true);
        this.dispatchEvent('state', this.state);
        this.hangUpAfterFatalFailure();
        return;
      }

      this.rowAdminBlocked = !participant.pFlags.can_self_unmute;
      // the stricter of the row and the LiveKit publish permission
      const adminMediaBlocked = this.isAdminBlocked;
      const adminMediaBlockChanged = this.adminMediaBlocked !== adminMediaBlocked;
      if(adminMediaBlockChanged) {
        this.adminMediaBlocked = adminMediaBlocked;
        ++this.adminMediaTeardownGeneration;
        if(!adminMediaBlocked) {
          this.onAdminMediaBlockLifted();
        }
      }

      if(connectionInstance.sources.audio.source !== participant.source) {
        this.hangUpAfterFatalFailure();
      }

      let mute = false;
      if(adminMediaBlocked) {
        this.scheduleAdminMediaTeardown({participant, changed: adminMediaBlockChanged});
        mute = true;
      } else if(participant.pFlags.muted) {
        mute = true;
      }

      if(adminMediaBlocked) {
        // Admin took the floor away — any armed unmute intent is void.
        this.pendingUnmuteIntentAt = undefined;
      }

      if(mute) {
        this.setMuted(true);
      } else if(
        this.pendingUnmuteIntentAt !== undefined &&
        participant.pFlags.can_self_unmute &&
        this.isMuted
      ) {
        // A server-accepted unmute lost the post-RPC check to a stale muted row
        // (see changeSelfMuted); this consistent self row confirms it. Open
        // capture only within the intent's TTL so a long-forgotten click can
        // never surprise-open the microphone.
        const fresh = performance.now() - this.pendingUnmuteIntentAt < UNMUTE_INTENT_TTL_MS;
        this.pendingUnmuteIntentAt = undefined;
        if(fresh) {
          this.setMuted(false);
        }
      }

      this.dispatchEvent('state', this.state);

      return;
    }

    // The tiles a participant can have are keyed by source: the camera by `source`, the screen by the
    // presentation's `endpoint`. A tile that disappeared from the row is unpinned.
    const outputSources: string[] = [];
    if(!hasLeft) {
      for(const type of ['video', 'presentation'] as const) {
        const source = getParticipantOutputSource(participant, type);
        if(source) outputSources.push(source);
      }
    }

    const oldSources: string[] = this.outputSourcesByPeer.get(peerId) || [];
    for(const oldSource of oldSources) {
      if(!outputSources.includes(oldSource)) {
        this.unpinSource(oldSource);
      }
    }

    if(outputSources.length) {
      this.outputSourcesByPeer.set(peerId, outputSources);
    } else {
      this.outputSourcesByPeer.delete(peerId);
    }

    this.mediaRouter.onParticipantUpdate(participant);
    if(!hasLeft) {
      this.applyParticipantAudioState(participant);
    }
  }

  // Per-participant volume and "muted by me" go to that participant's own audio elements: the microphone
  // under `source`, the screen audio under the presentation's `endpoint`.
  private applyParticipantAudioState(participant: GroupCallParticipant): void {
    const volume: number = (participant.volume ?? GROUP_CALL_PARTICIPANT_VOLUME_UNIT) / GROUP_CALL_PARTICIPANT_VOLUME_UNIT;
    const muted: boolean = !!participant.pFlags.muted_by_you;
    const sources: string[] = [String(participant.source)];
    if(participant.presentation?.endpoint) sources.push(participant.presentation.endpoint);
    for(const source of sources) {
      this.setOutputAudioState({source, volume, muted});
    }
  }

  // The router's sink: a routed track gets its element and the participant is re-announced so the tile and
  // the status row pick it up.
  private onTrackRouted(route: RoutedGroupCallTrack): void {
    this.tryAddTrack({
      stream: new MediaStream([route.track]),
      track: route.track,
      type: 'output',
      source: route.key
    });
    this.applyParticipantAudioState(route.participant);
    this.applyRemoteVideoQuality();
    rootScope.dispatchEvent('group_call_participant', {groupCallId: this.id, participant: route.participant});
    this.dispatchPinnedIfAffected(route);
  }

  private onTrackDropped(route: RoutedGroupCallTrack): void {
    this.removeOutputTrack(route.key, route.kind);
    rootScope.dispatchEvent('group_call_participant', {groupCallId: this.id, participant: route.participant});
    this.dispatchPinnedIfAffected(route);
  }

  private dispatchPinnedIfAffected(route: RoutedGroupCallTrack): void {
    if(route.kind === 'video' && this.pinnedSources.includes(route.key)) {
      this.dispatchPinnedThrottled();
    }
  }
}
