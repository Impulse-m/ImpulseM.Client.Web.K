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

import {Centrifuge, type Subscription} from 'centrifuge';
import {fromBinary} from '@bufbuild/protobuf';
import {Code, ConnectError, createClient} from '@connectrpc/connect';

import {backendWsOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';
import type {TabState} from '@lib/apiManagerProxy';
import type {ActiveAccountNumber} from '@lib/accounts/types';
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
const TOKEN_EXPIRED_CODE = 109;
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

let activeUserId: string | undefined;
let activeAccountNumber: ActiveAccountNumber | undefined;
let connection: Centrifuge | undefined;
let subscriptionSet: RealtimeSubscriptions | undefined;
let openChannelId: ChatId | undefined;
let latestTabStates: TabState[] = [];
const subscriptions = new Map<string, Subscription>();
let sink: RealtimeUpdateSink | undefined;
let spinUpInProgress = false;
const lastSpinUpAt = new Map<string, number>();

export function setRealtimeSink(fn: RealtimeUpdateSink): void {
  sink = fn;
}

export function startImpulseRealtime(userId: string | undefined, accountNumber: ActiveAccountNumber | undefined): void {
  if(!userId) {
    stopImpulseRealtime();
    return;
  }

  // Every downstream call (the token mint, the transport it travels on) is
  // account-scoped now -- see grpc/transport.ts. There is no account-less
  // identity to fall back to, so refuse rather than spin up a connection nobody
  // can authenticate.
  if(accountNumber === undefined) {
    logger.warn('Realtime spin-up requested with no account number', {userId});
    return;
  }

  if(activeUserId === userId && (connection || spinUpInProgress)) {
    return;
  }

  const previous = lastSpinUpAt.get(userId);
  if(previous !== undefined && Date.now() - previous < SPIN_UP_COOLDOWN_MS && connection) {
    return;
  }

  if(activeUserId && activeUserId !== userId) {
    stopImpulseRealtime();
  }

  lastSpinUpAt.set(userId, Date.now());
  activeUserId = userId;
  activeAccountNumber = accountNumber;
  subscriptionSet = new RealtimeSubscriptions(userId);
  spinUpInProgress = true;

  spinUp(userId, accountNumber).catch((err: unknown) => {
    logger.warn('Realtime spin-up failed', {userId}, err);
  }).finally(() => {
    spinUpInProgress = false;
  });
}

export function stopImpulseRealtime(): void {
  try {
    for(const subscription of subscriptions.values()) {
      subscription.unsubscribe();
    }
    connection?.disconnect();
  } catch(err) {
    logger.warn('Realtime teardown failed', undefined, err);
  }

  subscriptions.clear();
  subscriptionSet = undefined;
  openChannelId = undefined;
  connection = undefined;
  activeUserId = undefined;
  activeAccountNumber = undefined;
}

export function setImpulseRealtimeTabs(states: TabState[]): void {
  latestTabStates = states;
  applyTabStates();
}

function applyTabStates(): void {
  if(!subscriptionSet || activeAccountNumber === undefined) return;

  const states = latestTabStates.filter((state) => state.accountNumber === activeAccountNumber);
  let nextOpenChannelId: ChatId | undefined;
  const visibleChannelIds: ChatId[] = [];
  for(const state of states) {
    visibleChannelIds.push(...state.visibleChannelIds);
    if(state.openChannelId !== undefined) {
      visibleChannelIds.push(state.openChannelId);
      nextOpenChannelId = state.openChannelId;
    }
  }

  if(openChannelId !== undefined && openChannelId !== nextOpenChannelId) {
    applySubscriptionDiff(subscriptionSet.close(openChannelId));
  }
  if(nextOpenChannelId !== undefined) {
    applySubscriptionDiff(subscriptionSet.open(nextOpenChannelId));
  }
  openChannelId = nextOpenChannelId;
  applySubscriptionDiff(subscriptionSet.showDialogs(visibleChannelIds));
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

function isUnauthenticated(err: unknown): boolean {
  return ConnectError.from(err).code === Code.Unauthenticated;
}

async function spinUp(userId: string, accountNumber: ActiveAccountNumber): Promise<void> {
  const token = await fetchCentrifugoToken(accountNumber);

  // The userId may have changed while the token was in flight.
  if(activeUserId !== userId) {
    return;
  }

  const centrifuge = new Centrifuge(CENTRIFUGO_WS, {
    token,
    getToken: () => fetchCentrifugoToken(accountNumber),
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

  connection = centrifuge;
  applyTabStates();
  for(const selectedChannel of subscriptionSet?.getChannels() ?? [channel]) {
    createSubscription(selectedChannel);
  }

  centrifuge.connect();
  logger.info('Realtime spin-up requested', {channel});
}

function createSubscription(channel: string): void {
  if(!connection || subscriptions.has(channel)) return;

  const sub = connection.newSubscription(channel);
  sub.on('publication', (ctx: any) => {
    handleEnvelope(ctx?.data as Envelope, channel);
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

  subscriptions.set(channel, sub);
  sub.subscribe();
  logger.info('Realtime subscription requested', {channel});
}

function applySubscriptionDiff(diff: RealtimeSubscriptionDiff): void {
  for(const channel of diff.unsubscribe) {
    const subscription = subscriptions.get(channel);
    if(!subscription) continue;

    subscription.unsubscribe();
    connection?.removeSubscription(subscription);
    subscriptions.delete(channel);
    logger.info('Realtime channel unsubscribe requested', {channel});
  }

  for(const channel of diff.subscribe) {
    createSubscription(channel);
    logger.info('Realtime channel subscribe requested', {channel});
  }
}

function handleEnvelope(envelope: Envelope | undefined, channel: string): void {
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

function applyMetadata(update: any, envelope: Envelope): void {
  const pts = asNumber(envelope.pts);
  if(pts !== undefined && update.pts === undefined) {
    update.pts = pts;
  }

  const ptsCount = asNumber(envelope.ptsCount ?? envelope.pts_count);
  if(ptsCount !== undefined && update.pts_count === undefined) {
    update.pts_count = ptsCount;
  }

  const qts = asNumber(envelope.qts);
  if(qts !== undefined && update.qts === undefined) {
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
