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
import {createClient} from '@connectrpc/connect';

import {backendWsOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';
import {protoToTL} from './grpc/adapter';
import {UpdateSchema} from './grpc/gen/v1/types_pb';
import {SyncService} from './grpc/gen/v1/internal/impulse/sync/sync_service_pb';
import {grpcTransport} from './grpc/transport';

const logger = getLogger('impulse-realtime');

const CENTRIFUGO_WS = `${backendWsOrigin()}/connection/websocket`;
const TOKEN_EXPIRED_CODE = 109;
// Guards against a re-spin storm if module state is ever transiently reset.
const SPIN_UP_COOLDOWN_MS = 30_000;

export type RealtimeUpdateSink = (update: any, date?: number) => void;

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

let activeUserId: string | undefined;
let connection: Centrifuge | undefined;
let subscription: Subscription | undefined;
let sink: RealtimeUpdateSink | undefined;
let spinUpInProgress = false;
const lastSpinUpAt = new Map<string, number>();

export function setRealtimeSink(fn: RealtimeUpdateSink): void {
  sink = fn;
}

export function startImpulseRealtime(userId: string | undefined): void {
  if(!userId) {
    stopImpulseRealtime();
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
  spinUpInProgress = true;

  spinUp(userId).catch((err: unknown) => {
    logger.warn('Realtime spin-up failed', {userId}, err);
  }).finally(() => {
    spinUpInProgress = false;
  });
}

export function stopImpulseRealtime(): void {
  try {
    subscription?.unsubscribe();
    connection?.disconnect();
  } catch(err) {
    logger.warn('Realtime teardown failed', undefined, err);
  }

  subscription = undefined;
  connection = undefined;
  activeUserId = undefined;
}

async function fetchToken(): Promise<string> {
  const client = createClient(SyncService, grpcTransport);
  const response = await client.getCentrifugoToken({});
  if(!response?.token) {
    throw new Error('Sync.GetCentrifugoToken returned no token');
  }

  return response.token;
}

async function spinUp(userId: string): Promise<void> {
  const token = await fetchToken();

  // The userId may have changed while the token was in flight.
  if(activeUserId !== userId) {
    return;
  }

  const centrifuge = new Centrifuge(CENTRIFUGO_WS, {
    token,
    getToken: () => fetchToken()
  });

  centrifuge.on('error', (ctx: any) => {
    if(ctx?.error?.code === TOKEN_EXPIRED_CODE) {
      logger.info('Centrifugo token expired; refreshing');
      return;
    }

    logger.warn('Centrifugo error', {code: ctx?.error?.code});
  });

  const channel = `user:${userId}`;
  const sub = centrifuge.newSubscription(channel);
  sub.on('publication', (ctx: any) => {
    handleEnvelope(ctx?.data as Envelope, channel);
  });
  sub.on('error', (ctx: any) => {
    logger.warn('Centrifugo subscription error', {channel, code: ctx?.error?.code});
  });

  connection = centrifuge;
  subscription = sub;

  sub.subscribe();
  centrifuge.connect();
  logger.info('Realtime connected', {channel});
}

function handleEnvelope(envelope: Envelope | undefined, channel: string): void {
  if(!envelope || !sink) {
    return;
  }

  // Too large to ride the push channel; the updates manager will pick it up
  // through getDifference.
  if(envelope.oversize) {
    logger.info('Oversize realtime update deferred to getDifference', {type: envelope.type});
    return;
  }

  const bytes = readBytes(envelope.data);
  if(!bytes) {
    logger.warn('Non-binary realtime update ignored', {type: envelope.type, channel});
    return;
  }

  let update: any;
  try {
    update = protoToTL(fromBinary(UpdateSchema, bytes), UpdateSchema);
  } catch(err) {
    // A decode failure must never escape into the worker's error handler.
    logger.warn('Realtime update decode failed', {type: envelope.type, channel}, err);
    return;
  }

  if(!update || typeof update !== 'object') {
    return;
  }

  // TL carries pts on the update itself; the envelope repeats it out of band, so
  // restore it when the decoded update did not already have it.
  applyMetadata(update, envelope);

  try {
    sink(update, asNumber(envelope.date));
  } catch(err) {
    logger.warn('Realtime update dispatch failed', {type: envelope.type}, err);
  }
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
