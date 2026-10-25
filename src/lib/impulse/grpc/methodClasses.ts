import type {FleetIdentity} from '@lib/impulse/fleet/fleet';
import {apiErrorOf} from '@lib/impulse/fleet/fleetError';
import {CONNECTION_IDENTITY_METHOD, INIT_CONNECTION_METHOD, REFRESH_SESSION_METHOD} from '@lib/impulse/fleet/fleetRoute';
import {getLogger} from '@lib/impulseLogger';

export const LoginOnlyMethods: ReadonlySet<string> = new Set([
  'auth.sendCode', 'auth.cancelCode', 'auth.signIn', 'auth.signUp', 'auth.requestFirebaseSms',
  'auth.resetLoginEmail', 'auth.reportMissingCode', 'auth.checkPaidAuth', 'auth.importAuthorization',
  'auth.importBotAuthorization', 'auth.importWebTokenAuthorization', 'auth.exportLoginToken', 'auth.importLoginToken',
  'auth.initPasskeyLogin', 'auth.finishPasskeyLogin'
]);

export const DualUseMethods: ReadonlySet<string> = new Set([
  'auth.resendCode', 'account.sendVerifyEmailCode', 'account.verifyEmail'
]);

export const PendingMethods: ReadonlySet<string> = new Set([
  'auth.checkPassword', 'auth.requestPasswordRecovery', 'auth.recoverPassword',
  'auth.checkRecoveryPassword', 'account.getPassword'
]);

export const PublicMethods: ReadonlySet<string> = new Set([
  'help.getConfig', 'help.getAppConfig', 'help.getNearestDc', 'help.getCountriesList',
  'help.getDeepLinkInfo', 'help.saveAppLog', 'langpack.getLangPack', 'langpack.getStrings',
  'langpack.getDifference', 'langpack.getLanguage', 'langpack.getLanguages'
]);

export const IdentitySocketMethods: ReadonlySet<string> = new Set([
  ...LoginOnlyMethods, ...DualUseMethods, ...PendingMethods, ...PublicMethods,
  INIT_CONNECTION_METHOD, CONNECTION_IDENTITY_METHOD, REFRESH_SESSION_METHOD, 'account.deleteAccount'
]);

export const PoolMethods: ReadonlySet<string> = new Set([CONNECTION_IDENTITY_METHOD, REFRESH_SESSION_METHOD]);

const logger = getLogger('impulse-method-guard');

export function checkSocketMethod(options: {kind: FleetIdentity['kind'], method: string}): void {
  const {kind, method} = options;
  const allowed: boolean = kind === 'identity' ? IdentitySocketMethods.has(method) : !LoginOnlyMethods.has(method);
  if(allowed) {
    return;
  }

  refuseMethod(`${kind} socket cannot send ${method}`);
}

export function checkPoolMethod(method: string): void {
  if(PoolMethods.has(method)) {
    return;
  }

  refuseMethod(`pool cannot send ${method}`);
}

function refuseMethod(message: string): never {
  if(import.meta.env.DEV) {
    throw new Error(message);
  }
  logger.warn(message);
  throw apiErrorOf('CLIENT_METHOD_REFUSED', 0, undefined, message);
}
