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
 */

import {createClient} from '@connectrpc/connect';

import AccountController from '@lib/accounts/accountController';
import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {AuthService} from './grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {grpcTransport, setGrpcSessionToken, setGrpcUserId} from './grpc/transport';

const logger = getLogger('impulse-session');

let currentAccount: ActiveAccountNumber | undefined;
let pendingTokens: {token: string, refresh: string} | undefined;

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
let resolveSessionReady: () => void;
let sessionReadySettled = false;

// createManagers builds managers for all four slots and calls after() on every
// one, so four restores race here over context-wide state. Empty slots finish
// almost instantly, and settling on the first finisher opened the gate before the
// signed-in account's token was on the headers -- the boot wave then went out
// unauthenticated and half of it came back 401. Only a slot that actually holds a
// user may claim the session; empty slots merely report in, and the gate opens on
// its own once every slot has turned out to be empty (nobody is signed in).
const emptySlots = new Set<ActiveAccountNumber>();

function settleSessionReady(): void {
  if(sessionReadySettled) {
    return;
  }

  sessionReadySettled = true;
  resolveSessionReady();
}
const sessionReady = new Promise<void>((resolve) => {
  resolveSessionReady = resolve;
});

const SESSION_READY_TIMEOUT = 3_000;

/**
 * Gate every request on the restore -- but never indefinitely. If a context ever
 * issues RPCs without going through apiManager.after(), an unbounded wait here
 * would hang every call in that context forever, which looks exactly like a dead
 * network: endless spinners, "waiting for network", nothing ever resolving. A
 * request that goes out unauthenticated fails loudly and recoverably; one that
 * never goes out at all does not.
 */
export function whenImpulseSessionReady(): Promise<void> {
  if(sessionReadySettled) {
    return sessionReady;
  }

  return Promise.race([
    sessionReady,
    new Promise<void>((resolve) => setTimeout(() => {
      if(!sessionReadySettled) {
        logger.warn('Session restore did not finish in time; letting requests through');
      }

      resolve();
    }, SESSION_READY_TIMEOUT))
  ]);
}
let currentRefreshToken: string | undefined;
let refreshInFlight: Promise<boolean> | undefined;

export async function setImpulseAccount(accountNumber: ActiveAccountNumber): Promise<void> {
  currentAccount = accountNumber;

  if(!pendingTokens) {
    return;
  }

  const tokens = pendingTokens;
  await persistTokens(accountNumber, tokens.token, tokens.refresh);
  pendingTokens = undefined;
}

export function applyImpulseUserId(userId: string | number | undefined): void {
  setGrpcUserId(userId === undefined ? undefined : String(userId));
}

/**
 * Pick the session token out of an auth response, if this response carries one.
 * Called for every converted RPC result — cheap, and it means no auth path can
 * be forgotten.
 */
export async function captureImpulseSessionToken(result: unknown): Promise<void> {
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
      logger.warn('Authorization carried no session token', {keys: Object.keys(result as object)});
    }

    return;
  }

  if(typeof refresh !== 'string' || !refresh) {
    logger.warn('Authorization carried no refresh token');
    throw new Error('Authorization carried no refresh token');
  }

  // Authorization conversion happens before its account-aware caller receives
  // the result. Always stage this pair: `currentAccount` may be absent on the
  // first login or may still identify another slot during an account addition.
  setGrpcSessionToken(token);
  currentRefreshToken = refresh;
  pendingTokens = {token, refresh};
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

async function applyTokens(token: string, refresh?: string): Promise<void> {
  const effectiveRefresh = refresh ?? currentRefreshToken;
  if(!effectiveRefresh) {
    logger.warn('Authorization carried no refresh token');
    throw new Error('Authorization carried no refresh token');
  }

  setGrpcSessionToken(token);
  currentRefreshToken = effectiveRefresh;

  if(currentAccount === undefined) {
    pendingTokens = {token, refresh: effectiveRefresh};
    return;
  }

  await persistTokens(currentAccount, token, effectiveRefresh);
}

/**
 * The gateway's access token lives `AccessTokenExpiryMinutes` (15 by default),
 * after which every call comes back AUTH_KEY_UNREGISTERED. The authorization
 * response carries a long-lived refresh token for exactly this, and
 * impulse.auth.RefreshSession trades it for a fresh pair.
 *
 * Single-flight: a expired token fails many in-flight calls at once, and they
 * must not each open their own renewal.
 */
export function refreshImpulseSession(): Promise<boolean> {
  if(refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = runRefresh().finally(() => {
    refreshInFlight = undefined;
  });

  return refreshInFlight;
}

async function runRefresh(): Promise<boolean> {
  if(!currentRefreshToken) {
    // The likeliest reason a session cannot be recovered, and it used to return
    // in silence -- leaving the logs with nothing between "token expired" and
    // "logged out". Say so.
    logger.warn('Cannot refresh the session: no refresh token stored', {account: currentAccount});
    return false;
  }

  try {
    const client = createClient(AuthService, grpcTransport);
    const authorization = await client.refreshSession({refreshToken: currentRefreshToken});
    if(!authorization?.sessionToken) {
      logger.warn('Session refresh returned no token');
      return false;
    }

    await applyTokens(authorization.sessionToken, authorization.refreshToken || undefined);
    logger.info('Session refreshed');
    return true;
  } catch(err) {
    logger.warn('Session refresh failed', undefined, err);
    return false;
  }
}

/** Restore headers on boot so the first RPC after a reload is already authenticated. */
export async function restoreImpulseSession(accountNumber: ActiveAccountNumber): Promise<void> {
  try {
    const data = await AccountController.get(accountNumber);
    if(!data) {
      return;
    }

    if(data.userId === undefined) {
      emptySlots.add(accountNumber);
      if(emptySlots.size >= MAX_ACCOUNTS) {
        settleSessionReady();
      }

      logger.info('Session slot is empty', {accountNumber});
      return;
    }

    await setImpulseAccount(accountNumber);
    applyImpulseUserId(data.userId as unknown as string);

    if(data.impulse_refresh_token) {
      currentRefreshToken = data.impulse_refresh_token;
    }

    if(data.impulse_session_token) {
      setGrpcSessionToken(data.impulse_session_token);
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
  } finally {
    // Released on every path: a restore that found nothing, or failed outright,
    // must not stall every request for the lifetime of the tab.
    // A signed-in slot releases the gate; an empty one only does so once every
    // slot has reported in, above. A failure releases it too -- a restore that
    // threw must not hold every request for the life of the tab.
    if(currentAccount === accountNumber) {
      settleSessionReady();
    }
  }
}

export function clearImpulseSession(): void {
  setGrpcUserId(undefined);
  setGrpcSessionToken(undefined);
  currentRefreshToken = undefined;
  pendingTokens = undefined;

  if(currentAccount === undefined) {
    return;
  }

  try {
    AccountController.clearFields(currentAccount, ['impulse_session_token', 'impulse_refresh_token']);
  } catch(err) {
    logger.warn('Failed to clear the session token', undefined, err);
  }
}
