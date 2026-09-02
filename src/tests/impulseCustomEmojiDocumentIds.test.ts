import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Issue #179. `messages.getCustomEmojiDocuments` left the browser with an `undefined` inside
 * `document_id` and died in the proto serializer ("can't convert undefined to BigInt", 500).
 * Canon: `document_id` is `Vector<long>`; an element that is not a long must never be encoded,
 * and a request with nothing to ask for is not sent at all.
 *
 * Two boundaries carry the contract: the manager (the app's only caller) drops invalid ids and
 * answers an all-invalid request itself, and the gRPC adapter refuses to forward a nullish
 * element of ANY `Vector<long>` -- the mechanical stop for the class, whatever the method.
 */

const transportCall = vi.fn<(request: {documentId: bigint[]}) => Promise<{items: never[]}>>();

vi.mock('@connectrpc/connect', async(importOriginal) => {
  const original = await importOriginal<typeof import('@connectrpc/connect')>();
  return {
    ...original,
    createClient: vi.fn(() => ({
      getCustomEmojiDocuments: transportCall
    }))
  };
});

vi.mock('@lib/impulse/session', () => ({
  captureImpulseSessionToken: vi.fn(() => Promise.resolve()),
  refreshImpulseSession: vi.fn(() => Promise.resolve(false)),
  whenImpulseSessionReady: vi.fn(() => Promise.resolve())
}));


describe('custom emoji document ids at the gRPC boundary', () => {
  beforeEach(() => {
    transportCall.mockReset();
    transportCall.mockResolvedValue({items: []});
  });


  it('drops a nullish Vector<long> element before the request reaches the transport', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke('messages.getCustomEmojiDocuments', {
      document_id: ['341952722011750787', undefined, 2578]
    })).resolves.toEqual([]);

    expect(transportCall, 'the valid ids still travel: dropping the whole request would hide every emoji').toHaveBeenCalledTimes(1);
    expect(transportCall.mock.calls[0][0].documentId).toEqual([
      BigInt('341952722011750787'),
      BigInt(2578)
    ]);
  });


  it('sends valid ids unchanged (positive control)', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke('messages.getCustomEmojiDocuments', {
      document_id: ['341952722011750787', 2578]
    })).resolves.toEqual([]);

    expect(transportCall).toHaveBeenCalledTimes(1);
    expect(transportCall.mock.calls[0][0].documentId).toEqual([
      BigInt('341952722011750787'),
      BigInt(2578)
    ]);
  });
});


describe('AppEmojiManager.getCustomEmojiDocuments', () => {
  it('answers an all-invalid list itself and never calls the API', async() => {
    const {AppEmojiManager} = await import('@lib/appManagers/appEmojiManager');
    const manager = new AppEmojiManager();
    const invokeApi = vi.fn();
    (manager as unknown as {apiManager: {invokeApi: typeof invokeApi}}).apiManager = {invokeApi};

    await expect(manager.getCustomEmojiDocuments([undefined, null] as unknown as DocId[])).resolves.toEqual([]);

    expect(invokeApi, 'an empty Vector<long> request is pointless and must not be sent').not.toHaveBeenCalled();
  });


  it('forwards only the valid ids when the list is mixed', async() => {
    const {AppEmojiManager} = await import('@lib/appManagers/appEmojiManager');
    const manager = new AppEmojiManager();
    const invokeApi = vi.fn(() => Promise.resolve([]));
    (manager as unknown as {apiManager: {invokeApi: typeof invokeApi}}).apiManager = {invokeApi};

    await manager.getCustomEmojiDocuments(['341952722011750787', undefined, 2578] as unknown as DocId[]);

    expect(invokeApi).toHaveBeenCalledTimes(1);
    expect(invokeApi.mock.calls[0]).toEqual([
      'messages.getCustomEmojiDocuments',
      {document_id: ['341952722011750787', 2578]}
    ]);
  });
});
