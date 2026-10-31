import type {ApiManager} from '@appManagers/apiManager';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {registerSessionIdentitySource} from './fleetIdentitySource';

/** An ApiManager of the real prototype, carrying only the collaborators the test reaches. */
export async function apiManagerStub<T extends object>(fields: T): Promise<ApiManager & T> {
  const {ApiManager: ApiManagerClass} = await import('@appManagers/apiManager');
  return Object.assign(Object.create(ApiManagerClass.prototype), fields);
}

const SDK_REJECTION_CODE: number = 100;

/** The rejection a responder throws for a server answer: the shape the fleet maps to an ApiError. */
export function serverError(appCode: number, appType: string, metadata?: Record<string, string>): object {
  return {code: SDK_REJECTION_CODE, message: appType, appCode, appType, metadata};
}

export async function prepareFleetAccount(accountNumber: ActiveAccountNumber, config: FleetConfig): Promise<void> {
  const {stopImpulseRealtime} = await import('@lib/impulse/realtime');
  stopImpulseRealtime(accountNumber);
  await registerSessionIdentitySource();
  const {restoreImpulseSession} = await import('@lib/impulse/session');
  await restoreImpulseSession(accountNumber);
  const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
  setFleetConfig(accountNumber, config);
}
