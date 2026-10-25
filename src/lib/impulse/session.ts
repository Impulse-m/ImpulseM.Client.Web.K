import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {UnauthorizedError} from '@impulsem/centrifuge/build/protobuf';

import AccountController from '@lib/accounts/accountController';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {callPool, resetFleetIdentity} from '@lib/impulse/fleet/fleet';
import type {FleetIdentity} from '@lib/impulse/fleet/fleet';
import {isApiError} from '@lib/impulse/fleet/fleetError';
import {INIT_CONNECTION_METHOD, REFRESH_SESSION_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {callUpdateSocket, rekeyUpdateSocket} from '@lib/impulse/realtime';
import {ConnectionDeclarationSchema, InitConnectionRequestSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import {RefreshSessionRequestSchema, RefreshSessionResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {discardIdentity, identityEpoch, identityTokenFor, refuseIdentity} from '@lib/impulse/identity';
import {scheduleTokenRenewal} from '@lib/impulse/tokenRenewal';
import tokenClaims from '@helpers/jwtClaims';
import {reportSignOutFailure} from '@lib/impulse/backgroundFailures';
import {
  getConnectionDeclaration,
  getDeclarationGeneration,
  getGrpcSessionToken,
  isConnectionInited,
  isGrpcSessionTokenRefused,
  markConnectionInited,
  markGrpcSessionTokenRefused,
  resetConnectionInited,
  setGrpcSessionToken
} from '@lib/impulse/grpc/credentials';
import type {ConnectionDeclarationValues} from '@lib/impulse/grpc/credentials';

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
const handshakeInFlightByAccount = new Map<ActiveAccountNumber, {identityKey: string, promise: Promise<boolean>}>();
const handshakeFailedAtByAccount = new Map<ActiveAccountNumber, {identityKey: string, at: number}>();

const sessionEpochs: Map<ActiveAccountNumber, number> = new Map();
const sessionTimers: Map<ActiveAccountNumber, () => void> = new Map();
const signOutHandlers: Map<ActiveAccountNumber, () => Promise<void>> = new Map();

export function setImpulseSessionSignOutHandler(account: ActiveAccountNumber, signOut: () => Promise<void>): void {
  signOutHandlers.set(account, signOut);
}

function sessionEpoch(account: ActiveAccountNumber): number {
  return sessionEpochs.get(account) ?? 0;
}

function advanceSessionEpoch(account: ActiveAccountNumber): void {
  sessionEpochs.set(account, sessionEpoch(account) + 1);
  sessionTimers.get(account)?.();
  sessionTimers.delete(account);
  refreshInFlightByAccount.delete(account);
  handshakeInFlightByAccount.delete(account);
  handshakeFailedAtByAccount.delete(account);
}

export function fleetIdentityFor(accountNumber: ActiveAccountNumber): FleetIdentity {
  const sessionToken: string | undefined = getGrpcSessionToken(accountNumber);
  if(sessionToken !== undefined) {
    const epoch: number = sessionEpoch(accountNumber);
    return {
      kind: 'session',
      key: `session:${epoch}`,
      getToken: (): Promise<string> => tokenForIdentity(accountNumber, `session:${epoch}`, () => sessionAccessToken(accountNumber)),
      onRefused: (error?: ApiError): void => {
        const current: string | undefined = getGrpcSessionToken(accountNumber);
        if(current !== undefined && sessionEpoch(accountNumber) === epoch) {
          if(error?.type === 'AUTH_KEY_UNREGISTERED' && error.socketKind === undefined) {
            const signOut: () => Promise<void> = signOutHandlers.get(accountNumber) ?? ((): Promise<void> => clearImpulseSession(accountNumber));
            void signOut().catch(reportSignOutFailure);
            return;
          }
          markGrpcSessionTokenRefused(accountNumber, current);
        }
      }
    };
  }

  const epoch: number = identityEpoch(accountNumber);
  return {
    kind: 'identity',
    key: `identity:${epoch}`,
    getToken: (): Promise<string> => tokenForIdentity(accountNumber, `identity:${epoch}`, () => identityTokenFor(accountNumber)),
    onRefused: (): void => refuseIdentity(accountNumber, epoch)
  };
}

async function tokenForIdentity(
  account: ActiveAccountNumber,
  key: string,
  acquire: () => Promise<string>
): Promise<string> {
  if(fleetIdentityFor(account).key !== key) {
    throw new UnauthorizedError(SIGNED_OUT_MESSAGE);
  }
  const token: string = await acquire();
  if(fleetIdentityFor(account).key !== key) {
    throw new UnauthorizedError(SIGNED_OUT_MESSAGE);
  }
  return token;
}

async function sessionAccessToken(accountNumber: ActiveAccountNumber): Promise<string> {
  await whenImpulseSessionReady(accountNumber);

  const current = getGrpcSessionToken(accountNumber);
  if(current === undefined) {
    throw new UnauthorizedError(SIGNED_OUT_MESSAGE);
  }

  if(!isGrpcSessionTokenRefused(accountNumber) && (tokenClaims(current)?.exp ?? Infinity) > Date.now() / 1000) {
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
  discardIdentity(accountNumber);
  advanceSessionEpoch(accountNumber);
  identityChanged(accountNumber);
  scheduleSessionRefresh(accountNumber, token);
  await persistTokens(accountNumber, token, refresh);
}

function scheduleSessionRefresh(account: ActiveAccountNumber, token: string): void {
  sessionTimers.get(account)?.();
  sessionTimers.delete(account);
  const exp: number | undefined = tokenClaims(token)?.exp;
  if(exp === undefined || exp <= Date.now() / 1000) {
    return;
  }
  const epoch: number = sessionEpoch(account);
  sessionTimers.set(account, scheduleTokenRenewal({
    exp,
    renew: async(): Promise<void | boolean> => {
      if(sessionEpoch(account) !== epoch) {
        return;
      }
      return await renewImpulseSession(account) !== 'failed';
    }
  }));
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

  setGrpcSessionToken(accountNumber, token);
  refreshTokenByAccount.set(accountNumber, effectiveRefresh);
  scheduleSessionRefresh(accountNumber, token);
  await persistTokens(accountNumber, token, effectiveRefresh);
}

export function refreshImpulseSession(accountNumber: ActiveAccountNumber): Promise<boolean> {
  return renewImpulseSession(accountNumber).then((outcome: RenewalOutcome): boolean => outcome === 'renewed');
}

function renewImpulseSession(accountNumber: ActiveAccountNumber): Promise<RenewalOutcome> {
  const inFlight = refreshInFlightByAccount.get(accountNumber);
  if(inFlight) {
    return inFlight;
  }

  const promise = runRefresh(accountNumber).finally(() => {
    if(refreshInFlightByAccount.get(accountNumber) === promise) {
      refreshInFlightByAccount.delete(accountNumber);
    }
  });

  refreshInFlightByAccount.set(accountNumber, promise);
  return promise;
}

async function runRefresh(accountNumber: ActiveAccountNumber): Promise<RenewalOutcome> {
  const refreshToken: string | undefined = refreshTokenByAccount.get(accountNumber);
  const current: string | undefined = getGrpcSessionToken(accountNumber);
  const epoch: number = sessionEpoch(accountNumber);
  if(!refreshToken || current === undefined) {
    return 'failed';
  }

  try {
    const request: Uint8Array = toBinary(RefreshSessionRequestSchema, create(RefreshSessionRequestSchema, {refreshToken}));
    const call = {accountNumber, method: REFRESH_SESSION_METHOD, request};
    const needsPool: boolean = isGrpcSessionTokenRefused(accountNumber) || (tokenClaims(current)?.exp ?? Infinity) <= Date.now() / 1000;
    const reply: Uint8Array = await (needsPool ? callPool(call) : callUpdateSocket(call));
    if(sessionEpoch(accountNumber) !== epoch) {
      return 'failed';
    }
    const authorization = fromBinary(RefreshSessionResponseSchema, reply);
    if(!authorization.sessionToken) {
      logger.warn('Session refresh returned no token', {accountNumber});
      return 'failed';
    }

    await applyTokens(accountNumber, authorization.sessionToken, authorization.refreshToken || undefined);
    return 'renewed';
  } catch(err: unknown) {
    logger.warn('Session refresh failed', {accountNumber}, err);
    if(isRefusedRefresh(err)) {
      if(sessionEpoch(accountNumber) === epoch) {
        await clearImpulseSession(accountNumber);
      }
      return 'refused';
    }
    return 'failed';
  }
}

function isRefusedRefresh(err: unknown): boolean {
  if(!isApiError(err)) {
    return false;
  }

  return REFRESH_REFUSED_TYPES.has(err.type) || (err.code !== undefined && REFRESH_REFUSED_CODES.has(err.code));
}

/**
 * Binds this slot's connection declaration with AuthService.InitConnection (canon initConnection,
 * method/initConnection.md). Resolves whether the slot is inited afterwards. Deduplicated per slot; a failure is recorded
 * for the backoff and answered as false, never thrown into the call that asked for it.
 */
export function ensureConnectionDeclared(accountNumber: ActiveAccountNumber): Promise<boolean> {
  if(isConnectionInited(accountNumber)) {
    return Promise.resolve(true);
  }

  const identityKey: string = fleetIdentityFor(accountNumber).key;
  const isCurrentIdentity = (): boolean => fleetIdentityFor(accountNumber).key === identityKey;
  const inFlight = handshakeInFlightByAccount.get(accountNumber);
  if(inFlight?.identityKey === identityKey) {
    return inFlight.promise;
  }

  const declaration = getConnectionDeclaration(accountNumber);
  if(declaration === undefined) {
    return Promise.resolve(false);
  }

  const failedAt = handshakeFailedAtByAccount.get(accountNumber);
  if(failedAt?.identityKey === identityKey && Date.now() - failedAt.at < INIT_CONNECTION_RETRY_BACKOFF_MS) {
    return Promise.resolve(false);
  }

  const generation = getDeclarationGeneration(accountNumber);
  const handshake = sendInitConnection(accountNumber, declaration).then(
    (): boolean => {
      if(isCurrentIdentity()) {
        markConnectionInited(accountNumber, generation);
      }

      return isCurrentIdentity() && isConnectionInited(accountNumber);
    },
    (err: unknown): boolean => {
      if(isCurrentIdentity()) {
        handshakeFailedAtByAccount.set(accountNumber, {identityKey, at: Date.now()});
      }
      logger.warn('InitConnection failed', {account: accountNumber}, err);
      return false;
    }
  ).finally(() => {
    if(handshakeInFlightByAccount.get(accountNumber)?.promise === handshake) {
      handshakeInFlightByAccount.delete(accountNumber);
    }
  });

  handshakeInFlightByAccount.set(accountNumber, {identityKey, promise: handshake});
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

  const epoch: number = sessionEpoch(accountNumber);
  try {
    const data = await AccountController.get(accountNumber);
    if(sessionEpoch(accountNumber) !== epoch) {
      return;
    }

    const restoresSession: boolean = data?.userId !== undefined && Boolean(data.impulse_session_token);
    if(restoresSession) {
      if(data.impulse_refresh_token) {
        refreshTokenByAccount.set(accountNumber, data.impulse_refresh_token);
      }

      setGrpcSessionToken(accountNumber, data.impulse_session_token);
    }

    if(restoresSession) {
      discardIdentity(accountNumber);
      advanceSessionEpoch(accountNumber);
      identityChanged(accountNumber);
      scheduleSessionRefresh(accountNumber, data.impulse_session_token);
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
  discardIdentity(accountNumber);
  advanceSessionEpoch(accountNumber);
  identityChanged(accountNumber);
  await AccountController.clearFields(accountNumber, ['impulse_session_token', 'impulse_refresh_token']);
}
