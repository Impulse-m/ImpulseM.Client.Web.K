/*
 * Bridge between the TL call surface and the ImpulseM carriers.
 *
 * Call sites keep using `invokeApi('messages.getDialogs', {...})`; this module turns that into a protobuf request,
 * sends it as an rpc on the update socket (or on the media fleet for the four file-transfer calls), and converts the
 * response back into the plain `{_: 'messages.dialogs', ...}` objects the app already understands (protoToTL.ts). Nothing
 * downstream of invokeApi has to change.
 *
 * TL -> proto: TL params are snake_case plain objects, which already match the proto field `name`. Union members are
 * identified by `_` (e.g. 'inputPeerUser') and become protobuf-es oneof wrappers.
 */

import type {DescField, DescMessage} from '@bufbuild/protobuf';
import {create, fromBinary, ScalarType, toBinary} from '@bufbuild/protobuf';

import {formatJSONValue} from '@lib/mtproto/tl_utils';
import {getLogger} from '@lib/impulseLogger';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {TOKEN_EXPIRED_CODE} from '@lib/impulse/centrifugoCodes';
import {callMediaFleet} from '@lib/impulse/fleet/fleet';
import type {FleetCall} from '@lib/impulse/fleet/fleet';
import {routesToMediaFleet} from '@lib/impulse/fleet/fleetRoute';
import {apiErrorOf, isApiError, isFleetRpcError, pendingTokenOf, transportApiError} from '@lib/impulse/fleet/fleetError';
import {callUpdateSocket} from '@lib/impulse/realtime';
import {
  captureImpulseSessionToken,
  capturePendingToken,
  clearPendingToken,
  CONNECTION_NOT_INITED,
  ensureConnectionDeclared,
  fleetIdentityFor,
  refreshImpulseSession,
  whenImpulseSessionReady
} from '../session';
import {getServiceAndMethod} from './serviceMap';
import {normalizeName, protoToTL} from './protoToTL';
import {
  getGrpcPendingGeneration,
  getGrpcPendingToken,
  resetConnectionInited
} from './credentials';

const logger = getLogger('grpc-adapter');

// ── TL -> proto ────────────────────────────────────────────────────────────

type ProtoConversionContext = {
  method: string
};

export function buildProtoInit(
  tlValue: any,
  schema: DescMessage,
  context?: ProtoConversionContext
): any {
  if(tlValue === null || tlValue === undefined) {
    return {};
  }

  const init: Record<string, any> = {};

  for(const field of schema.fields) {
    // oneof members are not read off the parent; they come from the union
    // member's own `_`, resolved below.
    if(field.oneof !== undefined) {
      continue;
    }

    let raw = tlValue[field.name];
    if(raw === undefined) {
      raw = tlValue[field.localName];
    }

    // TLSerialization#storeBody reads `flags.N?true` params from `obj.pFlags`
    // when the object has one and from the object itself otherwise. Requests are
    // normally built with the flags at the root, but mirror both so an object
    // built the other way round still serialises the same.
    if(raw === undefined && tlValue.pFlags) {
      raw = tlValue.pFlags[field.name];
    }

    if(raw === undefined || raw === null) {
      continue;
    }

    init[field.localName] = convertFieldValue(raw, field, context);
  }

  if(schema.oneofs.length && typeof tlValue._ === 'string') {
    const wanted = normalizeName(tlValue._);
    for(const oneof of schema.oneofs) {
      const variant = oneof.fields.find((f) => normalizeName(f.localName) === wanted);
      if(!variant) {
        continue;
      }

      init[oneof.localName] = {
        case: variant.localName,
        value: variant.message ? buildProtoInit(tlValue, variant.message, context) : {}
      };
      break;
    }
  }

  return init;
}

function convertFieldValue(raw: any, field: DescField, context?: ProtoConversionContext): any {
  const isInt64 = field.fieldKind === 'scalar' && (
    field.scalar === ScalarType.INT64 || field.scalar === ScalarType.UINT64
  );
  if(isInt64 && raw === '') {
    return 0;
  }

  if(isInt64 && (
    (typeof raw === 'string' && !/^-?\d+$/.test(raw)) ||
    (typeof raw === 'number' && !Number.isInteger(raw))
  )) {
    throw new Error(`Invalid integer value for field ${field.name}: ${raw}`);
  }

  if(
    field.fieldKind === 'scalar' &&
    field.scalar === ScalarType.INT64 &&
    typeof raw === 'string' &&
    BigInt(raw) > BigInt('9223372036854775807')
  ) {
    return BigInt.asIntN(64, BigInt(raw)).toString();
  }

  if(typeof raw === 'number' && !Number.isInteger(raw) && field.fieldKind === 'scalar' && (
    field.scalar === ScalarType.INT32 || field.scalar === ScalarType.UINT32
  )) {
    return Math.trunc(raw);
  }

  if(raw instanceof Uint8Array) {
    return raw;
  }

  // protobuf-es only coerces plain arrays for a `bytes` field -- its toU8Arr is
  // `Array.isArray(v) ? new Uint8Array(v) : v` -- so an ArrayBuffer travelled
  // through untouched and the writer, which reads `.length`, found none on it and
  // emitted zero bytes. Every upload part left the client empty and came back
  // FILE_PART_EMPTY. apiFileManager hands us the ArrayBuffer straight from
  // readBlobAsArrayBuffer; wrap it here, at the boundary, so no caller has to
  // remember.
  if(raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }

  if(ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  if(Array.isArray(raw)) {
    if(field.fieldKind === 'list' && field.listKind === 'message' && field.message) {
      return raw.map((item) => buildProtoInit(item, field.message, context));
    }

    if(field.fieldKind === 'list' && field.listKind === 'scalar' && (
      field.scalar === ScalarType.INT64 || field.scalar === ScalarType.UINT64
    )) {
      return raw.map((item, index) => {
        if(item === undefined || item === null) {
          throw new Error(`Invalid ${field.name} list element for ${context?.method ?? 'unknown method'} at index ${index}: ${item}`);
        }

        return BigInt(item);
      });
    }

    return raw;
  }

  if(field.fieldKind === 'message' && field.message) {
    return buildProtoInit(raw, field.message, context);
  }

  return raw;
}

// ── entry points ───────────────────────────────────────────────────────────

/** Whether the carriers can serve this TL method. */
export function isGrpcAvailable(method: string): boolean {
  return Boolean(method) && getServiceAndMethod(method) !== undefined;
}

export async function grpcInvoke(
  method: string,
  params: any = {},
  accountNumber: ActiveAccountNumber,
  abortSignal?: AbortSignal,
  isRetry = false,
  isReinitRetry = false
): Promise<any> {
  const mapping = getServiceAndMethod(method);
  if(!mapping) {
    throw apiErrorOf('GRPC_METHOD_UNMAPPED', 501, {method}, `No gRPC mapping for ${method}`);
  }

  const {service, method: descMethod} = mapping;
  const request = create(descMethod.input, buildProtoInit(params, descMethod.input, {method}));
  const requestBytes: Uint8Array = toBinary(descMethod.input, request);

  // A freshly (re)sent code starts a new login attempt the moment this is called: any pending 2FA challenge of an
  // earlier attempt is stale from this instant.
  const staleChallengeCleared: Promise<void> = method === 'auth.sendCode'
    ? clearPendingToken(accountNumber)
    : Promise.resolve();

  // Snapshotted before the readiness wait, so an invalidation issued right after this call is seen as a change.
  const pendingGenerationAtRequestStart = getGrpcPendingGeneration(accountNumber);
  await staleChallengeCleared;

  // Nothing may leave before the stored session has been put back in place.
  await whenImpulseSessionReady(accountNumber);
  void ensureConnectionDeclared(accountNumber);

  const identity = fleetIdentityFor(accountNumber);
  const pendingTokenAtRequestStart = getGrpcPendingToken(accountNumber);

  try {
    const reply = await carry({accountNumber, method, request: requestBytes, signal: abortSignal});
    const result = protoToTL(fromBinary(descMethod.output, reply), descMethod.output);
    if(method === 'help.getAppConfig' && result?._ === 'help.appConfig') {
      result.config = formatJSONValue(result.config);
    }

    await captureImpulseSessionToken(accountNumber, result);
    return result;
  } catch(err: unknown) {
    const apiError: ApiError = isApiError(err) ? err : transportApiError(err);
    const rawCode: number | undefined = isFleetRpcError(apiError.originalError) ? apiError.originalError.code : undefined;

    if(apiError.type === 'SESSION_PASSWORD_NEEDED') {
      const token = pendingTokenOf(apiError);
      if(token !== undefined && getGrpcPendingGeneration(accountNumber) === pendingGenerationAtRequestStart) {
        await recordStorageFailure(apiError, capturePendingToken(accountNumber, token));
      }
    }

    // The pending token this call presented has been authoritatively rejected: revoked or consumed. Clear it, but only
    // while it is still the current one, so a late rejection cannot clear a newer challenge.
    if(
      identity.kind === 'pending' &&
      apiError.type === 'AUTH_TOKEN_INVALID' &&
      getGrpcPendingToken(accountNumber) === pendingTokenAtRequestStart
    ) {
      await recordStorageFailure(apiError, clearPendingToken(accountNumber));
    }

    // The server asked for the declaration this call did not carry: declare the connection, then replay the call once.
    if(apiError.type === CONNECTION_NOT_INITED && !isReinitRetry) {
      resetConnectionInited(accountNumber);
      await ensureConnectionDeclared(accountNumber);
      logger.info('Retrying with the connection declaration', {method, accountNumber});
      return grpcInvoke(method, params, accountNumber, abortSignal, isRetry, true);
    }

    // The access token was refused as expired: renew it once through the refresh token and replay the call on the update
    // socket, which then connects with the renewed token.
    const tokenExpired: boolean = rawCode === TOKEN_EXPIRED_CODE;
    if(tokenExpired && identity.kind === 'session' && !isRetry && await refreshImpulseSession(accountNumber)) {
      logger.info('Retrying after session refresh', {method, accountNumber});
      return grpcInvoke(method, params, accountNumber, abortSignal, true, isReinitRetry);
    }

    logger.debug('gRPC invocation failed', {
      method,
      service: service.typeName,
      errorType: apiError.type,
      errorCode: apiError.code
    }, err);
    throw apiError;
  }
}

/** The file-transfer calls travel the media fleet; every other call is an rpc on the update socket of its slot. */
function carry(call: FleetCall): Promise<Uint8Array> {
  if(routesToMediaFleet(call.method)) {
    return callMediaFleet(call);
  }

  return callUpdateSocket({
    accountNumber: call.accountNumber,
    method: call.method,
    request: call.request,
    signal: call.signal
  });
}

async function recordStorageFailure(apiError: ApiError, pendingWrite: Promise<void>): Promise<void> {
  try {
    await pendingWrite;
  } catch(storageError: unknown) {
    logger.warn('Failed to write the pending token of a failed call', {type: apiError.type}, storageError);
    apiError.cause = storageError;
  }
}
