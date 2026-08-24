/*
 * Bridge between the TL call surface and the ImpulseM gRPC gateway.
 *
 * Call sites keep using `invokeApi('messages.getDialogs', {...})`; this module
 * turns that into a protobuf request, issues it over gRPC-web, and converts the
 * response back into the plain `{_: 'messages.dialogs', ...}` objects the app
 * already understands. Nothing downstream of invokeApi has to change.
 *
 * Two conversions carry the weight:
 *
 *   TL -> proto   TL params are snake_case plain objects, which already match
 *                 the proto field `name`. Union members are identified by `_`
 *                 (e.g. 'inputPeerUser') and become protobuf-es oneof wrappers.
 *
 *   proto -> TL   protobuf-es exposes fields under `localName` (camelCase), but
 *                 the app expects `name` (snake_case), so the walk is driven by
 *                 the message schema rather than by Object.keys. The `_`
 *                 discriminator is recovered from `$typeName` via the TL schema,
 *                 which is the only authority on where the dot goes
 *                 ('v1.MessagesDialogs' -> 'messages.dialogs', not 'messagesDialogs').
 */

import type {DescField, DescMessage, DescService} from '@bufbuild/protobuf';
import {create} from '@bufbuild/protobuf';
import {Code, ConnectError, createClient} from '@connectrpc/connect';

import Schema from '@lib/mtproto/schema';
import {getLogger} from '@lib/impulseLogger';
import {captureImpulseSessionToken} from '../session';
import {getServiceAndMethod} from './serviceMap';
import {grpcTransport} from './transport';

const logger = getLogger('grpc-adapter');

type GrpcClientMethod = (...args: any[]) => any;

const clientCache = new Map<string, Record<string, GrpcClientMethod>>();

function getOrCreateClient(service: DescService): Record<string, GrpcClientMethod> {
  let cached = clientCache.get(service.typeName);
  if(!cached) {
    cached = createClient(service, grpcTransport) as any;
    clientCache.set(service.typeName, cached);
  }

  return cached;
}

// ── `_` discriminator recovery ─────────────────────────────────────────────
// Proto flattens the TL namespace into the type name (messages.dialogs ->
// MessagesDialogs), so the dot cannot be re-derived by string surgery alone —
// 'PeerUser' is 'peerUser', not 'peer.user'. The TL schema knows every real
// predicate, so we index it by its dotless, case-folded form and look up.
const PREDICATE_BY_NORMALIZED = new Map<string, string>();

for(const constructor of Schema.API.constructors) {
  const predicate = constructor.predicate;
  if(predicate) {
    PREDICATE_BY_NORMALIZED.set(normalizeName(predicate), predicate);
  }
}

function normalizeName(value: string): string {
  return value.replace(/[._]/g, '').toLowerCase();
}

/** 'v1.MessagesDialogs' -> 'messages.dialogs'; undefined when TL has no such type. */
function predicateForTypeName(typeName: string): string | undefined {
  const bare = typeName.slice(typeName.lastIndexOf('.') + 1);
  const direct = PREDICATE_BY_NORMALIZED.get(normalizeName(bare));
  if(direct) {
    return direct;
  }

  // The proto generator suffixes oneof members with `Value` to dodge name
  // collisions (AuthAuthorizationValue -> auth.authorization). TL has no such
  // suffix, so retry without it.
  if(bare.endsWith('Value')) {
    return PREDICATE_BY_NORMALIZED.get(normalizeName(bare.slice(0, -'Value'.length)));
  }

  return undefined;
}

// ── flag-conditional vectors ───────────────────────────────────────────────
// protobuf cannot say "absent" about a `repeated` field: protobuf-es hands back
// `[]` both for a vector the sender never wrote and for one it deliberately
// emptied. TL draws exactly that distinction with a flag bit
// (`photo#... video_sizes:flags.1?Vector<VideoSize>`), and readers downstream
// test the field for PRESENCE, not for length. An empty array is truthy, so
// without this every still photo would announce itself as a video.
//
// The map is derived from the TL schema rather than hand-listed, because this is
// not a Photo problem — it is every flag-conditional vector in canon.
const CONDITIONAL_VECTOR_PATTERN = /^flags\d*\.\d+\?Vector</i;

let conditionalVectorsByPredicate: Map<string, Set<string>> | undefined;

function getConditionalVectors(predicate: string): Set<string> | undefined {
  if(!conditionalVectorsByPredicate) {
    const built = new Map<string, Set<string>>();
    for(const constructor of Schema.API.constructors) {
      const conditional = new Set<string>();
      for(const param of constructor.params || []) {
        if(CONDITIONAL_VECTOR_PATTERN.test(param.type)) {
          conditional.add(param.name);
        }
      }

      if(conditional.size) {
        built.set(constructor.predicate, conditional);
      }
    }

    conditionalVectorsByPredicate = built;
  }

  return conditionalVectorsByPredicate.get(predicate);
}

/** Drop the empty vectors TL would not have put on the wire at all. */
function omitAbsentConditionalVectors(predicate: string, plain: Record<string, any>): void {
  const conditional = getConditionalVectors(predicate);
  if(!conditional) {
    return;
  }

  for(const key of conditional) {
    const value = plain[key];
    if(Array.isArray(value) && !value.length) {
      delete plain[key];
    }
  }
}

// ── TL -> proto ────────────────────────────────────────────────────────────

function buildProtoInit(tlValue: any, schema: DescMessage): any {
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

    if(raw === undefined || raw === null) {
      continue;
    }

    init[field.localName] = convertFieldValue(raw, field);
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
        value: variant.message ? buildProtoInit(tlValue, variant.message) : {}
      };
      break;
    }
  }

  return init;
}

function convertFieldValue(raw: any, field: DescField): any {
  if(raw instanceof Uint8Array) {
    return raw;
  }

  if(Array.isArray(raw)) {
    if(field.fieldKind === 'list' && (field as any).listKind === 'message' && field.message) {
      return raw.map((item) => buildProtoInit(item, field.message));
    }

    return raw;
  }

  if(field.fieldKind === 'message' && field.message) {
    return buildProtoInit(raw, field.message);
  }

  return raw;
}

// ── proto -> TL ────────────────────────────────────────────────────────────

export function protoToTL(value: any, schema?: DescMessage): any {
  if(value === null || value === undefined) {
    return value;
  }

  if(value instanceof Uint8Array) {
    return value;
  }

  const type = typeof value;
  if(type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return value;
  }

  if(Array.isArray(value)) {
    return value.map((item) => protoToTL(item, schema));
  }

  // A successful empty BoolResponse stands for TL `boolTrue`; a false outcome
  // arrives as an error, never as this message.
  if(value.$typeName === 'v1.BoolResponse') {
    return true;
  }

  // Without a schema we cannot restore snake_case names, so fall back to the
  // raw protobuf shape rather than silently emitting camelCase TL.
  if(!schema) {
    return value;
  }

  const out: Record<string, any> = {};
  const predicate = value.$typeName ? predicateForTypeName(value.$typeName) : undefined;
  if(predicate) {
    out._ = predicate;
  }

  let oneofValue: any;
  let hasOwnFields = false;

  for(const field of schema.fields) {
    if(field.oneof !== undefined) {
      continue;
    }

    const raw = value[field.localName];
    if(raw === undefined) {
      continue;
    }

    hasOwnFields = true;
    out[field.name] = protoToTL(raw, field.message);
  }

  for(const oneof of schema.oneofs) {
    const wrapper = value[oneof.localName];
    if(!wrapper || !wrapper.case) {
      continue;
    }

    const variant = oneof.fields.find((f) => f.localName === wrapper.case);
    oneofValue = protoToTL(wrapper.value, variant?.message);
  }

  // A message that is nothing but a union wrapper collapses to the member, which
  // is how TL models it (`InputPeer` IS `inputPeerUser`).
  if(oneofValue !== undefined && !hasOwnFields && !predicate) {
    return oneofValue;
  }

  if(oneofValue !== undefined) {
    Object.assign(out, oneofValue && typeof oneofValue === 'object' && !Array.isArray(oneofValue) ? oneofValue : {value: oneofValue});
  }

  if(predicate) {
    omitAbsentConditionalVectors(predicate, out);
  }

  return out;
}

// ── errors ─────────────────────────────────────────────────────────────────

/**
 * The gateway sends the canonical catalog code in the `error-code` trailer
 * (see ImpulseM.Common/Extensions/ErrorOrGrpcExtensions.cs). The numeric TL
 * code is NOT on the wire, so it is reconstructed here: the gRPC status narrows
 * it, and the code string disambiguates the pairs that share a status
 * (FailedPrecondition covers both 303 and 406).
 *
 * Keeping the catalog string as `error.type` is what lets the existing handlers
 * (FLOOD_WAIT_n, PHONE_MIGRATE_n, SESSION_PASSWORD_NEEDED, ...) keep working
 * untouched.
 */
function toApiError(err: unknown): ApiError {
  const connectError = ConnectError.from(err);
  const trailerCode = connectError.metadata.get('error-code') || undefined;
  const type = (trailerCode || connectError.rawMessage || 'ERROR_EMPTY') as ErrorType;
  const description = connectError.metadata.get('error-description') || undefined;
  const migrateDc = connectError.metadata.get('migrate-dc');

  const error: ApiError = {
    type,
    code: resolveNumericCode(connectError.code, type as string, Boolean(migrateDc)),
    originalError: err
  };

  if(description) {
    error.message = description;
  }

  return error;
}

const MIGRATE_PATTERN = /^(PHONE_MIGRATE_|NETWORK_MIGRATE_|USER_MIGRATE_|STATS_MIGRATE_)\d+/;
const FLOOD_PATTERN = /^(FLOOD_WAIT_|FLOOD_PREMIUM_WAIT_|SLOWMODE_WAIT_)/;

function resolveNumericCode(status: Code, type: string, hasMigrateDc: boolean): number {
  if(hasMigrateDc || MIGRATE_PATTERN.test(type)) {
    return 303;
  }

  switch(status) {
    case Code.Unauthenticated: return 401;
    case Code.PermissionDenied: return 403;
    case Code.ResourceExhausted: return FLOOD_PATTERN.test(type) ? 420 : 429;
    case Code.FailedPrecondition: return 406;
    case Code.Unimplemented: return 501;
    case Code.Unavailable: return 503;
    case Code.InvalidArgument:
    case Code.NotFound:
    case Code.AlreadyExists:
    case Code.OutOfRange: return 400;
    default: return 500;
  }
}

// ── entry points ───────────────────────────────────────────────────────────

/** Whether the gateway can serve this TL method over gRPC. */
export function isGrpcAvailable(method: string): boolean {
  return Boolean(method) && getServiceAndMethod(method) !== undefined;
}

export async function grpcInvoke(method: string, params: any = {}, abortSignal?: AbortSignal): Promise<any> {
  const mapping = getServiceAndMethod(method);
  if(!mapping) {
    throw {type: 'GRPC_METHOD_UNMAPPED', message: `No gRPC mapping for ${method}`, code: 501} as ApiError;
  }

  const {service, method: descMethod} = mapping;
  const client = getOrCreateClient(service);
  const methodFn = client[descMethod.localName];
  if(typeof methodFn !== 'function') {
    throw {type: 'GRPC_METHOD_MISSING', message: `${descMethod.localName} absent on client`, code: 501} as ApiError;
  }

  const request = create(descMethod.input, buildProtoInit(params, descMethod.input));

  try {
    const response = await methodFn.call(client, request, {signal: abortSignal});
    const result = protoToTL(response, descMethod.output);
    captureImpulseSessionToken(result);
    return result;
  } catch(err) {
    const apiError = toApiError(err);
    logger.debug('gRPC invocation failed', {
      method,
      service: service.typeName,
      errorType: apiError.type,
      errorCode: apiError.code
    }, err);
    throw apiError;
  }
}
