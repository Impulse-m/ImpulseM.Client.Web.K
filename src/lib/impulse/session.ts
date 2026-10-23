/*
 * Keeps the session identity of each account slot in step with its update socket and its media pool.
 *
 * Unlike MTProto, where identity rides in the auth key, the ImpulseM carriers authenticate a connection with a token.
 * The access token is minted by the backend and returned on `v1.AuthAuthorizationValue` (field `session_token`), so
 * it is captured wherever an auth RPC comes back: sign-in, sign-up, password check, passkey login and authorization
 * import all share that message. The update socket of a signed-in slot connects with it (fleetIdentityFor). The SDK asks
 * for the token when a connection needs one; the token is renewed only once the server has refused it.
 *
 * It is persisted next to the rest of the account session data so a reload does not force a re-login.
 *
 * Every function below takes the account number explicitly (#436). A single SharedWorker hosts all four account
 * slots at once (createManagers builds one manager set per slot), and each slot's ApiManager already knows which slot
 * it is.
 */

import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {UnauthorizedError} from '@impulsem/centrifuge/build/protobuf';

import AccountController from '@lib/accounts/accountController';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {ANONYMOUS_IDENTITY, callRefreshFleet, resetFleetIdentity} from '@lib/impulse/fleet/fleet';
import type {FleetIdentity} from '@lib/impulse/fleet/fleet';
import {isApiError} from '@lib/impulse/fleet/fleetError';
import {INIT_CONNECTION_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {callUpdateSocket, rekeyUpdateSocket} from '@lib/impulse/realtime';
import {AuthorizationSchema, ConnectionDeclarationSchema, InitConnectionRequestSchema} from './grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import {RefreshSessionRequestSchema} from './grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {
  getConnectionDeclaration,
  getDeclarationGeneration,
  getGrpcPendingGeneration,
  getGrpcPendingToken,
  getGrpcSessionToken,
  isConnectionInited,
  isGrpcSessionTokenRefused,
  markConnectionInited,
  markGrpcSessionTokenRefused,
  resetConnectionInited,
  restoreGrpcPendingToken,
  setGrpcPendingToken,
  setGrpcSessionToken
} from './grpc/credentials';
import type {ConnectionDeclarationValues} from './grpc/credentials';

const logger = getLogger('impulse-session');

export const CONNECTION_NOT_INITED: string = 'CONNECTION_NOT_INITED';

// A failed InitConnection is retried by a later call, never sooner than this, so a server that cannot answer it does not
// get one extra request per ordinary call.
const INIT_CONNECTION_RETRY_BACKOFF_MS: number = 30_000;
const SIGNED_OUT_MESSAGE: string = 'Impulse session is signed out';
const REFRESH_REFUSED_MESSAGE: string = 'Impulse session was refused by the refresh';
const REFRESH_FAILED_MESSAGE: string = 'Impulse session refresh failed; the connection retries';
// The HTTP-style codes of a refresh the server refused: the refresh token no longer holds a session.
const REFRESH_REFUSED_CODES: ReadonlySet<number> = new Set<number>([401, 403]);
// The refresh token the server no longer holds is refused as AUTH_TOKEN_INVALID, code 400 (RefreshSessionCommand.cs:424).
const REFRESH_REFUSED_TYPES: ReadonlySet<ErrorType> = new Set<ErrorType>(['AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED']);

type RenewalOutcome = 'renewed' | 'refused' | 'failed';

/*
 * Resolves once the stored session has been read back into the credentials.
 *
 * `after()` kicks restoreImpulseSession off without awaiting it, and the boot sequence starts issuing RPCs in the same
 * tick. Every call waits for this gate, so nothing leaves before the stored token is in place.
 */
export class ImpulseSessionRestoreError extends Error {
  public readonly code = 'IMPULSE_SESSION_RESTORE_FAILED';
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = 'ImpulseSessionRestoreError';
  }
}

type SessionGate = {
  ready: Promise<void>,
  resolve: () => void,
  reject: (reason: ImpulseSessionRestoreError) => void,
  settled: boolean,
  restoreStarted: boolean
};

const gatesByAccount = new Map<ActiveAccountNumber, SessionGate>();

// One gate per account slot: each slot's own restore is the only thing that can open or reject its own gate.
function gateFor(accountNumber: ActiveAccountNumber): SessionGate {
  let gate = gatesByAccount.get(accountNumber);
  if(!gate) {
    let resolve!: () => void;
    let reject!: (reason: ImpulseSessionRestoreError) => void;
    const ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Without a handler, a gate nobody awaits reports an unhandled rejection; every awaiter still receives it.
    ready.catch(() => {});

    gate = {ready, resolve, reject, settled: false, restoreStarted: false};
    gatesByAccount.set(accountNumber, gate);
  }

  return gate;
}

function settleSessionReady(accountNumber: ActiveAccountNumber, error?: ImpulseSessionRestoreError): void {
  const gate = gateFor(accountNumber);
  if(gate.settled) {
    return;
  }

  gate.settled = true;
  if(error) {
    gate.reject(error);
  } else {
    gate.resolve();
  }
}

export function whenImpulseSessionReady(accountNumber: ActiveAccountNumber): Promise<void> {
  const gate = gateFor(accountNumber);
  if(import.meta.env.DEV && !gate.restoreStarted) {
    return Promise.reject(new ImpulseSessionRestoreError(
      'Impulse session restore was not started; apiManager.after() was bypassed'
    ));
  }

  return gate.ready;
}

const refreshTokenByAccount = new Map<ActiveAccountNumber, string>();
const refreshInFlightByAccount = new Map<ActiveAccountNumber, Promise<RenewalOutcome>>();
const handshakeInFlightByAccount = new Map<ActiveAccountNumber, Promise<boolean>>();
const handshakeFailedAtByAccount = new Map<ActiveAccountNumber, number>();

/**
 * The identity of the slot's update socket and its media pool: the access JWT of a signed-in slot, the pending 2FA token
 * of a slot holding a challenge, and no token otherwise. The key changes with the token, so a renewed token is a new
 * identity for the connections that present it.
 */
export function fleetIdentityFor(accountNumber: ActiveAccountNumber): FleetIdentity {
  const sessionToken = getGrpcSessionToken(accountNumber);
  if(sessionToken !== undefined) {
    return {
      kind: 'session',
      key: `session:${sessionToken}`,
      getToken: (): Promise<string> => sessionAccessToken(accountNumber),
      onRefused: (): void => markGrpcSessionTokenRefused(accountNumber, sessionToken)
    };
  }

  const pendingToken = getGrpcPendingToken(accountNumber);
  if(pendingToken !== undefined) {
    return {kind: 'pending', key: `pending:${pendingToken}`, getToken: (): Promise<string> => Promise.resolve(pendingToken)};
  }

  return ANONYMOUS_IDENTITY;
}

/**
 * The token a connection of the update socket presents. The token the slot holds is handed out unchanged, and renewed
 * through the refresh only once the server has refused it; a refused session ends the connection (UnauthorizedError),
 * a failed renewal in transit is retried by the SDK.
 */
async function sessionAccessToken(accountNumber: ActiveAccountNumber): Promise<string> {
  await whenImpulseSessionReady(accountNumber);

  const current = getGrpcSessionToken(accountNumber);
  if(current === undefined) {
    throw new UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  if(!isGrpcSessionTokenRefused(accountNumber)) {
    return current;
  }

  const outcome = await renewImpulseSession(accountNumber);
  if(outcome === 'refused') {
    throw new UnauthorizedError(REFRESH_REFUSED_MESSAGE);
  }

  if(outcome === 'failed') {
    throw new Error(REFRESH_FAILED_MESSAGE);
  }

  const renewed = getGrpcSessionToken(accountNumber);
  if(renewed === undefined) {
    throw new UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  return renewed;
}

/**
 * Captures the session of an auth reply that carries one. Called for every converted RPC result, so no auth path can be
 * forgotten. A new session is not yet bound to the connection declaration: the next call declares the connection.
 */
export async function captureImpulseSessionToken(accountNumber: ActiveAccountNumber, result: unknown): Promise<void> {
  if(!result || typeof result !== 'object') {
    return;
  }

  const carrier: object = authorizationCarrier(result);
  const {session_token: token, refresh_token: refresh} = carrier as {
    session_token?: unknown,
    refresh_token?: unknown
  };

  if(typeof token !== 'string' || !token) {
    // Only worth reporting for a response that looks like an authorization: this runs for every RPC result.
    if('user' in carrier || 'refresh_token' in carrier) {
      logger.warn('Authorization carried no session token', {accountNumber, keys: Object.keys(carrier)});
    }

    return;
  }

  if(typeof refresh !== 'string' || !refresh) {
    logger.warn('Authorization carried no refresh token', {accountNumber});
    throw new Error('Authorization carried no refresh token');
  }

  resetConnectionInited(accountNumber);
  await adoptSession(accountNumber, token, refresh);
}

async function adoptSession(accountNumber: ActiveAccountNumber, token: string, refresh: string): Promise<void> {
  setGrpcSessionToken(accountNumber, token);
  refreshTokenByAccount.set(accountNumber, refresh);
  // A real session now exists for this slot: any pending 2FA challenge it carried is obsolete, and every connection of
  // the slot reconnects with the new identity.
  dropPendingToken(accountNumber);
  identityChanged(accountNumber);
  await clearPersistedPendingToken(accountNumber);
  await persistTokens(accountNumber, token, refresh);
}

// auth.loginTokenSuccess (the QR login reply) nests its authorization under `authorization`;
// every other auth reply carries the tokens at the top level.
function authorizationCarrier(result: object): object {
  const {_: predicate, authorization}: {_?: unknown, authorization?: unknown} = result;
  if(predicate === 'auth.loginTokenSuccess' && authorization && typeof authorization === 'object') {
    return authorization;
  }

  return result;
}

/**
 * The slot's credentials changed its identity: its media lanes of the old identity retire, and its update socket moves to
 * the identity the credentials hold now.
 */
function identityChanged(accountNumber: ActiveAccountNumber): void {
  resetFleetIdentity(accountNumber);
  rekeyUpdateSocket(accountNumber);
}

async function persistTokens(account: ActiveAccountNumber, token: string, refresh: string): Promise<void> {
  try {
    await AccountController.update(account, {
      impulse_session_token: token,
      impulse_refresh_token: refresh
    });
    logger.info('Session tokens persisted', {account, withRefresh: true});
  } catch(err) {
    logger.warn('Failed to persist the session tokens', {account}, err);
    throw err;
  }
}

async function applyTokens(accountNumber: ActiveAccountNumber, token: string, refresh?: string): Promise<void> {
  const effectiveRefresh = refresh ?? refreshTokenByAccount.get(accountNumber);
  if(!effectiveRefresh) {
    logger.warn('Authorization carried no refresh token', {accountNumber});
    throw new Error('Authorization carried no refresh token');
  }

  await adoptSession(accountNumber, token, effectiveRefresh);
}

/**
 * Takes a pending 2FA token for this slot: in memory (the connections of the slot reconnect under it) and in storage, so a
 * reload or SharedWorker restart while the challenge is pending does not lose it. The in-memory token stays usable for
 * this tab's current attempt either way; only cross-reload survival is at risk if the storage write fails.
 */
export async function capturePendingToken(accountNumber: ActiveAccountNumber, token: string): Promise<void> {
  setGrpcPendingToken(accountNumber, token);
  identityChanged(accountNumber);
  await persistPendingToken(accountNumber, token);
}

async function persistPendingToken(accountNumber: ActiveAccountNumber, token: string): Promise<void> {
  await AccountController.update(accountNumber, {impulse_pending_token: token});
  logger.info('Pending token persisted', {accountNumber});
}

/**
 * Drops the pending-2FA credential: in memory (its connections reconnect without it) and, awaited, in storage. The
 * session and refresh fields are never touched here.
 */
export async function clearPendingToken(accountNumber: ActiveAccountNumber): Promise<void> {
  if(dropPendingToken(accountNumber)) {
    identityChanged(accountNumber);
  }

  await clearPersistedPendingToken(accountNumber);
}

function dropPendingToken(accountNumber: ActiveAccountNumber): boolean {
  const hadPendingToken = getGrpcPendingToken(accountNumber) !== undefined;
  setGrpcPendingToken(accountNumber, undefined);
  return hadPendingToken;
}

async function clearPersistedPendingToken(accountNumber: ActiveAccountNumber): Promise<void> {
  await AccountController.clearFields(accountNumber, ['impulse_pending_token']);
}

/**
 * The access token lives `AccessTokenExpiryMinutes` (15 by default). The authorization response carries a
 * long-lived refresh token for exactly this, and impulse.auth.RefreshSession trades it for a fresh pair.
 *
 * Single-flight per account: an expired token fails many in-flight calls of that account at once, and they must not
 * each open their own renewal. Two different accounts refreshing at the same time are two independent renewals.
 */
export function refreshImpulseSession(accountNumber: ActiveAccountNumber): Promise<boolean> {
  return renewImpulseSession(accountNumber).then((outcome: RenewalOutcome): boolean => outcome === 'renewed');
}

function renewImpulseSession(accountNumber: ActiveAccountNumber): Promise<RenewalOutcome> {
  const inFlight = refreshInFlightByAccount.get(accountNumber);
  if(inFlight) {
    return inFlight;
  }

  const promise = runRefresh(accountNumber, false).finally(() => {
    refreshInFlightByAccount.delete(accountNumber);
  });

  refreshInFlightByAccount.set(accountNumber, promise);
  return promise;
}

async function runRefresh(accountNumber: ActiveAccountNumber, isReinitRetry: boolean): Promise<RenewalOutcome> {
  const refreshToken = refreshTokenByAccount.get(accountNumber);
  if(!refreshToken) {
    logger.warn('Cannot refresh the session: no refresh token stored', {accountNumber});
    return 'failed';
  }

  try {
    // The anonymous pool, not the update socket: a connect-time 109 of that socket waits for the token this call renews.
    const reply = await callRefreshFleet(
      accountNumber,
      toBinary(RefreshSessionRequestSchema, create(RefreshSessionRequestSchema, {refreshToken}))
    );
    const authorization = fromBinary(AuthorizationSchema, reply);
    if(!authorization.sessionToken) {
      logger.warn('Session refresh returned no token', {accountNumber});
      return 'failed';
    }

    await applyTokens(accountNumber, authorization.sessionToken, authorization.refreshToken || undefined);
    logger.info('Session refreshed', {accountNumber});
    return 'renewed';
  } catch(err) {
    // The server wants the declaration this refresh did not carry. The declaration travels the update socket, which may be
    // waiting for the token this renewal produces, so it is sent without being awaited here.
    if(!isReinitRetry && isApiError(err) && err.type === CONNECTION_NOT_INITED) {
      resetConnectionInited(accountNumber);
      void ensureConnectionDeclared(accountNumber);
      return runRefresh(accountNumber, true);
    }

    logger.warn('Session refresh failed', {accountNumber}, err);
    return isRefusedRefresh(err) ? 'refused' : 'failed';
  }
}

function isRefusedRefresh(err: unknown): boolean {
  if(!isApiError(err)) {
    return false;
  }

  return REFRESH_REFUSED_TYPES.has(err.type) || (err.code !== undefined && REFRESH_REFUSED_CODES.has(err.code));
}

/**
 * Binds this slot's connection declaration to its session with AuthService.InitConnection (canon initConnection,
 * method/initConnection.md). Resolves whether the slot is inited afterwards. Deduplicated per slot; a failure is recorded
 * for the backoff and answered as false, never thrown into the call that asked for it.
 */
export function ensureConnectionDeclared(accountNumber: ActiveAccountNumber): Promise<boolean> {
  if(isConnectionInited(accountNumber)) {
    return Promise.resolve(true);
  }

  const inFlight = handshakeInFlightByAccount.get(accountNumber);
  if(inFlight) {
    return inFlight;
  }

  const declaration = getConnectionDeclaration(accountNumber);
  const sessionToken = getGrpcSessionToken(accountNumber);
  if(declaration === undefined || sessionToken === undefined) {
    return Promise.resolve(false);
  }

  const failedAt = handshakeFailedAtByAccount.get(accountNumber);
  if(failedAt !== undefined && Date.now() - failedAt < INIT_CONNECTION_RETRY_BACKOFF_MS) {
    return Promise.resolve(false);
  }

  const generation = getDeclarationGeneration(accountNumber);
  const handshake = sendInitConnection(accountNumber, declaration).then(
    (): boolean => {
      if(getGrpcSessionToken(accountNumber) === sessionToken) {
        markConnectionInited(accountNumber, generation);
      }

      return isConnectionInited(accountNumber);
    },
    (err: unknown): boolean => {
      handshakeFailedAtByAccount.set(accountNumber, Date.now());
      logger.warn('InitConnection failed', {account: accountNumber}, err);
      return false;
    }
  ).finally(() => {
    handshakeInFlightByAccount.delete(accountNumber);
  });

  handshakeInFlightByAccount.set(accountNumber, handshake);
  return handshake;
}

async function sendInitConnection(accountNumber: ActiveAccountNumber, declaration: ConnectionDeclarationValues): Promise<void> {
  const request = create(InitConnectionRequestSchema, {declaration: toDeclarationMessage(declaration)});
  await callUpdateSocket({
    accountNumber,
    method: INIT_CONNECTION_METHOD,
    request: toBinary(InitConnectionRequestSchema, request)
  });
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

/** Restores the stored session before the first call of a boot leaves. */
export async function restoreImpulseSession(accountNumber: ActiveAccountNumber): Promise<void> {
  const gate = gateFor(accountNumber);
  gate.restoreStarted = true;

  // Snapshotted before the storage read is issued: a concurrent sign-out or new login that moves the generation on
  // while the read is in flight leaves this read holding a stale record, which must not be applied.
  const pendingGenerationAtRestoreStart = getGrpcPendingGeneration(accountNumber);
  try {
    const data = await AccountController.get(accountNumber);

    // A persisted pending challenge carries no session: it is only a token for the methods that accept one.
    const pendingToken: string | undefined = getGrpcPendingGeneration(accountNumber) === pendingGenerationAtRestoreStart
      ? data?.impulse_pending_token
      : undefined;
    if(pendingToken) {
      restoreGrpcPendingToken(accountNumber, pendingToken);
    }

    const restoresSession: boolean = data?.userId !== undefined && Boolean(data.impulse_session_token);
    if(restoresSession) {
      if(data.impulse_refresh_token) {
        refreshTokenByAccount.set(accountNumber, data.impulse_refresh_token);
      }

      setGrpcSessionToken(accountNumber, data.impulse_session_token);
    }

    if(pendingToken || restoresSession) {
      identityChanged(accountNumber);
    }

    if(!data || data.userId === undefined) {
      logger.info('Session slot is empty', {accountNumber});
      return;
    }

    if(!data.impulse_session_token) {
      // Not a failure: this is what being signed out looks like from storage. A slot that holds no usable session
      // opens its gate exactly like an empty one, and ends on the sign-in screen.
      logger.info('Session slot is signed out: stored account carries no session token', {
        accountNumber,
        hasUserId: true,
        hasRefreshToken: Boolean(data.impulse_refresh_token)
      });
      return;
    }

    // Presence only -- never the values themselves.
    logger.info('Session restored from storage', {
      accountNumber,
      hasUserId: data.userId !== undefined,
      hasSessionToken: Boolean(data.impulse_session_token),
      hasRefreshToken: Boolean(data.impulse_refresh_token)
    });
  } catch(err) {
    logger.warn('Failed to restore the session', {accountNumber}, err);
    settleSessionReady(accountNumber, err instanceof ImpulseSessionRestoreError ? err : new ImpulseSessionRestoreError(
      'Failed to restore the Impulse session',
      err
    ));
    return;
  } finally {
    // This slot's gate opens once its own restore has run, whatever the other three slots are doing.
    settleSessionReady(accountNumber);
  }
}

/** Ends this slot's session: the credentials are dropped and every connection of the slot is retired. */
export async function clearImpulseSession(accountNumber: ActiveAccountNumber): Promise<void> {
  setGrpcSessionToken(accountNumber, undefined);
  resetConnectionInited(accountNumber);
  refreshTokenByAccount.delete(accountNumber);
  // logOut() is an exhaustive wipe of this slot's credentials: a pending 2FA challenge is one of them, too.
  dropPendingToken(accountNumber);
  identityChanged(accountNumber);
  await AccountController.clearFields(accountNumber, ['impulse_pending_token', 'impulse_session_token', 'impulse_refresh_token']);
}
