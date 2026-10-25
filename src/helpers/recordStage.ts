import type {Logger} from '@lib/logger';

// Logs the stage name and duration only, never the value it settles to.
export async function recordStage<T>(
  log: Logger,
  label: string,
  pending: MaybePromise<T>
): Promise<Awaited<T>> {
  const startedAt: number = performance.now();
  log.info(`${label} start`);

  try {
    const value: Awaited<T> = await pending;
    log.info(`${label} done in ${Math.round(performance.now() - startedAt)}ms`);
    return value;
  } catch(error) {
    log.info(`${label} failed after ${Math.round(performance.now() - startedAt)}ms`);
    throw error;
  }
}
