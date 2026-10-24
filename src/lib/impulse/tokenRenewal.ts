import {getLogger} from '@lib/impulseLogger';

export function scheduleTokenRenewal(options: {
  exp: number,
  renew: () => Promise<void | boolean>,
  random?: () => number
}): () => void {
  const random: () => number = options.random ?? Math.random;
  const delay: number = Math.max(0, (options.exp - 300 + random() * 180) * 1000 - Date.now());
  let cancelled: boolean = false;
  let retryDelay: number = 1000;
  let timer: ReturnType<typeof setTimeout> = setTimeout(run, delay);
  function retry(): void {
    const remaining: number = (options.exp - 120) * 1000 - Date.now();
    if(cancelled || remaining <= 0) {
      return;
    }
    timer = setTimeout(run, Math.min(retryDelay, remaining));
    retryDelay = Math.min(retryDelay * 2, 60_000);
  }
  async function run(): Promise<void> {
    if(cancelled) {
      return;
    }
    try {
      if(await options.renew() === false) {
        retry();
      }
    } catch(error: unknown) {
      getLogger('impulse-renewal').warn('Token renewal failed', {}, error);
      retry();
    }
  }
  return (): void => {
    cancelled = true;
    clearTimeout(timer);
  };
}
