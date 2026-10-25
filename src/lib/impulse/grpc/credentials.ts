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
  // The session token the server last refused as expired or invalid: the next connection asks for a renewal of it.
  refusedSessionToken: string | undefined,
  declaration: ConnectionDeclarationValues | undefined,
  // Bumped whenever the declared values change or the binding is invalidated, so a handshake that belongs to an older
  // declaration cannot mark the current one as bound.
  declarationGeneration: number,
  // Canon `connectionInited`: true once the server holds the current values for this slot.
  connectionInited: boolean
};

const credentialsByAccount = new Map<ActiveAccountNumber, AccountCredentials>();

if(!IS_WORKER) {
  setLogAuthTokenProvider(() => credentialsFor(getCurrentAccount()).sessionToken);
}

function credentialsFor(accountNumber: ActiveAccountNumber): AccountCredentials {
  let credentials = credentialsByAccount.get(accountNumber);
  if(!credentials) {
    credentials = {
      sessionToken: undefined,
      refusedSessionToken: undefined,
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

/** Records that the server refused this session token. A token that is later replaced is not refused any more. */
export function markGrpcSessionTokenRefused(accountNumber: ActiveAccountNumber, token: string): void {
  credentialsFor(accountNumber).refusedSessionToken = token;
}

/** Whether the server refused the session token this slot holds, and so it must be renewed before it is presented again. */
export function isGrpcSessionTokenRefused(accountNumber: ActiveAccountNumber): boolean {
  const credentials = credentialsFor(accountNumber);
  return credentials.sessionToken !== undefined && credentials.refusedSessionToken === credentials.sessionToken;
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
