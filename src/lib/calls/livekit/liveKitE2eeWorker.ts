/**
 * The one place that spawns the LiveKit end-to-end-encryption worker. The `new URL(..., import.meta.url)`
 * form is what lets the bundler emit the worker as its own chunk.
 */
export function createLiveKitE2eeWorker(): Worker {
  return new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {type: 'module'});
}
