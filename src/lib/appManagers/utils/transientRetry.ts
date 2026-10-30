import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {getFloodWaitTime} from '@appManagers/utils/getFloodWaitTime';
import pause from '@helpers/schedulers/pause';
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {isApiError, isFleetRpcError} from '@lib/impulse/fleet/fleetError';
import {routesToMediaFleet} from '@lib/impulse/fleet/fleetRoute';
import {CONNECTION_NOT_INITED} from '@lib/impulse/session';

export type RandomSource = () => number;

const MAX_ATTEMPTS: number = 3;
const BACKOFF_BASE_MS: number = 500;
const BACKOFF_GROWTH: number = 2;
const BACKOFF_CAP_MS: number = 8_000;
const FLOOD_WAIT_CAP_MS: number = 60_000;
const MS_PER_SECOND: number = 1_000;
const OVERLOADED_CODE: number = 111;
const TRANSIENT_SDK_CODES: ReadonlySet<number> = new Set<number>([
  errorCodes.timeout,
  errorCodes.transportClosed,
  errorCodes.connectionClosed,
  OVERLOADED_CODE
]);

function carriesTemporaryFlag(original: unknown): boolean {
  return typeof original === 'object' && original !== null && 'temporary' in original && original.temporary === true;
}

export function isTransientError(error: ApiError): boolean {
  if(error.type === CONNECTION_NOT_INITED) {
    return false;
  }

  if(getFloodWaitTime(error).hasWaitTime) {
    return true;
  }

  const original: unknown = error.originalError;
  if(!isFleetRpcError(original) || original.code === TOKEN_EXPIRED_CODE) {
    return false;
  }

  return TRANSIENT_SDK_CODES.has(original.code) || carriesTemporaryFlag(original);
}

export function retryDelayMs(error: ApiError, retryIndex: number, random: RandomSource): number {
  const floodWait: ReturnType<typeof getFloodWaitTime> = getFloodWaitTime(error);
  if(floodWait.hasWaitTime) {
    const waitMs: number = floodWait.waitTime * MS_PER_SECOND;
    return Math.min(FLOOD_WAIT_CAP_MS, waitMs + random() * waitMs);
  }

  const ceilingMs: number = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_GROWTH ** retryIndex);
  return random() * ceilingMs;
}

export async function withTransientRetry<T>(operation: () => Promise<T>, random: RandomSource = Math.random): Promise<T> {
  for(let retryIndex: number = 0; ; retryIndex += 1) {
    try {
      return await operation();
    } catch(error: unknown) {
      if(!isApiError(error) || !isTransientError(error) || retryIndex + 1 >= MAX_ATTEMPTS) {
        throw error;
      }

      await pause(retryDelayMs(error, retryIndex, random));
    }
  }
}

export function invokeWithTransientRetry<T>(method: string, invoke: () => Promise<T>): Promise<T> {
  return routesToMediaFleet(method) ? withTransientRetry(invoke) : invoke();
}
