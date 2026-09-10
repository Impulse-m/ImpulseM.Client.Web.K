import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Issue #179 / #260. `messages.getCustomEmojiDocuments` left the browser with an `undefined`
 * inside `document_id` and died in the proto serializer ("can't convert undefined to BigInt",
 * 500). The fork's first fix filtered the id out before the request and silently dropped it
 * again at the gRPC adapter's `Vector<long>` encoding -- tolerable while the server answered
 * this method as a lookup, but the server now answers positionally, one `Document` (or
 * `documentEmpty`) per requested id. Silently shortening the vector desyncs every id after the
 * dropped one from its answer.
 *
 * Canon (restored): the manager (the app's only caller) forwards `document_id` exactly as
 * given -- filtering is not its job -- and the gRPC adapter refuses loudly, for a nullish
 * element of ANY `Vector<long>`, whatever the method: a request that would silently lose an
 * element must never reach the transport.
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


  it('refuses a nullish Vector<long> element instead of silently shortening the request', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke('messages.getCustomEmojiDocuments', {
      document_id: ['341952722011750787', undefined, 2578]
    }, 1)).rejects.toThrow('Invalid document_id list element for messages.getCustomEmojiDocuments at index 1: undefined');

    expect(transportCall, 'a request that would desync the positional answer must never reach the transport').not.toHaveBeenCalled();
  });


  it('sends valid ids unchanged (positive control)', async() => {
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await expect(grpcInvoke('messages.getCustomEmojiDocuments', {
      document_id: ['341952722011750787', 2578]
    }, 1)).resolves.toEqual([]);

    expect(transportCall).toHaveBeenCalledTimes(1);
    expect(transportCall.mock.calls[0][0].documentId).toEqual([
      BigInt('341952722011750787'),
      BigInt(2578)
    ]);
  });
});


describe('AppEmojiManager.getCustomEmojiDocuments', () => {
  it('never calls the API for a genuinely empty list', async() => {
    const {AppEmojiManager} = await import('@lib/appManagers/appEmojiManager');
    const manager = new AppEmojiManager();
    const invokeApi = vi.fn();
    (manager as unknown as {apiManager: {invokeApi: typeof invokeApi}}).apiManager = {invokeApi};

    await expect(manager.getCustomEmojiDocuments([])).resolves.toEqual([]);

    expect(invokeApi, 'an empty Vector<long> request is pointless and must not be sent').not.toHaveBeenCalled();
  });


  it('forwards the request as given -- filtering is not the manager\'s job -- and indexes the answer positionally', async() => {
    const {AppEmojiManager} = await import('@lib/appManagers/appEmojiManager');
    const manager = new AppEmojiManager();
    const requestedIds = ['341952722011750787', undefined, 2578] as unknown as DocId[];
    // One answer entry per requested id, `documentEmpty` standing in for the id the server
    // could not serve. saveDoc is mocked to the identity so the assertion below is about
    // request/response ordering, not about document hydration.
    const answer = [
      {_: 'document', id: '341952722011750787'},
      {_: 'documentEmpty', id: 0},
      {_: 'document', id: 2578}
    ];
    const invokeApi = vi.fn(() => Promise.resolve(answer));
    const saveDoc = vi.fn((doc: unknown) => doc);
    (manager as unknown as {apiManager: {invokeApi: typeof invokeApi}}).apiManager = {invokeApi};
    (manager as unknown as {appDocsManager: {saveDoc: typeof saveDoc}}).appDocsManager = {saveDoc};

    const docs = await manager.getCustomEmojiDocuments(requestedIds);

    expect(invokeApi, 'the invalid id travels unchanged -- the manager does not filter it out').toHaveBeenCalledTimes(1);
    expect(invokeApi.mock.calls[0]).toEqual([
      'messages.getCustomEmojiDocuments',
      {document_id: requestedIds}
    ]);
    expect(docs, 'the manager hands back the answer in the order the server sent it, one per requested id').toEqual(answer);
  });
});
