import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {describe, expect, it, vi} from 'vitest';

import {ApiFileManager} from '@appManagers/apiFileManager';
import {buildProtoInit} from '@lib/impulse/grpc/adapter';
import {InputDocumentFileLocationSchema} from '@lib/impulse/grpc/gen/v1/types_pb';


// The proven live bug: a pending round-video document keeps the fractional temp
// mid minted by generateTempMessageId ("2578.0001"), and when the just-finalized
// sender bubble re-requested its media, that id travelled all the way into
// InputDocumentFileLocation.id, where protobuf-es threw
// `cannot encode field v1.InputDocumentFileLocation.id to binary: invalid BigInt syntax`
// and the sender's round note spun forever. These tests pin the wire guard: a
// non-server-shaped id must be refused BEFORE the transport/serializer.
const fractionalTempIdString = '2578.0001';
const fractionalTempIdNumber = 2578.0001;
const realServerIdString = '341952722011750787';
const safeIntegerServerId = 2578;

function makeUploadFile(): any {
  return {
    _: 'upload.file',
    type: {_: 'storage.fileUnknown'},
    mtime: 0,
    bytes: new Uint8Array([1, 2, 3, 4])
  };
}

function makeInvokeApiSpy(result: any) {
  return vi.fn((method: string, params: any, options?: any) => Promise.resolve(result));
}

function makeManager(invokeApi: ReturnType<typeof makeInvokeApiSpy>): ApiFileManager {
  // Same construction seam as apiFileManagerObjectUrls.test.ts: a prototype
  // instance with only the state requestFilePart's path actually touches.
  const manager = Object.create(ApiFileManager.prototype) as ApiFileManager;
  (manager as any).apiManager = {invokeApi};
  (manager as any).downloadPulls = {};
  (manager as any).downloadActives = {};
  (manager as any).requestFilePartReferences = new Map();
  (manager as any).refreshReferencePromises = {};
  (manager as any).rootScope = {premium: false};
  (manager as any).queueId = 0;
  (manager as any).log = Object.assign(
    () => {},
    {error: () => {}, warn: () => {}, debug: () => {}}
  );
  return manager;
}

function makeDocumentLocation(id: string | number): any {
  return {
    _: 'inputDocumentFileLocation',
    id,
    access_hash: '7331',
    thumb_size: ''
  };
}

function requestPart(manager: ApiFileManager, id: string | number) {
  return manager.requestFilePart({
    dcId: 2,
    location: makeDocumentLocation(id),
    offset: 0,
    limit: 128 * 1024
  });
}


describe('media download server-id wire guard', () => {
  it('refuses the fractional temp id string before the transport is invoked', async() => {
    const invokeApi = makeInvokeApiSpy(makeUploadFile());
    const manager = makeManager(invokeApi);

    await expect(
      requestPart(manager, fractionalTempIdString),
      'a document id like "2578.0001" is a client-local temp id of a still-pending message; letting the download proceed means the serializer throws on BigInt("2578.0001"), the request never leaves, and the sender\'s just-sent round note spins forever — it must be refused up front as MEDIA_ID_PENDING with code 400'
    ).rejects.toMatchObject({type: 'MEDIA_ID_PENDING', code: 400});

    expect(
      invokeApi,
      'the temp id reached the transport: this is the exact live failure — upload.getFile was built with id "2578.0001" and protobuf-es threw "invalid BigInt syntax" mid-serialization, stranding the media element in waitingDocumentsForLoad and the sender behind an eternal spinner'
    ).not.toHaveBeenCalled();
  });

  it('refuses the fractional temp id number before the transport is invoked', async() => {
    const invokeApi = makeInvokeApiSpy(makeUploadFile());
    const manager = makeManager(invokeApi);

    await expect(
      requestPart(manager, fractionalTempIdNumber),
      'a numeric fractional id (2578.0001) is the same pending temp id before its .toString(); the adapter would Math.trunc it into 2578 — a DIFFERENT document — so downloading a silently wrong file instead of crashing; it must be refused up front as MEDIA_ID_PENDING with code 400'
    ).rejects.toMatchObject({type: 'MEDIA_ID_PENDING', code: 400});

    expect(
      invokeApi,
      'the fractional numeric id reached the transport: Math.trunc in the adapter would rewrite it to a different document id and the client would fetch someone else\'s bytes for the sender\'s round note'
    ).not.toHaveBeenCalled();
  });

  it('lets a real 64-bit decimal string id through to the transport untouched', async() => {
    const file = makeUploadFile();
    const invokeApi = makeInvokeApiSpy(file);
    const manager = makeManager(invokeApi);

    await expect(
      requestPart(manager, realServerIdString),
      'a plain decimal 64-bit id is a legitimate server document id; an over-strict guard that rejects it breaks every media download in the app'
    ).resolves.toBe(file);

    expect(
      invokeApi,
      'a valid server id must reach upload.getFile exactly once; swallowing it means no media ever downloads'
    ).toHaveBeenCalledTimes(1);

    const [method, params] = invokeApi.mock.calls[0];
    expect(
      method,
      'the guard must not reroute valid downloads away from upload.getFile'
    ).toBe('upload.getFile');
    expect(
      params.location.id,
      'the guard must pass a valid server id through unmodified; rewriting it downloads the wrong document'
    ).toBe(realServerIdString);
  });

  it('lets a safe-integer numeric id through to the transport', async() => {
    const file = makeUploadFile();
    const invokeApi = makeInvokeApiSpy(file);
    const manager = makeManager(invokeApi);

    await expect(
      requestPart(manager, safeIntegerServerId),
      'longToTL hands ids that fit into a safe integer to the app as plain numbers, so an integer numeric id is a legitimate server id; rejecting it breaks downloads of every document whose id fits below 2^53'
    ).resolves.toBe(file);

    expect(
      invokeApi,
      'an integer numeric server id must reach the transport; only the FRACTIONAL shape marks a pending temp id'
    ).toHaveBeenCalledTimes(1);
  });
});


describe('gRPC adapter INT64 string guard', () => {
  it('rejects a non-decimal string at conversion time with an error naming the field', () => {
    // Today convertFieldValue (src/lib/impulse/grpc/adapter.ts) Math.truncs
    // fractional NUMBERS for INT64 fields but passes STRINGS through untouched,
    // so "2578.0001" detonates later, deep inside protobuf-es serialization, as
    // a bare BigInt SyntaxError. The adapter is the last honest boundary that
    // still knows the TL value and the target field: it must throw its own
    // typed, field-naming error here, before the encoder ever sees the value.
    let thrown: unknown;
    try {
      buildProtoInit(
        {id: fractionalTempIdString, access_hash: '7331', thumb_size: ''},
        InputDocumentFileLocationSchema
      );
    } catch(error) {
      thrown = error;
    }

    expect(
      thrown,
      'buildProtoInit let the non-decimal string "2578.0001" through to protobuf-es: the encode then dies mid-request with "invalid BigInt syntax", the download rejects opaquely, and the sender\'s just-sent round note spins forever'
    ).toBeDefined();
    expect(
      thrown,
      'the adapter must raise its own descriptive error, not leak the JS engine\'s bare BigInt SyntaxError that names neither the field nor the request being built'
    ).not.toBeInstanceOf(SyntaxError);

    const text = String((thrown as any)?.message ?? thrown);
    expect(
      text,
      'the error must name the offending field so the next such leak is diagnosable from a single log line instead of a cross-browser BigInt message'
    ).toMatch(/\bid\b/);
    expect(
      text,
      'the error must include the offending value so the log immediately shows it was a fractional temp id of a pending message'
    ).toContain(fractionalTempIdString);
  });

  it('keeps encoding a real 64-bit decimal string id', () => {
    const init = buildProtoInit(
      {id: realServerIdString, access_hash: '7331', thumb_size: ''},
      InputDocumentFileLocationSchema
    );
    const message = create(InputDocumentFileLocationSchema, init);
    const bytes = toBinary(InputDocumentFileLocationSchema, message);
    const decoded = fromBinary(InputDocumentFileLocationSchema, bytes);

    expect(
      decoded.id,
      'a plain decimal 64-bit id must keep round-tripping through the adapter and the encoder; an over-strict string guard here would break every media request in the app'
    ).toBe(BigInt(realServerIdString));
  });
});
