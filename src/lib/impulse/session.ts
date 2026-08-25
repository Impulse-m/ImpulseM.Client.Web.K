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
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {AuthService} from './grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {grpcTransport, setGrpcSessionToken, setGrpcUserId} from './grpc/transport';

const logger = getLogger('impulse-session');

let currentAccount: ActiveAccountNumber | undefined;
let currentRefreshToken: string | undefined;
let refreshInFlight: Promise<boolean> | undefined;

export function setImpulseAccount(accountNumber: ActiveAccountNumber): void {
  currentAccount = accountNumber;
}

export function applyImpulseUserId(userId: string | number | undefined): void {
  setGrpcUserId(userId === undefined ? undefined : String(userId));
}

/**
 * Pick the session token out of an auth response, if this response carries one.
 * Called for every converted RPC result — cheap, and it means no auth path can
 * be forgotten.
 */
export function captureImpulseSessionToken(result: unknown): void {
  if(!result || typeof result !== 'object') {
    return;
  }

  const {session_token: token, refresh_token: refresh} = result as {
    session_token?: unknown,
    refresh_token?: unknown
  };

  if(typeof token !== 'string' || !token) {
    return;
  }

  applyTokens(token, typeof refresh === 'string' && refresh ? refresh : undefined);
}

function applyTokens(token: string, refresh?: string): void {
  setGrpcSessionToken(token);
  if(refresh) {
    currentRefreshToken = refresh;
  }

  if(currentAccount === undefined) {
    return;
  }

  try {
    AccountController.update(currentAccount, {
      impulse_session_token: token,
      impulse_refresh_token: refresh ?? currentRefreshToken
    });
  } catch(err) {
    logger.warn('Failed to persist the session tokens', undefined, err);
  }
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
    return false;
  }

  try {
    const client = createClient(AuthService, grpcTransport);
    const authorization = await client.refreshSession({refreshToken: currentRefreshToken});
    if(!authorization?.sessionToken) {
      logger.warn('Session refresh returned no token');
      return false;
    }

    applyTokens(authorization.sessionToken, authorization.refreshToken || undefined);
    logger.info('Session refreshed');
    return true;
  } catch(err) {
    logger.warn('Session refresh failed', undefined, err);
    return false;
  }
}

/** Restore headers on boot so the first RPC after a reload is already authenticated. */
export async function restoreImpulseSession(accountNumber: ActiveAccountNumber): Promise<void> {
  setImpulseAccount(accountNumber);

  try {
    const data = await AccountController.get(accountNumber);
    if(!data) {
      return;
    }

    if(data.userId !== undefined) {
      applyImpulseUserId(data.userId as unknown as string);
    }

    if(data.impulse_refresh_token) {
      currentRefreshToken = data.impulse_refresh_token;
    }

    if(data.impulse_session_token) {
      setGrpcSessionToken(data.impulse_session_token);
    }
  } catch(err) {
    logger.warn('Failed to restore the session', {accountNumber}, err);
  }
}

export function clearImpulseSession(): void {
  setGrpcUserId(undefined);
  setGrpcSessionToken(undefined);
  currentRefreshToken = undefined;

  if(currentAccount === undefined) {
    return;
  }

  try {
    AccountController.update(currentAccount, {
      impulse_session_token: undefined,
      impulse_refresh_token: undefined
    });
  } catch(err) {
    logger.warn('Failed to clear the session token', undefined, err);
  }
}
