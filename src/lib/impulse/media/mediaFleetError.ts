import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {apiErrorOf} from '@lib/impulse/grpc/apiError';


export type MediaFleetRpcError = {
  code: number,
  message?: string,
  appCode?: number,
  appType?: string
};

// Client-side failures of the connection, the call's deadline and the pool's teardown: no answer of the fleet
// exists, and the four methods are idempotent in the registry, so the gateway may carry the same call.
const FALLBACK_CLIENT_CODES: ReadonlySet<number> = new Set<number>([
  errorCodes.timeout,
  errorCodes.transportClosed,
  errorCodes.clientDisconnected,
  errorCodes.clientClosed,
  errorCodes.transportWriteError,
  errorCodes.connectionClosed
]);

const TRANSPORT_ERROR_TYPE: ErrorType = 'NETWORK_BAD_RESPONSE';
// The numeric code of the registry's temporary INTERNAL_SERVER_ERROR (deploy/centrifugo/media/config.json).
const TRANSPORT_ERROR_CODE: number = 500;

export function isMediaFleetFallback(error: MediaFleetRpcError): boolean {
  return FALLBACK_CLIENT_CODES.has(error.code);
}

/** The registry's application error as the gRPC path maps one; a fleet error that names no application type is a transport error. */
export function mediaFleetApiError(error: MediaFleetRpcError): ApiError {
  if(error.appType === undefined || error.appCode === undefined) {
    return transportApiError(error);
  }

  return apiErrorOf(error.appType as ErrorType, error.appCode, error);
}

/** A fleet answer that is not an application answer: no reply body, or an error without a catalog type. */
export function transportApiError(originalError: unknown): ApiError {
  return apiErrorOf(TRANSPORT_ERROR_TYPE, TRANSPORT_ERROR_CODE, originalError);
}
