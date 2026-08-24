/*
 * gRPC-web transport to the ImpulseM gateway.
 *
 * The gateway is reached directly on its own subdomain (see config/backendOrigin),
 * NOT tunnelled through the dev server. Every call carries the authenticated
 * user id and session token as headers; both are set by the auth flow and
 * cleared on logout.
 *
 * This module is loaded in every context that issues RPCs (main thread and the
 * mtproto worker), each with its own module instance — so the setters below
 * must be called per context.
 */

import type {Interceptor} from '@connectrpc/connect';
import {createGrpcWebTransport} from '@connectrpc/connect-web';

import {backendHttpOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';

const logger = getLogger('grpc-transport');

let currentUserId: string | undefined;
let currentSessionToken: string | undefined;

/*
 * The QR-login exporter ticket.
 *
 * In MTProto the server knows which client exported a QR login token because the
 * request arrives on that client's auth key; auth.exportLoginToken itself carries
 * nothing identifying. gRPC has no auth key, and the client exporting a QR code is
 * by definition not signed in yet, so there is no session token either. The backend
 * therefore issues an opaque ticket with the first exported token and recognises the
 * exporter by it afterwards.
 *
 * Echoing it back is what makes auth.exportLoginToken return the SAME token for the
 * lifetime of one QR code, and what stops the login going to whoever polls
 * auth.importLoginToken first — someone who photographed the code holds the token but
 * not the ticket.
 *
 * Kept in memory only. It belongs to this tab's login attempt the way an auth key
 * belongs to a connection; a reload legitimately starts a new QR code.
 */
const QR_EXPORTER_TICKET_HEADER = 'x-impulse-qr-exporter-ticket';
let currentQrExporterTicket: string | undefined;

export function setGrpcUserId(userId: string | undefined): void {
  currentUserId = userId;
}

export function getGrpcUserId(): string | undefined {
  return currentUserId;
}

export function setGrpcSessionToken(token: string | undefined): void {
  currentSessionToken = token;
}

export function getGrpcSessionToken(): string | undefined {
  return currentSessionToken;
}

/**
 * gRPC-web puts trailers in the response body, so they arrive on `trailer` once the
 * whole unary response has been read. Headers are checked too: the value is the same
 * either way, and which frame carries it is a transport detail this client should not
 * depend on.
 */
function captureQrExporterTicket(response: {header?: Headers, trailer?: Headers}): void {
  const issued = response.trailer?.get(QR_EXPORTER_TICKET_HEADER) ??
    response.header?.get(QR_EXPORTER_TICKET_HEADER);

  if(issued) {
    currentQrExporterTicket = issued;
  }
}

const authInterceptor: Interceptor = (next) => async(req) => {
  if(currentUserId) {
    req.header.set('user-id', currentUserId);
  }

  if(currentSessionToken) {
    req.header.set('authorization', `Bearer ${currentSessionToken}`);
  }

  if(currentQrExporterTicket) {
    req.header.set(QR_EXPORTER_TICKET_HEADER, currentQrExporterTicket);
  }

  const startedAt = performance.now();
  try {
    const response = await next(req);
    captureQrExporterTicket(response);
    logger.debug('gRPC request completed', {
      service: req.service.typeName,
      method: req.method.name,
      durationMs: Math.round(performance.now() - startedAt)
    });
    return response;
  } catch(err) {
    logger.debug('gRPC request failed', {
      service: req.service.typeName,
      method: req.method.name,
      durationMs: Math.round(performance.now() - startedAt)
    }, err);
    throw err;
  }
};

export const grpcTransport = createGrpcWebTransport({
  baseUrl: backendHttpOrigin(),
  interceptors: [authInterceptor]
});
