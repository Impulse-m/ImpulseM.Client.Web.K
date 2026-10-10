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

import {create} from '@bufbuild/protobuf';
import {createClient, createContextKey, encodeBinaryHeader} from '@connectrpc/connect';
import type {Interceptor, StreamRequest, Transport, UnaryRequest} from '@connectrpc/connect';
import {createGrpcWebTransport} from '@connectrpc/connect-web';

import {backendHttpOrigin} from '@config/backendOrigin';
import {IS_WORKER} from '@helpers/context';
import {getLogger, setLogAuthTokenProvider} from '@lib/impulseLogger';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import {AuthService} from './gen/v1/internal/impulse/auth/auth_service_pb';
import {ConnectionDeclarationSchema} from './gen/v1/internal/impulse/auth/auth_types_pb';

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

/*
 * The connection declaration (canon initConnection#c1cd5ea9).
 *
 * MTProto wraps the first query of an uninitialised connection in initConnection; this transport
 * has no such connection, so the same values travel as the binary metadata entry below on every
 * call of a slot whose own `connectionInited` flag is false (canon needsLayer, tdesktop
 * session_private.cpp:586), and as AuthService.InitConnection once the slot has a session to bind
 * them to. The values come from the same place the MTProto networker reads them
 * (networkerFactory.getInitConnectionParams) -- this module only carries them.
 */
const INIT_CONNECTION_HEADER = 'x-impulse-init-connection-bin';

// A failed InitConnection is retried by a later call, never sooner than this, so a server that
// cannot answer it does not get one extra request per ordinary call.
const INIT_CONNECTION_RETRY_BACKOFF_MS = 30_000;

export const CONNECTION_NOT_INITED = 'CONNECTION_NOT_INITED';

export type ConnectionDeclarationValues = {
  apiId: number,
  deviceModel: string,
  systemVersion: string,
  appVersion: string,
  systemLangCode: string,
  langPack: string,
  langCode: string,
  // Seconds east of UTC (initConnection params.tz_offset); undefined leaves params unset.
  tzOffset?: number
};

/**
 * Written by the auth interceptor into the call's context values when it stamped the declaration
 * on that call: the declaration generation it stamped. The caller reads it back after the call
 * to learn which values a session-creating response was created under.
 */
export const stampedDeclarationGenerationKey = createContextKey<number | undefined>(undefined, {
  description: 'declaration generation stamped on this call'
});

export type InitConnectionSender = (
  accountNumber: ActiveAccountNumber,
  declaration: ConnectionDeclarationValues
) => Promise<unknown>;

type AccountCredentials = {
  userId: string | undefined,
  sessionToken: string | undefined,
  qrExporterTicket: string | undefined,
  // Opaque pending-2FA identity (#675) — set from auth.signIn's SESSION_PASSWORD_NEEDED
  // `pending-token` trailer (adapter.ts's capturePendingToken), never decoded, never a source of
  // userId. Kept per account slot exactly like every other credential here, for the same reason.
  pendingToken: string | undefined,
  // Bumped on every pendingToken transition (set OR clear, never read directly by callers).
  // grpcInvoke snapshots this before issuing a request and compares it again when that request's
  // response arrives, so a response belonging to an attempt something newer has since superseded
  // (a fresh sendCode, a logout, a completed session) can be told apart from a current one — the
  // request-attempt correlation #675 revision2 requires, without a new framework.
  pendingGeneration: number,
  // The declared values and their wire form; undefined until the owner of the values publishes them.
  declaration: ConnectionDeclarationValues | undefined,
  declarationHeader: string | undefined,
  // Bumped whenever the declared values change or the binding is invalidated, so a response or
  // handshake that belongs to an older declaration cannot mark the current one as bound.
  declarationGeneration: number,
  // Canon `connectionInited`: true once the server holds the current values for this slot.
  connectionInited: boolean,
  handshakeInFlight: boolean,
  handshakeFailedAt: number | undefined
};

const credentialsByAccount = new Map<ActiveAccountNumber, AccountCredentials>();

function credentialsFor(accountNumber: ActiveAccountNumber): AccountCredentials {
  let credentials = credentialsByAccount.get(accountNumber);
  if(!credentials) {
    credentials = {
      userId: undefined,
      sessionToken: undefined,
      qrExporterTicket: undefined,
      pendingToken: undefined,
      pendingGeneration: 0,
      declaration: undefined,
      declarationHeader: undefined,
      declarationGeneration: 0,
      connectionInited: false,
      handshakeInFlight: false,
      handshakeFailedAt: undefined
    };
    credentialsByAccount.set(accountNumber, credentials);
  }

  return credentials;
}

/**
 * The only gRPC methods the backend accepts a pending-session bearer on
 * (`[AllowsPendingSession]`, AccountPartialService.cs:376-377 / AuthService.cs:350-351,394-395,
 * 419-420,691 — the fully-qualified `service.typeName/method.name` pairs those attributes sit
 * on). Everything else must travel exactly as it does today: no bearer at all when there is no
 * real session, never this one.
 */
const PENDING_SESSION_ALLOWED_METHODS = new Set<string>([
  'v1.account.Account/GetPassword',
  'v1.auth.Auth/CheckPassword',
  'v1.auth.Auth/RequestPasswordRecovery',
  'v1.auth.Auth/CheckRecoveryPassword',
  'v1.auth.Auth/RecoverPassword'
]);

if(!IS_WORKER) {
  setLogAuthTokenProvider(() => credentialsFor(getCurrentAccount()).sessionToken);
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

export function setGrpcPendingToken(accountNumber: ActiveAccountNumber, token: string | undefined): void {
  const credentials = credentialsFor(accountNumber);
  credentials.pendingToken = token;
  credentials.pendingGeneration += 1;
}

/**
 * The one exception to "every pendingToken write bumps the generation": loading a persisted
 * pending token back into memory on boot (restoreImpulseSession) is not a login attempt beginning
 * or ending, it is recovering the state an attempt already had before the reload — so it must not
 * look like an invalidation to a request that is concurrently waiting on the SAME boot's restore
 * to finish (#675 revision3, item A: "restoring credentials is not a new user login attempt").
 * grpcInvoke snapshots the generation before it even awaits readiness; if this function bumped it
 * the way setGrpcPendingToken does, the very first legitimate request of a boot could see its own
 * pre-restore snapshot mismatch the post-restore generation and wrongly discard its own response.
 */
export function restoreGrpcPendingToken(accountNumber: ActiveAccountNumber, token: string): void {
  credentialsFor(accountNumber).pendingToken = token;
}

export function getGrpcPendingToken(accountNumber: ActiveAccountNumber): string | undefined {
  return credentialsFor(accountNumber).pendingToken;
}

export function getGrpcPendingGeneration(accountNumber: ActiveAccountNumber): number {
  return credentialsFor(accountNumber).pendingGeneration;
}

/** Whether `serviceTypeName/methodName` (e.g. "v1.account.Account/GetPassword") is one of the
 * five methods the backend accepts a pending-session bearer on — the same set the auth
 * interceptor itself gates on, exposed so grpcInvoke can decide up front whether a given request
 * is pending-scoped at all before deciding whether its rejection may clear anything. */
export function isPendingSessionAllowedMethod(serviceTypeName: string, methodName: string): boolean {
  return PENDING_SESSION_ALLOWED_METHODS.has(`${serviceTypeName}/${methodName}`);
}

function toDeclarationMessage(values: ConnectionDeclarationValues) {
  return create(ConnectionDeclarationSchema, {
    apiId: values.apiId,
    deviceModel: values.deviceModel,
    systemVersion: values.systemVersion,
    appVersion: values.appVersion,
    systemLangCode: values.systemLangCode,
    langPack: values.langPack,
    langCode: values.langCode,
    params: values.tzOffset === undefined ? undefined : {tzOffset: values.tzOffset}
  });
}

function declarationKey(values: ConnectionDeclarationValues | undefined): string {
  return values === undefined ? '' : JSON.stringify([
    values.apiId,
    values.deviceModel,
    values.systemVersion,
    values.appVersion,
    values.systemLangCode,
    values.langPack,
    values.langCode,
    values.tzOffset ?? null
  ]);
}

/**
 * Publishes the values this slot declares. A value that differs from the published one (a device
 * rename, a language change) clears the slot's connectionInited flag, which is how the change
 * reaches the server: every call carries the new declaration until it is bound again.
 */
export function setConnectionDeclaration(
  accountNumber: ActiveAccountNumber,
  values: ConnectionDeclarationValues
): void {
  const credentials = credentialsFor(accountNumber);
  if(declarationKey(credentials.declaration) === declarationKey(values)) {
    return;
  }

  credentials.declaration = values;
  credentials.declarationHeader = encodeBinaryHeader(toDeclarationMessage(values), ConnectionDeclarationSchema);
  credentials.declarationGeneration += 1;
  credentials.connectionInited = false;
  credentials.handshakeFailedAt = undefined;
}

export function isGrpcConnectionInited(accountNumber: ActiveAccountNumber): boolean {
  return credentialsFor(accountNumber).connectionInited;
}

/**
 * Forgets that the server holds this slot's declaration: on logout (the authorization it was bound
 * to is gone) and on CONNECTION_NOT_INITED (canon: mark not inited, resend with the declaration).
 */
export function resetConnectionInited(accountNumber: ActiveAccountNumber): void {
  const credentials = credentialsFor(accountNumber);
  credentials.declarationGeneration += 1;
  credentials.connectionInited = false;
  credentials.handshakeFailedAt = undefined;
}

/**
 * A call created a NEW session (signIn, signUp, checkPassword, QR import, passkey, ...). When that
 * call carried the current declaration the server stored it on the new authorization, so the slot
 * is bound; when it carried nothing or an outdated one, the new session holds no declaration and
 * the slot is not inited until AuthService.InitConnection binds it.
 */
export function bindDeclarationToNewSession(
  accountNumber: ActiveAccountNumber,
  stampedGeneration: number | undefined
): void {
  const credentials = credentialsFor(accountNumber);
  credentials.connectionInited = stampedGeneration !== undefined &&
    stampedGeneration === credentials.declarationGeneration;
}

/** A successful refresh that carried the current declaration is as good as InitConnection. */
export function bindDeclarationOnRefresh(
  accountNumber: ActiveAccountNumber,
  stampedGeneration: number | undefined
): void {
  const credentials = credentialsFor(accountNumber);
  if(stampedGeneration !== undefined && stampedGeneration === credentials.declarationGeneration) {
    credentials.connectionInited = true;
  }
}

function sendInitConnection(
  accountNumber: ActiveAccountNumber,
  declaration: ConnectionDeclarationValues
): Promise<unknown> {
  return createClient(AuthService, getGrpcTransport(accountNumber)).initConnection({
    declaration: toDeclarationMessage(declaration)
  });
}

/**
 * Sends AuthService.InitConnection for a signed-in slot that is not inited. Never awaited by the
 * call that triggered it, deduplicated per slot, and only marks the slot inited when neither the
 * declared values nor the session changed while it was in flight.
 */
function startHandshake(accountNumber: ActiveAccountNumber, send: InitConnectionSender): void {
  const credentials = credentialsFor(accountNumber);
  const declaration = credentials.declaration;
  const generation = credentials.declarationGeneration;
  const sessionToken = credentials.sessionToken;
  credentials.handshakeInFlight = true;

  void (async(): Promise<void> => {
    try {
      await send(accountNumber, declaration);
      if(
        credentials.declarationGeneration === generation &&
        credentials.sessionToken === sessionToken
      ) {
        credentials.connectionInited = true;
      }
    } catch(err) {
      credentials.handshakeFailedAt = Date.now();
      logger.warn('InitConnection failed', {account: accountNumber}, err);
    } finally {
      credentials.handshakeInFlight = false;
    }
  })();
}

function stampDeclaration(
  accountNumber: ActiveAccountNumber,
  req: Pick<UnaryRequest | StreamRequest, 'header' | 'contextValues' | 'service' | 'method'>,
  send: InitConnectionSender
): void {
  const credentials = credentialsFor(accountNumber);
  if(credentials.connectionInited || credentials.declaration === undefined) {
    return;
  }

  req.header.set(INIT_CONNECTION_HEADER, credentials.declarationHeader);
  req.contextValues.set(stampedDeclarationGenerationKey, credentials.declarationGeneration);

  const isHandshakeCall = req.service.typeName === AuthService.typeName &&
    req.method.name === 'InitConnection';
  if(
    credentials.sessionToken &&
    !isHandshakeCall &&
    !credentials.handshakeInFlight &&
    (
      credentials.handshakeFailedAt === undefined ||
      Date.now() - credentials.handshakeFailedAt >= INIT_CONNECTION_RETRY_BACKOFF_MS
    )
  ) {
    startHandshake(accountNumber, send);
  }
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

export function createAuthInterceptor(
  accountNumber: ActiveAccountNumber,
  send: InitConnectionSender = sendInitConnection
): Interceptor {
  return (next) => async(req) => {
    const credentials = credentialsFor(accountNumber);
    if(credentials.userId) {
      req.header.set('user-id', credentials.userId);
    }

    if(credentials.sessionToken) {
      req.header.set('authorization', `Bearer ${credentials.sessionToken}`);
    } else if(
      credentials.pendingToken &&
      isPendingSessionAllowedMethod(req.service.typeName, req.method.name)
    ) {
      // A real session always wins (the branch above) — the pending bearer only ever fills the
      // gap while this slot has no session yet, and only for the handful of methods the backend
      // accepts it on (#675). Every other method keeps travelling with no bearer, exactly as
      // today, so a pending challenge cannot accidentally widen what an unauthenticated slot can
      // call.
      req.header.set('authorization', `Bearer ${credentials.pendingToken}`);
    }

    if(credentials.qrExporterTicket) {
      req.header.set(QR_EXPORTER_TICKET_HEADER, credentials.qrExporterTicket);
    }

    stampDeclaration(accountNumber, req, send);

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
