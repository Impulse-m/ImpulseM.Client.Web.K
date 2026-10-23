/*
 * Realtime push subscriber.
 *
 * gRPC-web is unary-only, so it cannot deliver server-initiated updates. This
 * module opens a Centrifugo WebSocket, listens on the per-user channel
 * `user:{id}`, decodes each envelope into a TL update and hands it to the
 * updates manager — the same entry point the MTProto updates loop used, so pts
 * gating, gap detection and getDifference all keep working unchanged.
 *
 * It runs in the worker, next to the updates manager, so there is no cross-thread
 * hop and no second pts cursor to keep in sync.
 *
 * Token policy: the short-lived JWT is minted by the backend
 * (Sync.GetCentrifugoToken). The browser must never mint one locally.
 *
 * Wire envelope: {type, pts, ptsCount, date, data}, where `data` is a binary
 * `v1.Update`.
 */

import Schema, {MTProtoConstructor} from '@lib/mtproto/schema';
import {Centrifuge, UnauthorizedError, type Subscription} from '@impulsem/centrifuge';
import {fromBinary} from '@bufbuild/protobuf';
import {Code, ConnectError, createClient} from '@connectrpc/connect';

import {backendWsOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';
import type {TabState} from '@lib/apiManagerProxy';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {TOKEN_EXPIRED_CODE} from './centrifugoCodes';
import {refreshImpulseSession, whenImpulseSessionReady} from './session';
import {RealtimeSubscriptions} from './realtimeSubscriptions';
import type {RealtimeSubscriptionDiff} from './realtimeSubscriptions';
import {getReconnectJitterMaxMs, ReconnectFloorMs} from './realtimeDiscipline';
import {protoToTL} from './grpc/adapter';
import {UpdatesSchema} from './grpc/gen/v1/types_pb';
import {SyncService} from './grpc/gen/v1/internal/impulse/sync/sync_service_pb';
import {getGrpcTransport, requireGrpcSessionToken} from './grpc/transport';

const logger = getLogger('impulse-realtime');

const CENTRIFUGO_WS = `${backendWsOrigin()}/connection/websocket`;
// Guards against a re-spin storm if module state is ever transiently reset.
const SPIN_UP_COOLDOWN_MS = 30_000;
// The exponential CAP on a reconnect delay, not a spread window -- the comment that used to
// stand here said "reconnects spread across 20 seconds" and nothing spread anything.
// Development keeps a much lower cap so a local reconnect stays responsive.
export const ReconnectJitterMaxMs = getReconnectJitterMaxMs(import.meta.env.DEV);
// The FLOOR, and it is the number that decides a herd. The SDK grows its random range from
// the floor, so the ladder starts wherever this does; at the 1 ms it used to hold, every
// socket the server hung up on came back inside 2 ms (#445).
export const ReconnectJitterMinMs = ReconnectFloorMs;

export type RealtimeUpdateSink = (updates: any, channelId?: ChatId) => void;

export type Envelope = {
  type?: number,
  pts?: number | string,
  ptsCount?: number | string,
  pts_count?: number | string,
  qts?: number | string,
  date?: number | string,
  data?: unknown,
  oversize?: boolean
};

/*
 * One live realtime connection per account slot.
 *
 * The connection LIFECYCLE was the last piece of per-account state left as a SharedWorker-wide
 * singleton after #436 moved credentials, the session gate and the gRPC transport to per-account
 * maps (grpc/transport.ts credentialsByAccount, session.ts gatesByAccount). A single SharedWorker
 * hosts all four account slots side by side (createManagers builds one manager set per slot), and
 * the Centrifugo token is already minted per account (fetchCentrifugoToken(accountNumber) below) --
 * so keeping ONE `connection`/`activeUserId` cell meant bringing up account B tore down account A's
 * socket, leaving only one account with a live `user:{id}` subscription while the other went silent.
 *
 * Each slot now owns its own record here, and every function reads only the slot it was handed --
 * so there is deliberately no module-level "current account" (mirrors the module comment at
 * grpc/transport.ts:17-19). `connectionFor(accountNumber)` is the exact analogue of
 * transport.ts's `credentialsFor(accountNumber)`.
 */
type RealtimeConnection = {
  activeUserId: string | undefined,
  connection: Centrifuge | undefined,
  subscriptionSet: RealtimeSubscriptions | undefined,
  openChannelId: ChatId | undefined,
  // The group call this slot is joined to, if any: its `call:{id}` lane carries the in-call messages,
  // and for a channel call its `channel:{id}` lane is pinned in the subscription set.
  call: RealtimeCall | undefined,
  latestTabStates: TabState[],
  subscriptions: Map<string, Subscription>,
  sink: RealtimeUpdateSink | undefined,
  spinUpInProgress: boolean,
  lastSpinUpAt: number | undefined
};

export type RealtimeCall = {
  callId: string,
  channelId: ChatId | undefined
};

const connectionsByAccount = new Map<ActiveAccountNumber, RealtimeConnection>();

function connectionFor(accountNumber: ActiveAccountNumber): RealtimeConnection {
  let record = connectionsByAccount.get(accountNumber);
  if(!record) {
    record = {
      activeUserId: undefined,
      connection: undefined,
      subscriptionSet: undefined,
      openChannelId: undefined,
      call: undefined,
      latestTabStates: [],
      subscriptions: new Map<string, Subscription>(),
      sink: undefined,
      spinUpInProgress: false,
      lastSpinUpAt: undefined
    };
    connectionsByAccount.set(accountNumber, record);
  }

  return record;
}

export function setRealtimeSink(accountNumber: ActiveAccountNumber, fn: RealtimeUpdateSink): void {
  connectionFor(accountNumber).sink = fn;
}

export function startImpulseRealtime(userId: string | undefined, accountNumber: ActiveAccountNumber | undefined): void {
  // Every downstream call (the token mint, the transport it travels on) is
  // account-scoped now -- see grpc/transport.ts. There is no account-less
  // identity to fall back to, so refuse rather than spin up a connection nobody
  // can authenticate.
  if(accountNumber === undefined) {
    logger.warn('Realtime spin-up requested with no account number', {userId});
    return;
  }

  if(!userId) {
    stopImpulseRealtime(accountNumber);
    return;
  }

  const record = connectionFor(accountNumber);

  // Already live (or spinning up) for THIS slot's user -- nothing to do. Scoped to the slot:
  // another account being live must never short-circuit this one (#436).
  if(record.activeUserId === userId && (record.connection || record.spinUpInProgress)) {
    return;
  }

  // Per-slot cooldown against a re-spin storm, keyed by this slot's own last attempt rather than
  // a shared userId map -- two accounts spinning up close together are two independent attempts.
  if(record.lastSpinUpAt !== undefined && Date.now() - record.lastSpinUpAt < SPIN_UP_COOLDOWN_MS && record.connection) {
    return;
  }

  // A DIFFERENT user on the SAME slot (a sign-out/sign-in within this slot) tears down this slot's
  // own socket before opening the new one. This only ever touches its own slot -- deleting the old
  // singleton `activeUserId !== userId -> stopImpulseRealtime()` branch is the whole fix for the
  // cross-account teardown: bringing up account B must leave account A's socket alone (#436).
  if(record.activeUserId && record.activeUserId !== userId) {
    stopImpulseRealtime(accountNumber);
  }

  record.lastSpinUpAt = Date.now();
  record.activeUserId = userId;
  record.subscriptionSet = new RealtimeSubscriptions(userId);
  record.subscriptionSet.pin(record.call?.channelId);
  record.spinUpInProgress = true;

  spinUp(accountNumber, userId).catch((err: unknown) => {
    logger.warn('Realtime spin-up failed', {userId}, err);
  }).finally(() => {
    connectionFor(accountNumber).spinUpInProgress = false;
  });
}

export function stopImpulseRealtime(accountNumber: ActiveAccountNumber): void {
  const record = connectionsByAccount.get(accountNumber);
  if(!record) {
    return;
  }

  try {
    for(const subscription of record.subscriptions.values()) {
      subscription.unsubscribe();
    }
    record.connection?.disconnect();
  } catch(err) {
    logger.warn('Realtime teardown failed', {accountNumber}, err);
  }

  record.subscriptions.clear();
  record.subscriptionSet = undefined;
  record.openChannelId = undefined;
  record.connection = undefined;
  record.activeUserId = undefined;
  // call, sink and latestTabStates deliberately survive teardown: apiManager re-arms the sink on the
  // next bring-up (startRealtimeBringUp), and a reconnect for the same slot should keep the tab
  // lanes it already knew -- exactly as the singleton did before it went per-account.
}

/**
 * Reads the realtime lanes of the group call this slot joined (undefined: it left, or the call closed):
 * `call:{id}`, which the subscribe proxy opens to the call's participants only and re-asks while
 * subscribed, carries updateGroupCallMessage / updateDeleteGroupCallMessages; and, for a channel call,
 * its `channel:{id}` lane is kept subscribed whatever the dialog window holds. The state outlives a
 * socket teardown, so a reconnect brings the lanes back.
 */
export function setImpulseRealtimeCall(accountNumber: ActiveAccountNumber, call: RealtimeCall | undefined): void {
  const record = connectionFor(accountNumber);
  const previous = record.call;
  record.call = call;

  if(previous && previous.callId !== call?.callId) {
    applySubscriptionDiff(accountNumber, {subscribe: [], unsubscribe: [callLaneName(previous.callId)]});
  }
  if(call && record.connection) {
    createSubscription(accountNumber, callLaneName(call.callId));
  }
  if(record.subscriptionSet) {
    applySubscriptionDiff(accountNumber, record.subscriptionSet.pin(call?.channelId));
  }
}

function callLaneName(callId: string): string {
  return `call:${callId}`;
}

export function setImpulseRealtimeTabs(states: TabState[]): void {
  // The tab feed carries EVERY tab across EVERY account (index.worker.ts onTabStateChange), and
  // each tab names its own account. File each tab under its own account's connection and refresh
  // only the slots that actually hold a live socket -- no single "active" account decides which
  // tab is heard any more (#436; this replaces the old filter-to-activeAccountNumber at :148).
  for(const [accountNumber, record] of connectionsByAccount) {
    record.latestTabStates = states.filter((state) => state.accountNumber === accountNumber);
    applyTabStates(accountNumber);
  }
}

function applyTabStates(accountNumber: ActiveAccountNumber): void {
  const record = connectionFor(accountNumber);
  if(!record.subscriptionSet) return;

  // record.latestTabStates already holds only this slot's tabs (setImpulseRealtimeTabs filed them).
  let nextOpenChannelId: ChatId | undefined;
  const visibleChannelIds: ChatId[] = [];
  for(const state of record.latestTabStates) {
    visibleChannelIds.push(...state.visibleChannelIds);
    if(state.openChannelId !== undefined) {
      visibleChannelIds.push(state.openChannelId);
      nextOpenChannelId = state.openChannelId;
    }
  }

  if(record.openChannelId !== undefined && record.openChannelId !== nextOpenChannelId) {
    applySubscriptionDiff(accountNumber, record.subscriptionSet.close(record.openChannelId));
  }
  if(nextOpenChannelId !== undefined) {
    applySubscriptionDiff(accountNumber, record.subscriptionSet.open(nextOpenChannelId));
  }
  record.openChannelId = nextOpenChannelId;
  applySubscriptionDiff(accountNumber, record.subscriptionSet.showDialogs(visibleChannelIds));
}

export async function fetchCentrifugoToken(accountNumber: ActiveAccountNumber): Promise<string> {
  await whenImpulseSessionReady(accountNumber);
  requireGrpcSessionToken(accountNumber);

  const client = createClient(SyncService, getGrpcTransport(accountNumber));

  // This call goes straight through the generated client, so it never passes the
  // 401-retry in grpcInvoke -- on a restored-but-expired session it just failed
  // with AUTH_KEY_UNREGISTERED and the push channel stayed down for the whole
  // tab. Renew and try once more, the same way every other call does.
  const response = await client.getCentrifugoToken({}).catch(async(err: unknown) => {
    if(!isUnauthenticated(err) || !await refreshImpulseSession(accountNumber)) {
      throw err;
    }

    logger.info('Retrying the Centrifugo token after a session refresh');
    return client.getCentrifugoToken({});
  });

  if(!response?.token) {
    throw new Error('Sync.GetCentrifugoToken returned no token');
  }

  return response.token;
}

/**
 * The token callback of the SDK. A 401 or 403 from the token RPC means this session may not hold a
 * realtime connection; the SDK retries every other failure forever and stops only on its
 * UnauthorizedError.
 */
async function fetchCentrifugoTokenForSdk(accountNumber: ActiveAccountNumber): Promise<string> {
  try {
    return await fetchCentrifugoToken(accountNumber);
  } catch(err: unknown) {
    const code: Code = ConnectError.from(err).code;
    if(code === Code.Unauthenticated || code === Code.PermissionDenied) {
      logger.warn('Centrifugo token refused; the connection stops', {code});
      throw new UnauthorizedError(ConnectError.from(err).rawMessage);
    }

    throw err;
  }
}

function isUnauthenticated(err: unknown): boolean {
  return ConnectError.from(err).code === Code.Unauthenticated;
}

async function spinUp(accountNumber: ActiveAccountNumber, userId: string): Promise<void> {
  const token = await fetchCentrifugoToken(accountNumber);

  const record = connectionFor(accountNumber);
  // This slot's user may have changed while the token was in flight.
  if(record.activeUserId !== userId) {
    return;
  }

  const centrifuge = new Centrifuge(CENTRIFUGO_WS, {
    token,
    getToken: () => fetchCentrifugoTokenForSdk(accountNumber),
    // SDK 1.0.0 had no refused-token memory: a retry sent the token getToken returned, and 1.6.0 blocks it by default.
    stopOnRefusedToken: false,
    // Centrifuge 5's ladder is min(max, min + randInt(0, min(max, min * 2^attempt))) --
    // reproduced and asserted in realtimeDiscipline.sdkReconnectDelay. It is NOT full jitter:
    // the random range grows from the floor rather than covering the window, and
    // _connectResponse resets the attempt counter, so a socket that was healthy when the
    // server hung up on it always re-enters at attempt 0.
    minReconnectDelay: ReconnectJitterMinMs,
    maxReconnectDelay: ReconnectJitterMaxMs
  });

  centrifuge.on('error', (ctx: any) => {
    if(ctx?.error?.code === TOKEN_EXPIRED_CODE) {
      logger.info('Centrifugo token expired; refreshing');
      return;
    }

    logger.warn('Centrifugo error', {code: ctx?.error?.code});
  });

  const channel = `user:${userId}`;

  // The connection's own lifecycle, logged from the events rather than from the call sites.
  //
  // What used to stand at the end of this function was `logger.info('Realtime connected')`,
  // written immediately after calling connect() and subscribe(). Both are asynchronous and return
  // nothing, so that line recorded an INTENTION as an OUTCOME: it appeared whether or not a socket
  // was ever established. Reading the logs back, five "connected" lines in seventeen minutes looked
  // like a connection that kept dropping and recovering, while the subscribe-proxy on the server
  // had been called twice in forty minutes. The log agreed with itself and described something that
  // had not happened.
  //
  // Nothing recorded the other edge at all -- no disconnect, no unsubscribe, no reason code -- so
  // the one question worth asking ("what is killing it?") had no evidence anywhere. These handlers
  // exist to answer exactly that: every transition, with the code and reason Centrifugo supplies.
  centrifuge.on('connecting', (ctx: any) => {
    logger.info('Realtime connecting', {channel, code: ctx?.code, reason: ctx?.reason});
  });
  centrifuge.on('connected', (ctx: any) => {
    logger.info('Realtime connected', {channel, transport: ctx?.transport});
  });
  centrifuge.on('disconnected', (ctx: any) => {
    logger.warn('Realtime disconnected', {channel, code: ctx?.code, reason: ctx?.reason});
  });

  // The connection token subscribes the connection, server-side, to its own `session:{user}:{session}`
  // lane: what is addressed to ONE session alone arrives there (a 1:1 call's phoneCallAccepted for the
  // caller, the active phoneCall with its LiveKit coordinates for the callee). A Subscription object only
  // sees the lanes this client asked for; publications of server-side subscriptions are delivered on the
  // client itself, and with no handler here they were read off the socket and dropped, so a call never
  // got past ringing.
  centrifuge.on('publication', (ctx: any) => {
    handleEnvelope(accountNumber, ctx?.data as Envelope, ctx?.channel ?? '');
  });

  record.connection = centrifuge;
  applyTabStates(accountNumber);
  for(const selectedChannel of record.subscriptionSet?.getChannels() ?? [channel]) {
    createSubscription(accountNumber, selectedChannel);
  }

  if(record.call) {
    createSubscription(accountNumber, callLaneName(record.call.callId));
  }

  centrifuge.connect();
  logger.info('Realtime spin-up requested', {channel});
}

function createSubscription(accountNumber: ActiveAccountNumber, channel: string): void {
  const record = connectionFor(accountNumber);
  if(!record.connection || record.subscriptions.has(channel)) {
    return;
  }

  openSubscription(accountNumber, channel);
}

function openSubscription(accountNumber: ActiveAccountNumber, channel: string): void {
  const record = connectionFor(accountNumber);
  if(!record.connection || record.subscriptions.has(channel)) return;

  const sub = record.connection.newSubscription(channel);
  sub.on('publication', (ctx: any) => {
    handleEnvelope(accountNumber, ctx?.data as Envelope, channel);
  });
  sub.on('error', (ctx: any) => {
    logger.warn('Centrifugo subscription error', {channel, code: ctx?.error?.code});
  });

  // Subscription state is tracked separately from connection state on purpose: a live socket
  // carrying no subscription delivers nothing, and that is indistinguishable from a dead socket
  // unless both are recorded. `recovered` is the field that says whether the messages missed while
  // the subscription was down were replayed, or silently skipped.
  sub.on('subscribing', (ctx: any) => {
    logger.info('Realtime subscribing', {channel, code: ctx?.code, reason: ctx?.reason});
  });
  sub.on('subscribed', (ctx: any) => {
    logger.info('Realtime subscribed', {
      channel,
      recoverable: ctx?.recoverable,
      wasRecovering: ctx?.wasRecovering,
      recovered: ctx?.recovered
    });
  });
  sub.on('unsubscribed', (ctx: any) => {
    logger.warn('Realtime unsubscribed', {channel, code: ctx?.code, reason: ctx?.reason});
  });

  record.subscriptions.set(channel, sub);
  sub.subscribe();
  logger.info('Realtime subscription requested', {channel});
}

function applySubscriptionDiff(accountNumber: ActiveAccountNumber, diff: RealtimeSubscriptionDiff): void {
  const record = connectionFor(accountNumber);
  for(const channel of diff.unsubscribe) {
    const subscription = record.subscriptions.get(channel);
    if(!subscription) continue;

    subscription.unsubscribe();
    record.connection?.removeSubscription(subscription);
    record.subscriptions.delete(channel);
    logger.info('Realtime channel unsubscribe requested', {channel});
  }

  for(const channel of diff.subscribe) {
    createSubscription(accountNumber, channel);
    logger.info('Realtime channel subscribe requested', {channel});
  }
}

function handleEnvelope(accountNumber: ActiveAccountNumber, envelope: Envelope | undefined, channel: string): void {
  const sink = connectionFor(accountNumber).sink;
  if(!envelope || !sink) {
    return;
  }

  // Too large to ride the push channel. Returning here used to be the whole of it, on the
  // reasoning that the updates manager would pick the update up through getDifference. It cannot:
  // the envelope never reaches the manager, so nothing creates the sequence gap that would make it
  // ask. Nothing else is guaranteed to arrive either, so the chat simply stays as it was --
  // missing that message, or that edit, or that read mark -- until some later event happens to
  // expose a gap by coincidence.
  //
  // Canon has a constructor for exactly this situation and says what it obliges: updatesTooLong
  // means "too many updates to deliver here, fetch the difference"
  // (.demo/telegram-docs-text/constructor/updatesTooLong.md). The manager already answers it by
  // forcing that fetch, beside new_session_created, and has done since long before this transport
  // existed. So the honest move is to say the thing canon defines and let the path that was
  // written for it do the work, rather than reach past it and call getDifference from here --
  // a second recovery route beside a working one is how this file's other defect happened.
  if(envelope.oversize) {
    logger.info('Oversize realtime update; asking for the difference', {type: envelope.type});
    sink({_: 'updatesTooLong'});
    return;
  }

  let updates: any;
  try {
    updates = decodeRealtimeEnvelope(envelope);
  } catch(err) {
    // A decode failure must never escape into the worker's error handler.
    logger.warn('Realtime update decode failed', {type: envelope.type, channel}, err);
    return;
  }

  if(!updates || typeof updates !== 'object') {
    logger.warn('Non-binary realtime update ignored', {type: envelope.type, channel});
    return;
  }

  // TL carries pts on each update; the envelope repeats it out of band, so
  // restore it when the decoded update did not already have it.
  for(const update of updates.updates ?? []) {
    applyMetadata(update, envelope);
  }

  const date = asNumber(envelope.date);
  if(date !== undefined) {
    updates.date = date;
  }

  // Only failures were recorded here, so a channel that delivered nothing looked
  // exactly like one that delivered everything -- and a response to sendMessage,
  // which the updates manager also processes, was mistaken for a push. Record
  // every publication that gets this far.
  logger.info('Realtime update received', {
    updates: (updates.updates ?? []).map((update: any) => update._),
    pts: asNumber(envelope.pts),
    ptsCount: asNumber(envelope.ptsCount ?? envelope.pts_count),
    channel
  });

  try {
    const channelId = channel.startsWith('channel:') ? asNumber(channel.slice('channel:'.length)) : undefined;
    sink(updates, channelId);
  } catch(err) {
    logger.warn('Realtime update dispatch failed', {type: envelope.type}, err);
  }
}

export function decodeRealtimeEnvelope(envelope: Envelope): any | undefined {
  const bytes = readBytes(envelope.data);
  if(!bytes) {
    return undefined;
  }

  return protoToTL(fromBinary(UpdatesSchema, bytes), UpdatesSchema);
}

/**
 * The field names each update constructor actually declares, from the TL schema, memoised.
 *
 * The schema is the only authority here that cannot rot: a hand-written list of pts-bearing
 * constructors would drift the moment the layer moves, and the drift would be silent.
 */
const declaredFieldsByPredicate = new Map<string, Set<string>>();

function declaresField(predicate: string | undefined, field: string): boolean {
  if(!predicate) {
    return false;
  }

  let declared = declaredFieldsByPredicate.get(predicate);
  if(!declared) {
    const constructor = (Schema.API.constructors as MTProtoConstructor[])
      .find((entry) => entry.predicate === predicate);
    declared = new Set((constructor?.params ?? []).map((param) => param.name));
    declaredFieldsByPredicate.set(predicate, declared);
  }

  return declared.has(field);
}


/**
 * Restores the sequence fields the envelope repeats out of band — ONLY onto updates whose own
 * constructor declares them.
 *
 * The guard is the whole point and its absence was issue #319. This used to stamp the envelope's
 * pts/pts_count onto every update in the container, and `updateMessageID#4e90bfd6 id:int
 * random_id:long = Update` declares neither (constructor/updateMessageID.md). The account's own
 * outgoing message travels in a container that carries BOTH updateMessageID and updateNewMessage
 * with one shared pts, so on every other device of that account the fabricated pair on the
 * updateMessageID advanced local pts first, and apiUpdatesManager then read the real
 * updateNewMessage as `pts <= curState.pts` and logged "duplicate update" — dropping it.
 *
 * Measured in e2e/live/twoDevicesOneAccount.live.spec.ts: the watcher's pipeline showed
 * `process 2 {_: updateMessageID, ..., pts: 3, pts_count: 1}` immediately followed by
 * `process 3 {_: updateNewMessage, ..., pts: 3}` and `duplicate update`. One account, two devices,
 * and the second one silently threw away every message the first one sent.
 */
function applyMetadata(update: any, envelope: Envelope): void {
  const predicate: string | undefined = update?._;

  const pts = asNumber(envelope.pts);
  if(pts !== undefined && update.pts === undefined && declaresField(predicate, 'pts')) {
    update.pts = pts;
  }

  const ptsCount = asNumber(envelope.ptsCount ?? envelope.pts_count);
  if(ptsCount !== undefined && update.pts_count === undefined && declaresField(predicate, 'pts_count')) {
    update.pts_count = ptsCount;
  }

  const qts = asNumber(envelope.qts);
  if(qts !== undefined && update.qts === undefined && declaresField(predicate, 'qts')) {
    update.qts = qts;
  }
}

function asNumber(value: number | string | undefined): number | undefined {
  if(typeof value === 'number') {
    return value;
  }

  if(typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBytes(value: unknown): Uint8Array | undefined {
  if(value instanceof Uint8Array) {
    return value;
  }

  if(value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  // Centrifugo delivers binary payloads as base64 when the transport is JSON.
  if(typeof value === 'string') {
    try {
      const binary = atob(value);
      const out = new Uint8Array(binary.length);
      for(let i = 0; i < binary.length; ++i) {
        out[i] = binary.charCodeAt(i);
      }

      return out;
    } catch{
      return undefined;
    }
  }

  return undefined;
}
