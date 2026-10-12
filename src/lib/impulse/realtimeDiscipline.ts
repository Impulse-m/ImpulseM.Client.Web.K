export const MaxConcurrentChannelDifferences = 2;
export const ProductionReconnectJitterMaxMs = 20_000;
export const DevelopmentReconnectJitterMaxMs = 250;

export function getReconnectJitterMaxMs(isDevelopment: boolean): number {
  return isDevelopment ? DevelopmentReconnectJitterMaxMs : ProductionReconnectJitterMaxMs;
}

export function fullJitterDelay(maxDelay: number, random = Math.random): number {
  return Math.floor(random() * (maxDelay + 1));
}

/**
 * The floor under the FIRST reconnect after the server hangs up on a healthy socket.
 *
 * This is the SDK's own default, adopted deliberately rather than inherited: the value we used to
 * pass was 1 ms, which made every server-initiated disconnect a zero-spread herd. See
 * sdkReconnectDelay below for why the number matters so much at attempt 0 (#445).
 */
export const ReconnectFloorMs = 500;

/**
 * Centrifuge 5's reconnect ladder, reproduced from the shipped bundle so our own options can be
 * asserted against it. Verbatim from node_modules/@impulsem/centrifuge/dist/centrifuge.js:
 *
 *   function P(a,r,e){a>31&&(a=31);let t=Ie(0,Math.min(e,r*Math.pow(2,a)));return Math.min(e,r+t)}
 *
 * i.e. min(max, min + randInt(0, min(max, min * 2^attempt))).
 *
 * Two properties decide everything and neither is obvious from the option names:
 *
 * 1. `maxDelay` is the exponential CAP, not a spread window. Three comments in this codebase read
 *    it as "reconnects spread across 20 seconds"; nothing spreads anything across 20 seconds.
 * 2. The random range grows from `minDelay`, so the ladder starts where the FLOOR is. At
 *    minDelay = 1 the first delay is 1 or 2 ms and the cap is not approached until roughly attempt
 *    14 -- and `_connectResponse` resets the attempt counter, so a socket that was healthy when the
 *    server hung up on it always starts at attempt 0.
 *
 * That is why this exists as a function rather than as a comment: a guard can assert the floor our
 * options actually produce, which a comment cannot.
 */
export function sdkReconnectDelay(
  attempt: number,
  minDelay: number,
  maxDelay: number,
  random = Math.random
): number {
  const laddered = Math.min(attempt, 31);
  const window = Math.min(maxDelay, minDelay * Math.pow(2, laddered));

  return Math.min(maxDelay, minDelay + Math.floor(random() * (window + 1)));
}

export class ConcurrentTaskQueue {
  private active = 0;
  private pending: (() => void)[] = [];

  constructor(private readonly concurrency: number) {}

  public run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        ++this.active;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          --this.active;
          this.pending.shift()?.();
        });
      };

      if(this.active < this.concurrency) {
        start();
      } else {
        this.pending.push(start);
      }
    });
  }
}
