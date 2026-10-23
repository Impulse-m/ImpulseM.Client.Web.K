import {errorCodes} from '@impulsem/centrifuge/build/protobuf';


export type MediaFleetRpcError = {
  code: number,
  message?: string,
  temporary?: boolean,
  appCode?: number,
  appType?: string
};

// Centrifugo built-in codes (protos/vendor/centrifugo/v6/client.proto). 100 and 111 are temporary by the proto;
// 109 is renewed by the SDK, and a call the fleet still refuses goes to the gateway.
const INTERNAL_SERVER_ERROR_CODE: number = 100;
const TOKEN_EXPIRED_CODE: number = 109;
const TOO_MANY_REQUESTS_CODE: number = 111;

const FALLBACK_SERVER_CODES: ReadonlySet<number> = new Set<number>([
  INTERNAL_SERVER_ERROR_CODE,
  TOKEN_EXPIRED_CODE,
  TOO_MANY_REQUESTS_CODE
]);

// Client-side failures of the connection, the call's deadline and the pool's wait queue. The four
// methods are idempotent in the registry, so the gateway may run the same call.
const FALLBACK_CLIENT_CODES: ReadonlySet<number> = new Set<number>([
  errorCodes.timeout,
  errorCodes.transportClosed,
  errorCodes.clientDisconnected,
  errorCodes.clientClosed,
  errorCodes.transportWriteError,
  errorCodes.connectionClosed,
  errorCodes.limitExceeded
]);

const UNMAPPED_ERROR_CODE: number = 500;

export function isMediaFleetFallback(error: MediaFleetRpcError): boolean {
  return FALLBACK_CLIENT_CODES.has(error.code) || FALLBACK_SERVER_CODES.has(error.code);
}

export function toMediaFleetApiError(error: MediaFleetRpcError): ApiError {
  return {
    type: (error.appType ?? error.message ?? 'ERROR_EMPTY') as ErrorType,
    code: error.appCode ?? UNMAPPED_ERROR_CODE,
    originalError: error
  };
}
