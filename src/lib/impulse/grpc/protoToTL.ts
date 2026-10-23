/*
 * The proto -> TL conversion of the carriers: a protobuf-es message back to the plain `{_: 'messages.dialogs', ...}` objects
 * the app reads. It lives apart from the TL -> proto conversion in adapter.ts, because the realtime socket decodes updates
 * with it and the adapter sends calls through the socket: one of the two imports the other otherwise.
 */

import type {DescMessage} from '@bufbuild/protobuf';

import Schema from '@lib/mtproto/schema';

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

export function normalizeName(value: string): string {
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

  if(value.$typeName === 'v1.BoolResponse') {
    if(typeof value.value !== 'boolean') {
      throw new Error('v1.BoolResponse arrived without a value');
    }

    return value.value;
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

  // A TL method returning a bare `Vector<X>` has no proto equivalent, so the
  // generator wraps it in a synthetic message holding a single `items` field --
  // LangPackLanguageList, UserList, PeerList, 44 of them. Callers expect the
  // array itself; `langpack.getLanguages` reaching `.map` is what exposed this.
  // Genuine TL types whose name merely ends in List are untouched: emojiList
  // carries `hash` and `document_id`, so it has more than one field and a
  // predicate of its own.
  if(!predicate && Array.isArray(out.items) && Object.keys(out).length === 1) {
    return out.items;
  }

  return out;
}
