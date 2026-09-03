import {
  ConcurrentTaskQueue,
  DevelopmentReconnectJitterMaxMs,
  fullJitterDelay,
  getReconnectJitterMaxMs,
  MaxConcurrentChannelDifferences,
  ProductionReconnectJitterMaxMs
} from './realtimeDiscipline';
import {MaxChannelSubscriptions, RealtimeSubscriptions} from './realtimeSubscriptions';

describe('RealtimeSubscriptions', () => {
  it('never exceeds 32 channels and always contains user:{me}', () => {
    const subscriptions = new RealtimeSubscriptions('me');
    subscriptions.showDialogs(Array.from({length: 50}, (_, index) => index + 1));

    expect(subscriptions.getChannels()).toContain('user:me');
    expect(subscriptions.getChannels().filter((channel) => channel.startsWith('channel:')))
    .toHaveLength(MaxChannelSubscriptions);
  });

  it('opening a 33rd channel evicts the least recent channel', () => {
    const subscriptions = new RealtimeSubscriptions('me');
    for(let channelId = 1; channelId <= 33; ++channelId) {
      subscriptions.open(channelId);
    }

    expect(subscriptions.getChannels()).not.toContain('channel:1');
    expect(subscriptions.getChannels()).toContain('channel:33');
  });

  it('close keeps a dialog that is still visible', () => {
    const subscriptions = new RealtimeSubscriptions('me');
    subscriptions.open(7);
    subscriptions.showDialogs([7]);
    const diff = subscriptions.close(7);

    expect(diff.unsubscribe).not.toContain('channel:7');
    expect(subscriptions.getChannels()).toContain('channel:7');
  });
});

describe('realtime reconnect discipline', () => {
  it('keeps full-jitter reconnect delays inside their bounds', () => {
    for(const [isDevelopment, expectedMax] of [
      [true, DevelopmentReconnectJitterMaxMs],
      [false, ProductionReconnectJitterMaxMs]
    ] as const) {
      const maxDelay = getReconnectJitterMaxMs(isDevelopment);
      expect(maxDelay).toBe(expectedMax);
      expect(fullJitterDelay(maxDelay, () => 0)).toBe(0);
      expect(fullJitterDelay(maxDelay, () => 0.999999)).toBeLessThanOrEqual(maxDelay);
    }
  });

  it('never runs more than 2 channel differences at once', async() => {
    const queue = new ConcurrentTaskQueue(MaxConcurrentChannelDifferences);
    let active = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const tasks = Array.from({length: 5}, () => queue.run(() => new Promise<void>((resolve) => {
      ++active;
      maximumActive = Math.max(maximumActive, active);
      releases.push(() => {
        --active;
        resolve();
      });
    })));

    await Promise.resolve();
    expect(maximumActive).toBe(MaxConcurrentChannelDifferences);
    for(let completed = 0; completed < tasks.length; ++completed) {
      while(!releases.length) {
        await Promise.resolve();
      }
      releases.shift()();
    }
    await Promise.all(tasks);
    expect(maximumActive).toBe(MaxConcurrentChannelDifferences);
  });
});
