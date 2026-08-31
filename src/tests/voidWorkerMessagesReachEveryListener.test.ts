import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';

/**
 * A `invokeVoid` message is a NOTIFICATION: it carries no result, nobody awaits it, and more than
 * one part of the receiving realm can legitimately care about it. `serviceWorkerOnline` is exactly
 * that — the tab telling its worker whether a service worker exists (apiManagerProxy.ts:829) — and
 * two independent listeners are registered for it in the worker:
 *
 *   - `index.worker.ts:206`, at module scope, which stores the answer on `appManagersManager`;
 *   - `appDocsManager.ts:83`, from `after()`, which re-classifies every document already saved
 *     when the answer turns out to be "no" (`onServiceWorkerFail`).
 *
 * Only the first one ever runs. `SuperMessagePort.processInvokeTask` takes
 * `listeners.values().next().value` (superMessagePort.ts:675) — the first listener registered, and
 * only it — while `EventListenerBase` happily stores both. Module scope always wins over a
 * manager's `after()`, so the re-classification half is dead code that has never executed in
 * production.
 *
 * The cost is what the board reports: the videos that were in the chat history when the tab loaded
 * were classified as streamable in the first moments of the boot, the service worker then turned
 * out not to be there, the handler written to fix them up never ran, and those videos ask a
 * service worker that does not exist for their bytes for the rest of the session — while videos
 * that arrive later are classified correctly and play. This test pins the delivery invariant that
 * failure rests on; `documentStreamingFollowsServiceWorker.test.ts` pins what it costs the user.
 *
 * The port's own wire cannot be used here: `SuperMessagePort.postMessage` returns early under
 * `import.meta.env.MODE === 'test'` (superMessagePort.ts:363). The task below is byte-for-byte
 * what `invokeVoid('serviceWorkerOnline', false)` builds (`createInvokeTask`, superMessagePort.ts:733)
 * and is handed to the port's own `onMessage`, so the dispatch under test is production's.
 */
describe('a void message to the worker reaches every listener registered for it', () => {
  it('does not silently drop the second listener registered for the same notification', () => {
    const port = new MTProtoMessagePort<false>(false);
    const reached: string[] = [];

    // Production's registration order: the worker's own module-scope handler map first
    // (index.worker.ts:61), a manager's `after()` listener second (index.worker.ts:362).
    port.addMultipleEventsListeners({
      serviceWorkerOnline: () => {
        reached.push('worker module scope');
      }
    });
    port.addEventListener('serviceWorkerOnline', () => {
      reached.push('appDocsManager.after');
    });

    const rawPort = port as any;
    rawPort.onMessage({
      data: {
        type: 'invoke',
        id: rawPort.getNextTaskId(),
        payload: {type: 'serviceWorkerOnline', payload: false, void: true}
      },
      source: undefined,
      currentTarget: undefined
    });

    expect(
      reached,
      'the first listener did not run either — the message was not delivered at all, so this test ' +
      'is not measuring the drop it exists to measure'
    ).toContain('worker module scope');
    expect(
      reached,
      'the worker silently drops every listener but the first for a notification nobody awaits. ' +
      'The concrete casualty is appDocsManager\'s service-worker handler: it exists to re-classify ' +
      'documents when the service worker turns out to be missing, it has never once run, and so a ' +
      'video that was in the history when the tab loaded can never be played in this tab — it keeps ' +
      'asking a service worker that does not exist for its bytes and the user gets "Unfortunately, ' +
      'this video can\'t be played" on every retry'
    ).toEqual(['worker module scope', 'appDocsManager.after']);
  });
});
