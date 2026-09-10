/*
 * gRPC-web transport to the ImpulseM gateway.
 *
 * The gateway is reached directly on its own subdomain (see config/backendOrigin),
 * NOT tunnelled through the dev server. Every call carries the authenticated
 * user id and session token as headers; both are set by the auth flow and
 * cleared on logout.
 *
 * This module is loaded in every context that issues RPCs (main thread and the
 * mtproto worker), each with its own module instance -- but within one context a
 * single SharedWorker hosts all four account slots side by side (createManagers
 * builds one full manager set per slot; see appManagersManager.ts), so credentials
 * here are keyed by account number rather than held in one "current" pair. Each
 * slot gets its own gRPC-web transport, carrying an interceptor that only ever
 * reads that slot's own credentials (see getGrpcTransport below) -- so there is no
 * shared mutable cell an unrelated account's request could read (#436: a single
 * pair of module-level `currentUserId`/`currentSessionToken` variables meant
 * whichever account last wrote them owned every request from every account in the
 * tab). A caller that does not know which account it is acting for cannot supply
 * one and get a plausible-looking answer anyway -- every function below requires
 * the account number as an explicit parameter.
 */

import type {Interceptor, Transport} from '@connectrpc/connect';
import {createGrpcWebTransport} from '@connectrpc/connect-web';

import {backendHttpOrigin} from '@config/backendOrigin';
import {getLogger} from '@lib/impulseLogger';
import type {ActiveAccountNumber} from '@lib/accounts/types';

const logger = getLogger('grpc-transport');

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
 * Kept in memory only, per account slot like every other credential in this file: a
 * tab exports a QR code for the specific slot it is signing in, and that slot's ticket
 * belongs to its login attempt the way an auth key belongs to a connection -- a reload
 * legitimately starts a new QR code.
 */
const QR_EXPORTER_TICKET_HEADER = 'x-impulse-qr-exporter-ticket';

type AccountCredentials = {
  userId: string | undefined,
  sessionToken: string | undefined,
  qrExporterTicket: string | undefined
};

const credentialsByAccount = new Map<ActiveAccountNumber, AccountCredentials>();

function credentialsFor(accountNumber: ActiveAccountNumber): AccountCredentials {
  let credentials = credentialsByAccount.get(accountNumber);
  if(!credentials) {
    credentials = {userId: undefined, sessionToken: undefined, qrExporterTicket: undefined};
    credentialsByAccount.set(accountNumber, credentials);
  }

  return credentials;
}

export function setGrpcUserId(accountNumber: ActiveAccountNumber, userId: string | undefined): void {
  credentialsFor(accountNumber).userId = userId;
}

export function getGrpcUserId(accountNumber: ActiveAccountNumber): string | undefined {
  return credentialsFor(accountNumber).userId;
}

export function setGrpcSessionToken(accountNumber: ActiveAccountNumber, token: string | undefined): void {
  credentialsFor(accountNumber).sessionToken = token;
}

export function getGrpcSessionToken(accountNumber: ActiveAccountNumber): string | undefined {
  return credentialsFor(accountNumber).sessionToken;
}

export function requireGrpcSessionToken(accountNumber: ActiveAccountNumber): string {
  const token = credentialsFor(accountNumber).sessionToken;
  if(!token) {
    throw new Error('Impulse session is not ready');
  }

  return token;
}

/**
 * gRPC-web puts trailers in the response body, so they arrive on `trailer` once the
 * whole unary response has been read. Headers are checked too: the value is the same
 * either way, and which frame carries it is a transport detail this client should not
 * depend on.
 */
function captureQrExporterTicket(accountNumber: ActiveAccountNumber, response: {header?: Headers, trailer?: Headers}): void {
  const issued = response.trailer?.get(QR_EXPORTER_TICKET_HEADER) ??
    response.header?.get(QR_EXPORTER_TICKET_HEADER);

  if(issued) {
    credentialsFor(accountNumber).qrExporterTicket = issued;
  }
}

function createAuthInterceptor(accountNumber: ActiveAccountNumber): Interceptor {
  return (next) => async(req) => {
    const credentials = credentialsFor(accountNumber);
    if(credentials.userId) {
      req.header.set('user-id', credentials.userId);
    }

    if(credentials.sessionToken) {
      req.header.set('authorization', `Bearer ${credentials.sessionToken}`);
    }

    if(credentials.qrExporterTicket) {
      req.header.set(QR_EXPORTER_TICKET_HEADER, credentials.qrExporterTicket);
    }

    const startedAt = performance.now();
    try {
      const response = await next(req);
      captureQrExporterTicket(accountNumber, response);
      logger.debug('gRPC request completed', {
        account: accountNumber,
        service: req.service.typeName,
        method: req.method.name,
        durationMs: Math.round(performance.now() - startedAt)
      });
      return response;
    } catch(err) {
      logger.debug('gRPC request failed', {
        account: accountNumber,
        service: req.service.typeName,
        method: req.method.name,
        durationMs: Math.round(performance.now() - startedAt)
      }, err);
      throw err;
    }
  };
}

const transportByAccount = new Map<ActiveAccountNumber, Transport>();

/**
 * One gRPC-web transport per account slot. Each carries its own auth interceptor,
 * closed over that slot's account number -- so it only ever stamps that slot's own
 * credentials, no matter which other account slots exist in this same worker.
 * gRPC-web has no persistent connection (every call is a plain `fetch`, see
 * createGrpcWebTransport), so holding one of these per slot costs a small object,
 * not a socket.
 */
export function getGrpcTransport(accountNumber: ActiveAccountNumber): Transport {
  let transport = transportByAccount.get(accountNumber);
  if(!transport) {
    transport = createGrpcWebTransport({
      baseUrl: backendHttpOrigin(),
      interceptors: [createAuthInterceptor(accountNumber)]
    });
    transportByAccount.set(accountNumber, transport);
  }

  return transport;
}
