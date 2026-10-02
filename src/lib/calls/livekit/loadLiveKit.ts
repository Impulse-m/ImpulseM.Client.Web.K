export type LiveKitModule = typeof import('livekit-client');

let pending: Promise<LiveKitModule> | undefined;

/**
 * Loads livekit-client on first use so the SDK stays out of the main chunk.
 * The promise is cached; a failed load is not, so the next call retries.
 */
export function loadLiveKit(): Promise<LiveKitModule> {
  if(!pending) {
    pending = import('livekit-client').catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
  }

  return pending;
}
