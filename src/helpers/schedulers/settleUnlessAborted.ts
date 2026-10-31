import noop from '@helpers/noop';

export default function settleUnlessAborted<T>(
  signal: AbortSignal | undefined,
  cancelled: unknown,
  start: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
  stop: () => void = noop
): Promise<T> {
  return new Promise<T>((resolve: (value: T) => void, reject: (reason: unknown) => void): void => {
    if(signal?.aborted === true) {
      reject(cancelled);
      return;
    }

    const onAbort = (): void => {
      stop();
      reject(cancelled);
    };
    const detach = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, {once: true});
    start(
      (value: T): void => {
        detach();
        resolve(value);
      },
      (reason: unknown): void => {
        detach();
        reject(reason);
      }
    );
  });
}
