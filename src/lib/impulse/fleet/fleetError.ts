import type {Error as CentrifugeError} from '@impulsem/centrifuge/build/protobuf';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import {ERROR_TYPE_IDENTIFIERS, ERROR_TYPE_PATTERNS} from '@/canonErrorIdentifiers';
import {AUTH_TOKEN_INVALID_CODE, METHOD_INVALID_CODE, TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';

/** A fleet call's rejection as the SDK pool reports it. */
export type FleetRpcError = CentrifugeError;

const TRANSPORT_ERROR_TYPE: ErrorType = 'NETWORK_BAD_RESPONSE';
const UNKNOWN_ERROR_TYPE: ErrorType = 'UNKNOWN';
// A catalog pattern with a printf number (FLOOD_WAIT_%d) matches any digits in its place.
const PRINTF_NUMBER: string = '%d';
const CATALOG_IDENTIFIERS: ReadonlySet<string> = new Set<string>(ERROR_TYPE_IDENTIFIERS);
const CATALOG_TEMPLATES: RegExp[] = ERROR_TYPE_PATTERNS
  .map((pattern: string): RegExp => new RegExp(`^${pattern.split(PRINTF_NUMBER).join('\\d+')}$`));
// The numeric code of the registry's temporary INTERNAL_SERVER_ERROR (deploy/centrifugo/media/config.json).
const TRANSPORT_ERROR_CODE: number = 500;
const MIGRATE_CODE: number = 303;
// The canon httpCode of AUTH_TOKEN_EXPIRED, AUTH_TOKEN_INVALID and METHOD_INVALID (src/scripts/in/errors.json).
const REFUSAL_CODE: number = 400;
const REFUSAL_TYPE_BY_CODE: ReadonlyMap<number, ErrorType> = new Map<number, ErrorType>([
  [TOKEN_EXPIRED_CODE, 'AUTH_TOKEN_EXPIRED'],
  [AUTH_TOKEN_INVALID_CODE, 'AUTH_TOKEN_INVALID'],
  [METHOD_INVALID_CODE, 'METHOD_INVALID']
]);

const DESCRIPTION_METADATA: string = 'error-description';
const MIGRATE_DC_METADATA: string = 'migrate-dc';

export function apiErrorOf(type: ErrorType, numericCode: number, originalError: unknown, description?: string): ApiError {
  const error: ApiError = {type, code: numericCode, originalError};
  if(description) {
    error.message = description;
  }

  return error;
}

/** Whether a rejection carries a numeric code, the shape every fleet and socket rejection has. */
export function isFleetRpcError(err: unknown): err is FleetRpcError {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number';
}

/** An SDK ErrorContext carries a category, not a numeric code, so it is not an ApiError. */
export function isApiError(err: unknown): err is ApiError {
  return typeof err === 'object' && err !== null
    && 'type' in err && typeof err.type === 'string'
    && 'code' in err && typeof err.code === 'number';
}

function isCatalogType(appType: string): appType is ErrorType {
  return CATALOG_IDENTIFIERS.has(appType) || CATALOG_TEMPLATES.some((template: RegExp): boolean => template.test(appType));
}

/** The one mapper of a rejection of any carrier, whichever fleet and method it came from. */
export function fleetApiError(error: FleetRpcError): ApiError {
  if(error.code === errorCodes.cancelled) {
    return apiErrorOf('CANCELED', error.code, error);
  }

  if(error.appType !== undefined && error.appCode !== undefined) {
    const code: number = error.metadata?.[MIGRATE_DC_METADATA] === undefined ? error.appCode : MIGRATE_CODE;
    const type: ErrorType = isCatalogType(error.appType) ? error.appType : UNKNOWN_ERROR_TYPE;
    return apiErrorOf(type, code, error, error.metadata?.[DESCRIPTION_METADATA]);
  }

  const refusal: ErrorType | undefined = REFUSAL_TYPE_BY_CODE.get(error.code);
  if(refusal !== undefined) {
    return apiErrorOf(refusal, REFUSAL_CODE, error);
  }

  return transportApiError(error);
}

/** A reply that is not an application answer: no reply body, or a fault of the pool or of the connection. */
export function transportApiError(originalError: unknown): ApiError {
  return apiErrorOf(TRANSPORT_ERROR_TYPE, TRANSPORT_ERROR_CODE, originalError);
}

/** The data of a reply. A reply without it is a fault of the carrier, never an empty answer. */
export function replyDataOf(reply: {data?: Uint8Array}): Uint8Array {
  if(reply.data === undefined) {
    throw transportApiError(reply);
  }

  return reply.data;
}
