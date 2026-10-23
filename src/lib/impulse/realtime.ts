/*
 * The update socket of each account slot.
 *
 * One Centrifugo client per slot, speaking protobuf. It carries the server-initiated updates on the per-user channel
 * `user:{id}`, the session lane, and the channels of the dialogs on screen; and it carries every regular TL call of the
 * slot as an rpc (callUpdateSocket). The socket connects with the identity of its slot, which the session registers
 * (fleetIdentityOf): anonymous while signed out, the pending 2FA token while a challenge is pending, the access JWT while
 * signed in. The slot's identity moves only through startImpulseRealtime and the session transitions (rekeyUpdateSocket);
 * a call never replaces the socket. The replaced socket closes once the calls it carries have settled.
 *
 * Decoded updates go to the updates manager through the same entry point the MTProto updates loop used, so pts gating,
 * gap detection and getDifference keep working unchanged. It runs in the worker, next to the updates manager.
 *
 * Wire envelope: {type, pts, ptsCount, date, data}, where `data` is a binary `v1.Update`. The protobuf codec delivers
 * the envelope as the UTF-8 JSON the server published.
 */

import Schema, {MTProtoConstructor} from '@lib/mtproto/schema';
import {Centrifuge, type RpcOptions, type RpcResult, type Subscription} from '@impulsem/centrifuge/build/protobuf';
import {fromBinary} from '@bufbuild/protobuf';

import {backendHttpOrigin, backendWsOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';
import makeError from '@helpers/makeError';
import type {TabState} from '@lib/apiManagerProxy';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {isTokenRefusalCode, TOKEN_EXPIRED_CODE} from './centrifugoCodes';
import {countSocketCall, fleetFailure, fleetIdentityOf} from './fleet/fleet';
import type {FleetIdentity} from './fleet/fleet';
import {CENTRIFUGO_CONNECTION_PATH} from './fleet/fleetPath';
import {isFleetRpcError, replyDataOf} from './fleet/fleetError';
import {reportDifferenceFailure} from './backgroundFailures';
import {RealtimeSubscriptions} from './realtimeSubscriptions';
import type {RealtimeSubscriptionDiff} from './realtimeSubscriptions';
import {getReconnectJitterMaxMs, ReconnectFloorMs} from './realtimeDiscipline';
import {protoToTL} from './grpc/protoToTL';
import {getGrpcQrExporterTicket, QR_EXPORTER_TICKET_HEADER} from './grpc/credentials';
import {UpdatesSchema} from './grpc/gen/v1/types_pb';

const logger = getLogger('impulse-realtime');

const CENTRIFUGO_WS = `${backendWsOrigin(backendHttpOrigin())}${CENTRIFUGO_CONNECTION_PATH}`;
// Every regular call is an rpc on this client, and an rpc deadline may not exceed the client timeout.
const UPDATE_SOCKET_TIMEOUT_MS: number = 30_000;
const NO_CONNECTION_TOKEN: string = '';
// The exponential CAP on a reconnect delay, not a spread window.
// Development keeps a much lower cap so a local reconnect stays responsive.
export const ReconnectJitterMaxMs = getReconnectJitterMaxMs(import.meta.env.DEV);
// The floor of the first reconnect: the SDK grows its random range from here.
export const ReconnectJitterMinMs = ReconnectFloorMs;

type RealtimeUpdateSink = (updates: any, channelId?: ChatId) => void;
type RealtimeRecovery = (channelId: ChatId | undefined) => Promise<void>;

type RealtimeDispatch = {
  sink: RealtimeUpdateSink,
  recovery: RealtimeRecovery
};

type Envelope = {
  type?: number,
  pts?: number | string,
  ptsCount?: number | string,
  pts_count?: number | string,
  qts?: number | string,
  date?: number | string,
  data?: unknown,
  oversize?: boolean
};

type RealtimeCall = {
  callId: string,
  channelId: ChatId | undefined
};

type UpdateSocketCall = {
  accountNumber: ActiveAccountNumber,
  method: string,
  request: Uint8Array,
  signal?: AbortSignal
};

type UpdateSocket = {
  client: Centrifuge,
  identity: FleetIdentity,
  // Calls in flight on the socket: a retired socket closes once they have settled.
  inflight: number,
  retired: boolean,
  closed: boolean
};

/*
 * One update socket per account slot: a slot's socket is torn down by its own identity change only, so bringing up one
 * account never stops another account's push channel.
 */
type RealtimeConnection = {
  activeUserId: string | undefined,
  socket: UpdateSocket | undefined,
  subscriptionSet: RealtimeSubscriptions | undefined,
  openChannelId: ChatId | undefined,
  // The group call this slot is joined to, if any: its `call:{id}` lane carries the in-call messages,
  // and for a channel call its `channel:{id}` lane is pinned in the subscription set.
  call: RealtimeCall | undefined,
  latestTabStates: TabState[],
  subscriptions: Map<string, Subscription>,
  dispatch: RealtimeDispatch | undefined
};

const connectionsByAccount = new Map<ActiveAccountNumber, RealtimeConnection>();

function connectionFor(accountNumber: ActiveAccountNumber): RealtimeConnection {
  let record = connectionsByAccount.get(accountNumber);
  if(!record) {
    record = {
      activeUserId: undefined,
      socket: undefined,
      subscriptionSet: undefined,
      openChannelId: undefined,
      call: undefined,
      latestTabStates: [],
      subscriptions: new Map<string, Subscription>(),
      dispatch: undefined
    };
    connectionsByAccount.set(accountNumber, record);
  }

  return record;
}

/** Registers how a slot's publications are dispatched, and how its lanes ask for the difference when a dispatch fails. */
export function setRealtimeDispatch(accountNumber: ActiveAccountNumber, dispatch: RealtimeDispatch): void {
  connectionFor(accountNumber).dispatch = dispatch;
}

/**
 * Brings the slot's update socket up for a signed-in user under the identity the slot holds, and subscribes its lanes.
 * Without a user the slot's socket is stopped.
 */
export function startImpulseRealtime(userId: string | undefined, accountNumber: ActiveAccountNumber): void {
  if(!userId) {
    stopImpulseRealtime(accountNumber);
    return;
  }

  const record = connectionFor(accountNumber);
  const identity = fleetIdentityOf(accountNumber);
  if(record.activeUserId === userId && record.socket?.identity.key === identity.key) {
    return;
  }

  if(record.activeUserId !== userId) {
    unsubscribeAll(record);
  }

  record.activeUserId = userId;
  record.subscriptionSet = new RealtimeSubscriptions(userId);
  record.subscriptionSet.pin(record.call?.channelId);
  if(record.socket && record.socket.identity.key !== identity.key) {
    retireSocket(record, record.socket);
  }

  socketOf(accountNumber);
  applySubscriptions(accountNumber);
}

export function stopImpulseRealtime(accountNumber: ActiveAccountNumber): void {
  const record = connectionsByAccount.get(accountNumber);
  if(!record) {
    return;
  }

  try {
    if(record.socket) {
      retireSocket(record, record.socket);
    }
  } finally {
    record.subscriptionSet = undefined;
    record.activeUserId = undefined;
  }
  // call, dispatch and latestTabStates deliberately survive teardown: apiManager re-arms the dispatch
  // on the next bring-up, and a reconnect for the same slot keeps the tab lanes it already knew.
}

/**
 * Moves the slot's socket to the identity its credentials hold now. A socket that already presents that identity stays.
 * A signed-in slot reconnects at once, with its subscriptions; any other slot connects with its next call.
 */
export function rekeyUpdateSocket(accountNumber: ActiveAccountNumber): void {
  const record = connectionFor(accountNumber);
  const current = record.socket;
  if(!current || current.identity.key === fleetIdentityOf(accountNumber).key) {
    return;
  }

  retireSocket(record, current);
  if(record.activeUserId !== undefined) {
    socketOf(accountNumber);
  }
}

/**
 * Sends one regular TL call as an rpc on the slot's update socket. The socket is the slot's own: it is opened here only
 * when the slot has none, under the identity the slot holds. Rejects with an ApiError.
 */
export async function callUpdateSocket(call: UpdateSocketCall): Promise<Uint8Array> {
  const socket = socketOf(call.accountNumber);
  socket.inflight++;

  let reply: RpcResult;
  try {
    reply = await socket.client.rpc(call.method, call.request, rpcOptionsOf(call));
  } catch(err: unknown) {
    if(isFleetRpcError(err) && isTokenRefusalCode(err.code)) {
      socket.identity.onRefused?.();
    }

    throw fleetFailure(call.method, err);
  } finally {
    socket.inflight--;
    closeIfIdle(socket);
  }

  countSocketCall(call.accountNumber);
  return replyDataOf(reply);
}

function rpcOptionsOf(call: UpdateSocketCall): RpcOptions {
  const options: RpcOptions = {signal: call.signal};
  const qrExporterTicket = getGrpcQrExporterTicket(call.accountNumber);
  if(qrExporterTicket !== undefined) {
    options.headers = {[QR_EXPORTER_TICKET_HEADER]: qrExporterTicket};
  }

  return options;
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
  if(call && record.socket) {
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
  // tab is heard any more.
  for(const [accountNumber, record] of connectionsByAccount) {
    record.latestTabStates = states.filter((state) => state.accountNumber === accountNumber);
    applyTabStates(accountNumber);
  }
}

function applyTabStates(accountNumber: ActiveAccountNumber): void {
  const record = connectionFor(accountNumber);
  if(!record.subscriptionSet) {
    return;
  }

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

/** The socket of the slot: the one it has, else a new one under the identity the slot holds. */
function socketOf(accountNumber: ActiveAccountNumber): UpdateSocket {
  const record = connectionFor(accountNumber);
  if(record.socket) {
    return record.socket;
  }

  const socket = openSocket(accountNumber, fleetIdentityOf(accountNumber));
  record.socket = socket;
  applySubscriptions(accountNumber);
  return socket;
}

function openSocket(accountNumber: ActiveAccountNumber, identity: FleetIdentity): UpdateSocket {
  const centrifuge = new Centrifuge(CENTRIFUGO_WS, {
    token: NO_CONNECTION_TOKEN,
    getToken: identity.getToken ?? null,
    // The SDK 1.6.0 blocks a token the server refused unless this is false: the renewal must be able to send the token it returns.
    stopOnRefusedToken: false,
    timeout: UPDATE_SOCKET_TIMEOUT_MS,
    minReconnectDelay: ReconnectJitterMinMs,
    maxReconnectDelay: ReconnectJitterMaxMs
  });

  centrifuge.on('error', (ctx: any) => {
    const code: number | undefined = ctx?.error?.code;
    if(isTokenRefusalCode(code)) {
      identity.onRefused?.();
    }

    if(code === TOKEN_EXPIRED_CODE) {
      logger.info('Centrifugo token expired; refreshing');
      return;
    }

    logger.warn('Centrifugo error', {code});
  });

  // The lifecycle of the socket, logged from the events the SDK emits.
  centrifuge.on('connecting', (ctx: any) => {
    logger.info('Realtime connecting', {identity: identity.kind, code: ctx?.code, reason: ctx?.reason});
  });
  centrifuge.on('connected', (ctx: any) => {
    logger.info('Realtime connected', {identity: identity.kind, transport: ctx?.transport});
  });
  centrifuge.on('disconnected', (ctx: any) => {
    logger.warn('Realtime disconnected', {identity: identity.kind, code: ctx?.code, reason: ctx?.reason});
  });

  // The connection token subscribes the connection, server-side, to its own `session:{user}:{session}` lane: what is
  // addressed to ONE session alone arrives there (a 1:1 call's phoneCallAccepted for the caller, the active phoneCall with
  // its LiveKit coordinates for the callee). Those publications are delivered on the client itself.
  centrifuge.on('publication', (ctx: any) => {
    handleEnvelope(accountNumber, ctx?.data, ctx?.channel ?? '');
  });

  const socket: UpdateSocket = {
    client: centrifuge,
    identity,
    inflight: 0,
    retired: false,
    closed: false
  };
  centrifuge.connect();
  logger.info('Realtime socket requested', {identity: identity.kind});
  return socket;
}

/** Ends a socket: its subscriptions are dropped now, and the socket closes once the calls it carries have settled. */
function retireSocket(record: RealtimeConnection, socket: UpdateSocket): void {
  if(record.socket === socket) {
    record.socket = undefined;
  }

  socket.retired = true;
  unsubscribeAll(record);
  closeIfIdle(socket);
}

function closeIfIdle(socket: UpdateSocket): void {
  if(socket.retired && socket.inflight === 0 && !socket.closed) {
    socket.closed = true;
    socket.client.disconnect();
  }
}

function unsubscribeAll(record: RealtimeConnection): void {
  for(const subscription of record.subscriptions.values()) {
    subscription.unsubscribe();
  }

  record.subscriptions.clear();
  record.openChannelId = undefined;
}

function applySubscriptions(accountNumber: ActiveAccountNumber): void {
  const record = connectionFor(accountNumber);
  if(!record.subscriptionSet) {
    return;
  }

  for(const channel of record.subscriptionSet.getChannels()) {
    createSubscription(accountNumber, channel);
  }
  if(record.call) {
    createSubscription(accountNumber, callLaneName(record.call.callId));
  }

  applyTabStates(accountNumber);
}

function createSubscription(accountNumber: ActiveAccountNumber, channel: string): void {
  const record = connectionFor(accountNumber);
  if(!record.socket || record.subscriptions.has(channel)) {
    return;
  }

  openSubscription(accountNumber, channel);
}

function openSubscription(accountNumber: ActiveAccountNumber, channel: string): void {
  const record = connectionFor(accountNumber);
  const socket = record.socket;
  if(!socket || record.subscriptions.has(channel)) {
    return;
  }

  const sub = socket.client.newSubscription(channel);
  sub.on('publication', (ctx: any) => {
    handleEnvelope(accountNumber, ctx?.data, channel);
  });
  sub.on('error', (ctx: any) => {
    logger.warn('Centrifugo subscription error', {channel, code: ctx?.error?.code});
  });

  // Subscription state is tracked separately from connection state: a live socket carrying no subscription delivers
  // nothing. `recovered` says whether the messages missed while the subscription was down were replayed.
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
    if(!subscription) {
      continue;
    }

    subscription.unsubscribe();
    record.socket?.client.removeSubscription(subscription);
    record.subscriptions.delete(channel);
    logger.info('Realtime channel unsubscribe requested', {channel});
  }

  for(const channel of diff.subscribe) {
    createSubscription(accountNumber, channel);
    logger.info('Realtime channel subscribe requested', {channel});
  }
}

/** The protobuf codec delivers a publication as bytes: the UTF-8 JSON envelope the server published. */
function envelopeOf(raw: unknown): Envelope | undefined {
  if(ArrayBuffer.isView(raw)) {
    return JSON.parse(new TextDecoder().decode(raw)) as Envelope;
  }

  return raw as Envelope | undefined;
}

function handleEnvelope(accountNumber: ActiveAccountNumber, raw: unknown, channel: string): void {
  const dispatch = connectionFor(accountNumber).dispatch;
  if(!dispatch) {
    logger.warn('Realtime publication has no dispatch; dropped', {accountNumber, channel});
    return;
  }

  // The SDK disconnects a client whose publication handler throws, so a malformed frame is logged here and dropped.
  let envelope: Envelope | undefined;
  try {
    envelope = envelopeOf(raw);
  } catch(err) {
    logger.warn('Realtime envelope is not JSON', {channel}, err);
    return;
  }

  if(!envelope) {
    return;
  }

  const isChannelLane: boolean = channel.startsWith('channel:');
  const channelId: ChatId | undefined = isChannelLane ? parseChannelId(channel.slice('channel:'.length)) : undefined;
  if(isChannelLane && channelId === undefined) {
    logger.error(
      'Realtime channel lane names no channel; dropped',
      {channel},
      makeError('UNKNOWN', 'The channel lane carries no channel id')
    );
    return;
  }

  // Too large to ride the push channel: canon's updatesTooLong means "too many updates to deliver here, fetch the
  // difference" (.demo/telegram-docs-text/constructor/updatesTooLong.md). The lane of the publication asks for it.
  if(envelope.oversize) {
    logger.info('Oversize realtime update; asking for the difference', {type: envelope.type});
    requestDifference(dispatch, channelId);
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

  logger.info('Realtime update received', {
    updates: (updates.updates ?? []).map((update: any) => update._),
    pts: asNumber(envelope.pts),
    ptsCount: asNumber(envelope.ptsCount ?? envelope.pts_count),
    channel
  });

  try {
    dispatch.sink(updates, channelId);
  } catch(err) {
    logger.warn('Realtime update dispatch failed; asking for the difference', {type: envelope.type, channel}, err);
    requestDifference(dispatch, channelId);
  }
}

// Deferred: the SDK's publication handler must not run the recovery inline, and a throw there disconnects the socket.
function requestDifference(dispatch: RealtimeDispatch, channelId: ChatId | undefined): void {
  Promise.resolve().then(() => dispatch.recovery(channelId)).catch((error: unknown): void => {
    reportDifferenceFailure(channelId, error);
  });
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
 * `updateMessageID#4e90bfd6 id:int random_id:long = Update` declares neither pts nor pts_count
 * (constructor/updateMessageID.md). The account's own outgoing message travels in a container that
 * carries BOTH updateMessageID and updateNewMessage with one shared pts, so stamping the envelope's
 * pts onto the updateMessageID would advance the local pts first and the real updateNewMessage would
 * be read as a duplicate. Measured in e2e/live/twoDevicesOneAccount.live.spec.ts (issue #319).
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

const DECIMAL_ID_PATTERN: RegExp = /^\d+$/;

function parseChannelId(text: string): ChatId | undefined {
  return DECIMAL_ID_PATTERN.test(text) ? Number(text) : undefined;
}

function readBytes(value: unknown): Uint8Array | undefined {
  if(value instanceof Uint8Array) {
    return value;
  }

  if(value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  // Centrifugo delivers binary payloads as base64 inside the JSON envelope.
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
