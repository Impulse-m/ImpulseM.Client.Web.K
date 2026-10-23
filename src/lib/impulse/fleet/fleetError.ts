import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {apiErrorOf} from '@lib/impulse/grpc/apiError';

/** A fleet call's rejection as the pool reports it: a pool or connection code, or a server answer with its application type. */
export type FleetRpcError = {
  code: number,
  message?: string,
  appCode?: number,
  appType?: string,
  metadata?: Record<string, string>
};

const TRANSPORT_ERROR_TYPE: ErrorType = 'NETWORK_BAD_RESPONSE';
// The numeric code of the registry's temporary INTERNAL_SERVER_ERROR (deploy/centrifugo/media/config.json).
const TRANSPORT_ERROR_CODE: number = 500;
const MIGRATE_CODE: number = 303;

const DESCRIPTION_METADATA: string = 'error-description';
const MIGRATE_DC_METADATA: string = 'migrate-dc';
const PENDING_TOKEN_METADATA: string = 'pending-token';

/** The one mapper of a fleet rejection, whichever fleet and method it came from. */
export function fleetApiError(error: FleetRpcError): ApiError {
  if(error.code === errorCodes.cancelled) {
    return {type: 'CANCELED', originalError: error};
  }

  if(error.appType !== undefined && error.appCode !== undefined) {
    const code: number = error.metadata?.[MIGRATE_DC_METADATA] === undefined ? error.appCode : MIGRATE_CODE;
    return apiErrorOf(error.appType as ErrorType, code, error, error.metadata?.[DESCRIPTION_METADATA]);
  }

  return transportApiError(error);
}

/** A reply that is not an application answer: no reply body, or a fault of the pool or of the connection. */
export function transportApiError(originalError: unknown): ApiError {
  return apiErrorOf(TRANSPORT_ERROR_TYPE, TRANSPORT_ERROR_CODE, originalError);
}

/** The pending-2FA token a SESSION_PASSWORD_NEEDED rejection carries, if the error carries one. */
export function pendingTokenOf(apiError: ApiError): string | undefined {
  const original = apiError.originalError as FleetRpcError | undefined;
  return original?.metadata?.[PENDING_TOKEN_METADATA];
}
