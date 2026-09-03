export const MaxConcurrentChannelDifferences = 2;
export const ProductionReconnectJitterMaxMs = 20_000;
export const DevelopmentReconnectJitterMaxMs = 250;

export function getReconnectJitterMaxMs(isDevelopment: boolean): number {
  return isDevelopment ? DevelopmentReconnectJitterMaxMs : ProductionReconnectJitterMaxMs;
}

export function fullJitterDelay(maxDelay: number, random = Math.random): number {
  return Math.floor(random() * (maxDelay + 1));
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
