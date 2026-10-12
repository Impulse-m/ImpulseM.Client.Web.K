import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * Per-account realtime lifecycle (CEO multi-account report).
 *
 * The realtime connection was a SharedWorker-wide singleton after #436 had already moved every
 * other per-account credential into a map keyed by account number. Bringing up account B called
 * stopImpulseRealtime() and tore down account A's socket, so only the last account brought up held
 * a live subscription. These pins are the unit-level counterpart of multiAccountRealtime.live.test.ts:
 * with Centrifuge mocked, they prove the LIFECYCLE is per account — starting account 2 leaves
 * account 1's socket, stopping account 1 leaves account 2's, and each account's sink receives only
 * its own socket's publications.
 */
const {MockCentrifuge, centrifugeInstances} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];

  class MockSubscription {
    public subscribed = false;
    public unsubscribed = false;
    public readonly handlers = new Map<string, (ctx: any) => void>();

    constructor(public readonly channel: string) {}

    public on(event: string, handler: (ctx: any) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    public subscribe(): void {
      this.subscribed = true;
    }

    public unsubscribe(): void {
      this.unsubscribed = true;
    }

    public emit(event: string, ctx: any): void {
      this.handlers.get(event)?.(ctx);
    }
  }

  class MockCentrifuge {
    public connected = false;
    public disconnected = false;
    public readonly subscriptions: MockSubscription[] = [];

    constructor(public readonly url: string, public readonly options: any) {
      centrifugeInstances.push(this);
    }

    public on(): this {
      return this;
    }

    public newSubscription(channel: string): MockSubscription {
      const sub = new MockSubscription(channel);
      this.subscriptions.push(sub);
      return sub;
    }

    public removeSubscription(): void {}

    public connect(): void {
      this.connected = true;
    }

    public disconnect(): void {
      this.disconnected = true;
    }

    public subscriptionFor(channel: string): MockSubscription | undefined {
      return this.subscriptions.find((sub) => sub.channel === channel);
    }
  }

  return {MockCentrifuge, centrifugeInstances};
});

vi.mock('@impulsem/centrifuge', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge')>();
  return {...actual, Centrifuge: MockCentrifuge};
});

// The token mint is exercised for real in the live lane; here it is short-circuited so the test
// stays a pure unit around the connection lifecycle. Only the two functions the spin-up path calls
// are overridden — everything else stays actual so the rest of the module graph loads unchanged.
vi.mock('@lib/impulse/session', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/session')>();
  return {
    ...actual,
    whenImpulseSessionReady: vi.fn(async() => {}),
    refreshImpulseSession: vi.fn(async() => true)
  };
});

vi.mock('@lib/impulse/grpc/transport', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/grpc/transport')>();
  return {
    ...actual,
    requireGrpcSessionToken: vi.fn(() => 'session-token'),
    getGrpcTransport: vi.fn(() => ({} as any))
  };
});

vi.mock('@connectrpc/connect', async(importActual) => {
  const actual = await importActual<typeof import('@connectrpc/connect')>();
  return {
    ...actual,
    createClient: vi.fn(() => ({
      getCentrifugoToken: vi.fn(async() => ({token: 'centrifugo-token'}))
    }))
  };
});


type RealtimeModule = typeof import('@lib/impulse/realtime');

async function importRealtime(): Promise<RealtimeModule> {
  return import('@lib/impulse/realtime');
}

/** The spin-up is fire-and-forget (token mint -> connect); poll until the socket is constructed. */
async function waitForInstances(count: number): Promise<void> {
  for(let i = 0; i < 200 && centrifugeInstances.length < count; ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}


describe('realtime lifecycle is per account, not a SharedWorker-wide singleton (#436)', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
  });

  afterEach(async() => {
    // Leave no live socket behind for the next test's fresh module graph.
    try {
      const realtime = await importRealtime();
      ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
    } catch{
      // module may not have been imported in a given test
    }
  });

  it('bringing up account 2 does NOT disconnect account 1 (the singleton stopImpulseRealtime is gone)', async() => {
    const realtime = await importRealtime();

    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    const socketOne = centrifugeInstances[0];

    realtime.startImpulseRealtime('user-B', 2);
    await waitForInstances(2);
    const socketTwo = centrifugeInstances[1];

    expect(centrifugeInstances.length, 'each account must open its own socket').toBe(2);
    expect(
      socketOne.disconnected,
      'account 1\'s socket was disconnected by account 2\'s bring-up — this is exactly the CEO ' +
      'multi-account defect (the old activeUserId !== userId -> stopImpulseRealtime branch)'
    ).toBe(false);
    expect(socketTwo.disconnected, 'account 2\'s own socket must be live').toBe(false);
    expect(socketOne.subscriptionFor('user:user-A')?.subscribed).toBe(true);
    expect(socketTwo.subscriptionFor('user:user-B')?.subscribed).toBe(true);
  });

  it('stopImpulseRealtime(1) tears down ONLY account 1 and leaves account 2 live', async() => {
    const realtime = await importRealtime();

    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    realtime.startImpulseRealtime('user-B', 2);
    await waitForInstances(2);
    const [socketOne, socketTwo] = centrifugeInstances;

    realtime.stopImpulseRealtime(1);

    expect(socketOne.disconnected, 'account 1 must be torn down by its own stop').toBe(true);
    expect(
      socketTwo.disconnected,
      'account 2 must stay live when account 1 is stopped — logging out one account must not drop ' +
      'the other account\'s realtime'
    ).toBe(false);
  });

  it('setRealtimeSink routes each account\'s publications to that account\'s own sink only', async() => {
    const realtime = await importRealtime();

    const sinkA = vi.fn();
    const sinkB = vi.fn();
    realtime.setRealtimeSink(1, sinkA);
    realtime.setRealtimeSink(2, sinkB);

    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    realtime.startImpulseRealtime('user-B', 2);
    await waitForInstances(2);
    const [socketOne, socketTwo] = centrifugeInstances;

    // An oversize envelope routes to the sink without needing a decodable payload — the shortest
    // path that still proves which account's sink was handed the publication.
    socketOne.subscriptionFor('user:user-A')!.emit('publication', {data: {oversize: true, type: 1}});
    expect(sinkA, 'account 1\'s socket must reach account 1\'s sink').toHaveBeenCalledWith({_: 'updatesTooLong'});
    expect(sinkB, 'account 1\'s socket must NOT reach account 2\'s sink').not.toHaveBeenCalled();

    socketTwo.subscriptionFor('user:user-B')!.emit('publication', {data: {oversize: true, type: 1}});
    expect(sinkB, 'account 2\'s socket must reach account 2\'s sink').toHaveBeenCalledWith({_: 'updatesTooLong'});
    expect(sinkA, 'account 2\'s socket must not have re-triggered account 1\'s sink').toHaveBeenCalledTimes(1);
  });
});
