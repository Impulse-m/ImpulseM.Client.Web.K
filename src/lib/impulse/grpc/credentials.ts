/*
 * The per-account credentials the fleets present: the session access token of a signed-in slot, the opaque pending-2FA
 * token of a slot between SESSION_PASSWORD_NEEDED and its session, and the connection declaration the server binds to
 * that session (canon initConnection).
 *
 * Every function takes the account number explicitly (#436): a single SharedWorker hosts all four account slots, and
 * no slot may read another slot's credentials. The fleet connections of a slot are built from these values (fleet/).
 */

import {IS_WORKER} from '@helpers/context';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {getCurrentAccount} from '@lib/accounts/getCurrentAccount';
import {setLogAuthTokenProvider} from '@lib/impulseLogger';

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

type AccountCredentials = {
  sessionToken: string | undefined,
  // Bumped on every pendingToken transition (set OR clear, never read directly by callers), so a response that belongs to
  // an attempt something newer has superseded can be told apart from a current one (#675).
  pendingToken: string | undefined,
  pendingGeneration: number,
  declaration: ConnectionDeclarationValues | undefined,
  // Bumped whenever the declared values change or the binding is invalidated, so a handshake that belongs to an older
  // declaration cannot mark the current one as bound.
  declarationGeneration: number,
  // Canon `connectionInited`: true once the server holds the current values for this slot.
  connectionInited: boolean
};

const credentialsByAccount = new Map<ActiveAccountNumber, AccountCredentials>();

/**
 * The only methods the backend accepts a pending-session token on (`[AllowsPendingSession]`, AuthService.cs and
 * AccountPartialService.cs). Every other method travels with no token when there is no real session.
 */
const PENDING_SESSION_ALLOWED_METHODS: ReadonlySet<string> = new Set<string>([
  'account.getPassword',
  'auth.checkPassword',
  'auth.requestPasswordRecovery',
  'auth.checkRecoveryPassword',
  'auth.recoverPassword'
]);

if(!IS_WORKER) {
  setLogAuthTokenProvider(() => credentialsFor(getCurrentAccount()).sessionToken);
}

function credentialsFor(accountNumber: ActiveAccountNumber): AccountCredentials {
  let credentials = credentialsByAccount.get(accountNumber);
  if(!credentials) {
    credentials = {
      sessionToken: undefined,
      pendingToken: undefined,
      pendingGeneration: 0,
      declaration: undefined,
      declarationGeneration: 0,
      connectionInited: false
    };
    credentialsByAccount.set(accountNumber, credentials);
  }

  return credentials;
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
 * Loading a persisted pending token back into memory on boot is recovering the state an attempt already had, not an
 * attempt beginning or ending, so it does not bump the generation (#675 revision3).
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

/** Whether a TL method (e.g. "account.getPassword") may present the pending-2FA token as its connection token. */
export function isPendingSessionAllowedMethod(method: string): boolean {
  return PENDING_SESSION_ALLOWED_METHODS.has(method);
}

/**
 * Publishes the values this slot declares. A value that differs from the published one (a device rename, a language
 * change) clears the slot's connectionInited flag, so the next declaration carries the new values.
 */
export function setConnectionDeclaration(accountNumber: ActiveAccountNumber, values: ConnectionDeclarationValues): void {
  const credentials = credentialsFor(accountNumber);
  if(declarationKey(credentials.declaration) === declarationKey(values)) {
    return;
  }

  credentials.declaration = values;
  credentials.declarationGeneration += 1;
  credentials.connectionInited = false;
}

export function getConnectionDeclaration(accountNumber: ActiveAccountNumber): ConnectionDeclarationValues | undefined {
  return credentialsFor(accountNumber).declaration;
}

export function getDeclarationGeneration(accountNumber: ActiveAccountNumber): number {
  return credentialsFor(accountNumber).declarationGeneration;
}

export function isConnectionInited(accountNumber: ActiveAccountNumber): boolean {
  return credentialsFor(accountNumber).connectionInited;
}

/** Marks the slot inited when the declaration it was sent under is still the current one. */
export function markConnectionInited(accountNumber: ActiveAccountNumber, generation: number): void {
  const credentials = credentialsFor(accountNumber);
  if(credentials.declarationGeneration === generation) {
    credentials.connectionInited = true;
  }
}

/** Forgets that the server holds this slot's declaration: on logout, on a new session, on CONNECTION_NOT_INITED. */
export function resetConnectionInited(accountNumber: ActiveAccountNumber): void {
  const credentials = credentialsFor(accountNumber);
  credentials.declarationGeneration += 1;
  credentials.connectionInited = false;
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
