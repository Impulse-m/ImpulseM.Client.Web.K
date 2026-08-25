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
import {captureImpulseSessionToken, refreshImpulseSession} from '../session';
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

// ── flag booleans ──────────────────────────────────────────────────────────
// A TL `flags.N?true` param is not a field at all: the deserialiser puts it in
// `pFlags` and only when the bit is set (see TLDeserialization#fetchObject), so
// the whole app reads `user.pFlags.bot`, `message.pFlags.out`,
// `chat.pFlags.creator` and never the object root. Proto has no bit field, so
// the generator flattens each one into a top-level `optional bool`. Left as
// they arrive, `pFlags` stays empty forever and every one of those checks
// silently reads undefined — no message is ever outgoing, no user is ever
// deleted or a bot, no chat ever has a creator.
const FLAG_BOOL_PATTERN = /^flags\d*\.\d+\?true$/i;

type PredicateInfo = {
  /** `flags.N?Vector<...>` — absent and empty are different things in TL. */
  conditionalVectors: Set<string>,
  /** `flags.N?true` — belongs in `pFlags`, not on the object. */
  boolFlags: Set<string>,
  /** The `#` params themselves, which TL keeps out of the result entirely. */
  flagWords: Set<string>
};

let predicateInfoByName: Map<string, PredicateInfo> | undefined;

/** Everything the TL schema knows about how a predicate's params must be placed. */
function getPredicateInfo(predicate: string): PredicateInfo | undefined {
  if(!predicateInfoByName) {
    const built = new Map<string, PredicateInfo>();
    for(const constructor of Schema.API.constructors) {
      const conditionalVectors = new Set<string>();
      const boolFlags = new Set<string>();
      const flagWords = new Set<string>();

      for(const param of constructor.params || []) {
        if(param.type === '#') {
          flagWords.add(param.name);
        } else if(FLAG_BOOL_PATTERN.test(param.type)) {
          boolFlags.add(param.name);
        } else if(CONDITIONAL_VECTOR_PATTERN.test(param.type)) {
          conditionalVectors.add(param.name);
        }
      }

      if(conditionalVectors.size || boolFlags.size || flagWords.size) {
        built.set(constructor.predicate, {conditionalVectors, boolFlags, flagWords});
      }
    }

    predicateInfoByName = built;
  }

  return predicateInfoByName.get(predicate);
}

/** Drop the empty vectors TL would not have put on the wire at all. */
function omitAbsentConditionalVectors(predicate: string, plain: Record<string, any>): void {
  const conditional = getPredicateInfo(predicate)?.conditionalVectors;
  if(!conditional || !conditional.size) {
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

// protobuf-es represents every int64/uint64/fixed64 as a JS bigint, but TL
// `long` reaches the app as a number when it fits into a safe integer and as a
// decimal string when it does not -- see TLDeserialization#fetchLong, which is
// the contract the whole app was written against (`type Long = string | number`).
//
// A bigint that leaks past this point poisons everything it touches: the peerId
// helpers are installed on Number.prototype and String.prototype only, so
// `user.id.toPeerId()` throws; `bigint === number` is always false, so every
// cache lookup silently misses; JSON.stringify throws outright on a bigint; and
// mixing one into arithmetic throws as well. Every response and every realtime
// update passes through protoToTL, so normalising here keeps all of that away
// from the app.
const MAX_SAFE_LONG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_LONG = -MAX_SAFE_LONG;

function longToTL(value: bigint): number | string {
  if(value <= MAX_SAFE_LONG && value >= MIN_SAFE_LONG) {
    return Number(value);
  }

  return value.toString(10);
}


export function protoToTL(value: any, schema?: DescMessage): any {
  if(value === null || value === undefined) {
    return value;
  }

  if(value instanceof Uint8Array) {
    return value;
  }

  const type = typeof value;
  if(type === 'bigint') {
    return longToTL(value as bigint);
  }

  if(type === 'string' || type === 'number' || type === 'boolean') {
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

  const info = predicate ? getPredicateInfo(predicate) : undefined;

  // TL creates `pFlags` off the `#` param, so a constructor that has one always
  // carries the bag even when no bit is set — code does `user.pFlags.bot`
  // unguarded and would throw on a missing bag.
  if(info?.flagWords.size) {
    out.pFlags = {};
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

    // The flags word is bookkeeping for the wire format; TL never puts it on
    // the result, and downstream would mistake it for a real field.
    if(info?.flagWords.has(field.name)) {
      continue;
    }

    if(info?.boolFlags.has(field.name)) {
      // Only a set bit is recorded. TL cannot express `false` here — the param
      // is simply absent — and readers test for truthiness or for presence.
      if(raw === true) {
        (out.pFlags ??= {})[field.name] = true;
      }

      continue;
    }

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

export async function grpcInvoke(
  method: string,
  params: any = {},
  abortSignal?: AbortSignal,
  isRetry = false
): Promise<any> {
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

    // The access token expires after AccessTokenExpiryMinutes and every call then
    // comes back AUTH_KEY_UNREGISTERED. Renew once with the refresh token and
    // replay, rather than dropping a signed-in user onto the login screen.
    if(apiError.type === 'AUTH_KEY_UNREGISTERED' && !isRetry && await refreshImpulseSession()) {
      logger.info('Retrying after session refresh', {method});
      return grpcInvoke(method, params, abortSignal, true);
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
