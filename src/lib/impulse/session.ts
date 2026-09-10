/*
 * Keeps the gRPC auth headers in step with the signed-in account.
 *
 * Unlike MTProto, where identity rides in the auth key, the ImpulseM gateway
 * authenticates every call with a `user-id` header and a bearer session token.
 * The token is minted by the backend and returned on `v1.AuthAuthorizationValue`
 * (field `session_token`), so it is captured wherever an auth RPC comes back —
 * sign-in, sign-up, password check, passkey login and authorization import all
 * share that message.
 *
 * It is persisted next to the rest of the account session data so a reload does
 * not force a re-login.
 *
 * Every function below takes the account number explicitly (#436). A single
 * SharedWorker hosts all four account slots at once (createManagers builds one
 * manager set per slot), and each slot's ApiManager already knows which slot it
 * is -- this module used to throw that away and keep one "current account"
 * instead, so whichever slot wrote last owned every other slot's requests. There
 * is deliberately no module-level "current account" left to reintroduce that bug.
 */

import {createClient} from '@connectrpc/connect';

import AccountController from '@lib/accounts/accountController';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {AuthService} from './grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {getGrpcTransport, setGrpcSessionToken, setGrpcUserId} from './grpc/transport';

const logger = getLogger('impulse-session');

/*
 * Resolves once the stored session has been read back into the transport headers.
 *
 * `after()` kicks restoreImpulseSession off without awaiting it, and the boot
 * sequence starts issuing RPCs in the same tick -- GetAuthorizations went out two
 * milliseconds before the restore finished, so the whole first wave travelled
 * without an Authorization header, came back AUTH_KEY_UNREGISTERED, and the 401
 * policy in rejectPromise signed the user out. The token in storage was correct
 * the entire time; nobody had put it on the request yet.
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

// One gate per account slot, not one gate for the whole tab. createManagers builds
// managers for all four slots and calls after() on every one, so four restores used
// to race here over ONE shared gate -- empty slots settling first opened it before
// the signed-in slot's token was on its headers, and the fix for that (session.ts's
// old emptySlots bookkeeping) only ever worked because there was exactly one signed-in
// slot in the tab. With one gate per slot, each slot's own restore is the only thing
// that can open or reject its own gate; slot 2 booting does not touch slot 1's gate,
// signed in or not, so no such race is possible in the first place.
function gateFor(accountNumber: ActiveAccountNumber): SessionGate {
  let gate = gatesByAccount.get(accountNumber);
  if(!gate) {
    let resolve!: () => void;
    let reject!: (reason: ImpulseSessionRestoreError) => void;
    const ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
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
const refreshInFlightByAccount = new Map<ActiveAccountNumber, Promise<boolean>>();

export function applyImpulseUserId(accountNumber: ActiveAccountNumber, userId: string | number | undefined): void {
  setGrpcUserId(accountNumber, userId === undefined ? undefined : String(userId));
}

/**
 * Pick the session token out of an auth response, if this response carries one.
 * Called for every converted RPC result — cheap, and it means no auth path can
 * be forgotten. The caller already knows which account issued the request (it is
 * threaded through from ApiManager.invokeApi via grpcInvoke), so the token is
 * persisted to that slot directly -- there is no ambiguity left to stage.
 */
export async function captureImpulseSessionToken(accountNumber: ActiveAccountNumber, result: unknown): Promise<void> {
  if(!result || typeof result !== 'object') {
    return;
  }

  const {session_token: token, refresh_token: refresh} = result as {
    session_token?: unknown,
    refresh_token?: unknown
  };

  if(typeof token !== 'string' || !token) {
    // Only worth reporting for a response that looks like an authorization --
    // this runs for every RPC result, and most legitimately carry no token.
    if('user' in (result as object) || 'refresh_token' in (result as object)) {
      logger.warn('Authorization carried no session token', {accountNumber, keys: Object.keys(result as object)});
    }

    return;
  }

  if(typeof refresh !== 'string' || !refresh) {
    logger.warn('Authorization carried no refresh token', {accountNumber});
    throw new Error('Authorization carried no refresh token');
  }

  setGrpcSessionToken(accountNumber, token);
  refreshTokenByAccount.set(accountNumber, refresh);
  await persistTokens(accountNumber, token, refresh);
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
  await persistTokens(accountNumber, token, effectiveRefresh);
}

/**
 * The gateway's access token lives `AccessTokenExpiryMinutes` (15 by default),
 * after which every call comes back AUTH_KEY_UNREGISTERED. The authorization
 * response carries a long-lived refresh token for exactly this, and
 * impulse.auth.RefreshSession trades it for a fresh pair.
 *
 * Single-flight per account: an expired token fails many in-flight calls of that
 * account at once, and they must not each open their own renewal -- but two
 * different accounts refreshing at the same time are two independent renewals
 * and must not share one promise, or the second account's refresh would just
 * return the first account's outcome without ever calling RefreshSession for
 * itself.
 */
export function refreshImpulseSession(accountNumber: ActiveAccountNumber): Promise<boolean> {
  const inFlight = refreshInFlightByAccount.get(accountNumber);
  if(inFlight) {
    return inFlight;
  }

  const promise = runRefresh(accountNumber).finally(() => {
    refreshInFlightByAccount.delete(accountNumber);
  });

  refreshInFlightByAccount.set(accountNumber, promise);
  return promise;
}

async function runRefresh(accountNumber: ActiveAccountNumber): Promise<boolean> {
  const refreshToken = refreshTokenByAccount.get(accountNumber);
  if(!refreshToken) {
    // The likeliest reason a session cannot be recovered, and it used to return
    // in silence -- leaving the logs with nothing between "token expired" and
    // "logged out". Say so.
    logger.warn('Cannot refresh the session: no refresh token stored', {accountNumber});
    return false;
  }

  try {
    const client = createClient(AuthService, getGrpcTransport(accountNumber));
    const authorization = await client.refreshSession({refreshToken});
    if(!authorization?.sessionToken) {
      logger.warn('Session refresh returned no token', {accountNumber});
      return false;
    }

    await applyTokens(accountNumber, authorization.sessionToken, authorization.refreshToken || undefined);
    logger.info('Session refreshed', {accountNumber});
    return true;
  } catch(err) {
    logger.warn('Session refresh failed', {accountNumber}, err);
    return false;
  }
}

/** Restore headers on boot so the first RPC after a reload is already authenticated. */
export async function restoreImpulseSession(accountNumber: ActiveAccountNumber): Promise<void> {
  const gate = gateFor(accountNumber);
  gate.restoreStarted = true;
  try {
    const data = await AccountController.get(accountNumber);
    if(!data || data.userId === undefined) {
      logger.info('Session slot is empty', {accountNumber});
      return;
    }

    if(!data.impulse_session_token) {
      // Not a failure: this is what being signed out looks like from storage. The 401 policy
      // clears the token and leaves the account record behind, so a single backend blip used to
      // land here -- and throwing rejected this slot's gate, which every boot consumer of this
      // slot awaits. getLangPack died with it and the app never reached a screen the user could
      // act on, so a transient outage turned into a permanently blank tab that only clearing site
      // data fixed.
      //
      // A slot that holds no usable session opens its own gate exactly like an empty one, and for
      // the same reason: there is no token for anyone to wait for. That is the path a browser with
      // no stored account already takes -- and that path ends on the sign-in screen.
      logger.info('Session slot is signed out: stored account carries no session token', {
        accountNumber,
        hasUserId: true,
        hasRefreshToken: Boolean(data.impulse_refresh_token)
      });
      return;
    }

    applyImpulseUserId(accountNumber, data.userId as unknown as string);

    if(data.impulse_refresh_token) {
      refreshTokenByAccount.set(accountNumber, data.impulse_refresh_token);
    }

    if(data.impulse_session_token) {
      setGrpcSessionToken(accountNumber, data.impulse_session_token);
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
    // This slot's gate opens once its own restore has run, whatever the other three
    // slots are doing -- see gateFor's comment. Failures reject above, so no request
    // for this account can leave unauthenticated; settleSessionReady is a no-op if
    // that already happened.
    settleSessionReady(accountNumber);
  }
}

export function clearImpulseSession(accountNumber: ActiveAccountNumber): void {
  setGrpcUserId(accountNumber, undefined);
  setGrpcSessionToken(accountNumber, undefined);
  refreshTokenByAccount.delete(accountNumber);

  try {
    AccountController.clearFields(accountNumber, ['impulse_session_token', 'impulse_refresh_token']);
  } catch(err) {
    logger.warn('Failed to clear the session token', {accountNumber}, err);
  }
}
