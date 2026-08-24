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

import AccountController from '@lib/accounts/accountController';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getLogger} from '@lib/impulseLogger';
import {setGrpcSessionToken, setGrpcUserId} from './grpc/transport';

const logger = getLogger('impulse-session');

let currentAccount: ActiveAccountNumber | undefined;

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

  const token = (result as {session_token?: unknown}).session_token;
  if(typeof token !== 'string' || !token) {
    return;
  }

  setGrpcSessionToken(token);
  persistToken(token);
}

function persistToken(token: string): void {
  if(currentAccount === undefined) {
    return;
  }

  try {
    AccountController.update(currentAccount, {impulse_session_token: token});
  } catch(err) {
    logger.warn('Failed to persist the session token', undefined, err);
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

  if(currentAccount === undefined) {
    return;
  }

  try {
    AccountController.update(currentAccount, {impulse_session_token: undefined});
  } catch(err) {
    logger.warn('Failed to clear the session token', undefined, err);
  }
}
