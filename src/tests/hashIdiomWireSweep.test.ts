import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {describe, expect, it} from 'vitest';

import countHash from '@helpers/long/countHash';
import {buildProtoInit} from '@lib/impulse/grpc/adapter';
import {GetSavedHistoryRequestSchema, GetScheduledHistoryRequestSchema} from '@lib/impulse/grpc/gen/messages_pb';
import {GetSavedMusicRequestSchema} from '@lib/impulse/grpc/gen/users_pb';


/*
 * Sweep over the literal `hash` idioms REAL call-sites pass into invokeApi, fed through the
 * real adapter pipeline (buildProtoInit -> create -> toBinary) against the real generated
 * descriptors — exactly the stages grpcInvoke runs before a request leaves
 * (src/lib/impulse/grpc/adapter.ts).
 *
 * Harvested idioms (issue #92 step 2):
 *   hash: ''          — appMessagesManager.ts:10809, messages.getScheduledHistory (int64 hash)
 *   hash: 0           — src/lib/storages/dialogs.ts:2274, messages.getSavedHistory (int64 hash)
 *   computed decimal  — appSavedMusicManager.ts:62, users.getSavedMusic passes
 *                       countHash(documents.map((doc) => doc.id)) (int64 hash)
 *   fractional junk   — "2578.0001", the pending-message temp id shape whose leak the guard
 *                       from commit 6750d8076 exists to refuse (mediaDownloadServerIdGuard.test.ts)
 *
 * CONTRACT this file is the specification for: on an int64/uint64 field the adapter must
 *   - serialize '' as 0 (upstream tweb idiom; MTProto's storeLong accepted it — the current
 *     guard wrongly throws on it),
 *   - serialize the full unsigned uint64 range countHash emits (its own docstring:
 *     "The result is returned unsigned; storeLong normalizes it before serializing" —
 *     the gRPC adapter replaced storeLong and must normalize the same way),
 *   - keep throwing its own field-naming error on fractional junk ('' is the ONLY non-decimal
 *     string excepted; whitespace, '2578.0001' and friends stay refused before the encoder).
 */
describe('hash idiom wire sweep (issue #92 step 2)', () => {
  const int63Max = (BigInt(1) << BigInt(63)) - BigInt(1);

  // Realistic server document ids (64-bit decimal strings, the shape longToTL hands the app).
  const documentIds = ['341952722011750787', '341952722011750788', '341952722011750789'];

  it('serializes the \'\' idiom of messages.getScheduledHistory as hash 0', () => {
    // The literal params of appMessagesManager.getScheduledMessages (line 10809).
    const params = {peer: {_: 'inputPeerSelf'}, hash: ''};

    let init: unknown;
    expect(
      () => {
        init = buildProtoInit(params, GetScheduledHistoryRequestSchema);
      },
      'hash: \'\' is what the app really sends for messages.getScheduledHistory (appMessagesManager.ts:10809) — ' +
      'the upstream tweb idiom that MTProto storeLong serialized as 0. The int64 guard added in commit ' +
      '6750d8076 throws on it, so opening the scheduled-messages panel dies before the request leaves: ' +
      '\'\' on an int64 field must serialize as 0, and ONLY \'\' — this test is the specification for that ' +
      'guard refinement'
    ).not.toThrow();

    const message = create(GetScheduledHistoryRequestSchema, init as any);
    const decoded = fromBinary(
      GetScheduledHistoryRequestSchema,
      toBinary(GetScheduledHistoryRequestSchema, message)
    );
    expect(
      decoded.hash,
      '\'\' must reach the wire as int64 0 — the \'no cached hash, send me everything\' value — not as any ' +
      'other number, or the server would answer *NotModified against a hash the client never computed'
    ).toBe(BigInt(0));
  });

  it('serializes the hash: 0 idiom of messages.getSavedHistory', () => {
    // The literal params of DialogsStorage (src/lib/storages/dialogs.ts:2271-2279).
    const params = {
      peer: {_: 'inputPeerSelf'},
      add_offset: 0,
      hash: 0,
      limit: 1,
      max_id: 0,
      min_id: 0,
      offset_date: 0,
      offset_id: 0
    };

    const init = buildProtoInit(params, GetSavedHistoryRequestSchema);
    const message = create(GetSavedHistoryRequestSchema, init);
    const decoded = fromBinary(
      GetSavedHistoryRequestSchema,
      toBinary(GetSavedHistoryRequestSchema, message)
    );
    expect(
      decoded.hash,
      'hash: 0 is the most common idiom in the codebase (dialogs.ts, apiManagerMethods.ts, a dozen ' +
      'managers); if the adapter ever refuses it, every saved-messages dialog load breaks'
    ).toBe(BigInt(0));
  });

  it('serializes a computed decimal-string hash that fits int64 (users.getSavedMusic idiom)', () => {
    const computed = countHash(documentIds.slice(0, 2));
    expect(
      computed,
      'fixture self-check: countHash over these two ids must stay the deterministic tdesktop fold — ' +
      'if this changed, countHash itself regressed and the sweep below is measuring the wrong value'
    ).toBe('7106195676574403810');

    // The literal params shape of appSavedMusicManager.getSavedMusic (line 62).
    const params = {
      id: {_: 'inputUser', user_id: '341952722011750787', access_hash: '7331'},
      offset: 0,
      limit: 50,
      hash: computed
    };

    const init = buildProtoInit(params, GetSavedMusicRequestSchema);
    const message = create(GetSavedMusicRequestSchema, init);
    const decoded = fromBinary(
      GetSavedMusicRequestSchema,
      toBinary(GetSavedMusicRequestSchema, message)
    );
    expect(
      decoded.hash,
      'a computed decimal-string hash inside the int64 range must travel unchanged; rewriting it means ' +
      'the server compares against a hash the client never computed and never answers *NotModified'
    ).toBe(BigInt(computed));
  });

  it('serializes the unsigned upper-half hash countHash really emits (storeLong normalization contract)', () => {
    const computed = countHash(documentIds);
    expect(
      computed,
      'fixture self-check: the three-id fold is deterministic; a change here is a countHash regression'
    ).toBe('10591573669464394883');
    expect(
      BigInt(computed) > int63Max,
      'fixture self-check: this fold lands in the unsigned upper half of uint64 — the exact range ' +
      'countHash\'s docstring defers to storeLong for (\'The result is returned unsigned; storeLong ' +
      'normalizes it before serializing\'); if it stopped doing so, pick ids that do'
    ).toBe(true);

    const params = {
      id: {_: 'inputUser', user_id: '341952722011750787', access_hash: '7331'},
      offset: 0,
      limit: 50,
      hash: computed
    };

    let bytes: Uint8Array | undefined;
    expect(
      () => {
        const init = buildProtoInit(params, GetSavedMusicRequestSchema);
        const message = create(GetSavedMusicRequestSchema, init);
        bytes = toBinary(GetSavedMusicRequestSchema, message);
      },
      'countHash returns the fold unsigned and relied on MTProto storeLong to normalize it into a ' +
      'signed int64 before serializing; the gRPC adapter replaced storeLong but does NOT normalize, so ' +
      'protobuf-es throws \'invalid int64\' the first time a user\'s saved-music list hashes into the ' +
      'upper half of uint64 — a 50% coin-toss regression on every *NotModified cache the fold feeds. ' +
      'The adapter must normalize unsigned decimal strings on int64 fields (two\'s complement, ' +
      'BigInt.asIntN(64, value)) exactly as storeLong did'
    ).not.toThrow();

    const decoded = fromBinary(GetSavedMusicRequestSchema, bytes!);
    expect(
      decoded.hash,
      'the wire value must be the two\'s-complement reading of the unsigned fold — the same 64 bits ' +
      'storeLong put on the MTProto wire — or the server-side comparison breaks silently'
    ).toBe(BigInt.asIntN(64, BigInt(computed)));
  });

  it('keeps refusing fractional junk with the adapter\'s own field-naming error', () => {
    let thrown: unknown;
    try {
      buildProtoInit({peer: {_: 'inputPeerSelf'}, hash: '2578.0001'}, GetScheduledHistoryRequestSchema);
    } catch(error) {
      thrown = error;
    }

    expect(
      thrown,
      'the \'\' exception must not widen: \'2578.0001\' is the pending-message temp id shape that once ' +
      'stranded the sender\'s round note behind an eternal spinner (mediaDownloadServerIdGuard.test.ts) ' +
      'and must keep being refused before the encoder'
    ).toBeDefined();
    expect(
      thrown,
      'the refusal must stay the adapter\'s own descriptive error, not the JS engine\'s bare BigInt ' +
      'SyntaxError that names neither field nor request'
    ).not.toBeInstanceOf(SyntaxError);

    const text = String((thrown as any)?.message ?? thrown);
    expect(text, 'the error must name the offending field').toMatch(/\bhash\b/);
    expect(text, 'the error must include the offending value').toContain('2578.0001');
  });

  it('keeps refusing a whitespace-only string — the \'\' exception is exactly the empty string', () => {
    let thrown: unknown;
    try {
      buildProtoInit({peer: {_: 'inputPeerSelf'}, hash: ' '}, GetScheduledHistoryRequestSchema);
    } catch(error) {
      thrown = error;
    }

    expect(
      thrown,
      '\' \' (whitespace) is NOT a call-site idiom anywhere in the codebase; if the guard refinement ' +
      'implements the \'\' exception by trimming or by Number() coercion instead of by an exact ' +
      'raw === \'\' comparison, this leaks — the exception must be precisely the empty string'
    ).toBeDefined();
  });
});
