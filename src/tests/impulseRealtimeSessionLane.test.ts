import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * The connection token subscribes a connection, server-side, to its own `session:{user}:{session}` lane
 * (CentrifugoChannelNames.SessionInbox). What is addressed to one session alone is published there: a 1:1
 * call's phoneCallAccepted for the caller, the active phoneCall with its LiveKit coordinates for the
 * callee. A Subscription object only sees the lanes the client asked for, so these publications arrive on
 * the Centrifuge client itself ('publication') — and with no handler for it they were read off the socket
 * and dropped, so a call never got past ringing.
 */
const {MockCentrifuge, centrifugeInstances} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];

  class MockSubscription {
    public readonly handlers = new Map<string, (ctx: any) => void>();

    constructor(public readonly channel: string) {}

    public on(event: string, handler: (ctx: any) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    public subscribe(): void {}

    public unsubscribe(): void {}
  }

  class MockCentrifuge {
    public readonly handlers = new Map<string, (ctx: any) => void>();
    public readonly subscriptions: MockSubscription[] = [];

    constructor(public readonly url: string, public readonly options: any) {
      centrifugeInstances.push(this);
    }

    public on(event: string, handler: (ctx: any) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    public newSubscription(channel: string): MockSubscription {
      const sub = new MockSubscription(channel);
      this.subscriptions.push(sub);
      return sub;
    }

    public removeSubscription(): void {}

    public connect(): void {}

    public disconnect(): void {}
  }

  return {MockCentrifuge, centrifugeInstances};
});

vi.mock('centrifuge', () => ({Centrifuge: MockCentrifuge}));

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
  return {...actual, createClient: vi.fn(() => ({getCentrifugoToken: vi.fn(async() => ({token: 'centrifugo-token'}))}))};
});


async function waitForInstances(count: number): Promise<void> {
  for(let i = 0; i < 200 && centrifugeInstances.length < count; ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('realtime delivers what the server addresses to this session', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
  });

  afterEach(async() => {
    const realtime = await import('@lib/impulse/realtime');
    ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
  });

  it('hands a server-side subscription publication to the sink of its own account', async() => {
    const realtime = await import('@lib/impulse/realtime');
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    realtime.setRealtimeSink(1, sinkA);
    realtime.setRealtimeSink(2, sinkB);
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    realtime.startImpulseRealtime('user-B', 2);
    await waitForInstances(2);
    const [socketA, socketB] = centrifugeInstances;

    expect(socketA.handlers.has('publication'), 'the client registers no handler for server-side subscription publications').toBe(true);
    // an oversize envelope reaches the sink without needing a decodable payload
    socketA.handlers.get('publication')!({channel: 'session:user-A:42', data: {oversize: true, type: 500}});

    expect(sinkA).toHaveBeenCalledWith({_: 'updatesTooLong'});
    expect(sinkB).not.toHaveBeenCalled();
    socketB.handlers.get('publication')!({channel: 'session:user-B:43', data: {oversize: true, type: 500}});
    expect(sinkB).toHaveBeenCalledTimes(1);
  });

  it('ignores a publication that carries nothing', async() => {
    const realtime = await import('@lib/impulse/realtime');
    const sink = vi.fn();
    realtime.setRealtimeSink(1, sink);
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);

    centrifugeInstances[0].handlers.get('publication')!({channel: 'session:user-A:42'});
    centrifugeInstances[0].handlers.get('publication')!(undefined);

    expect(sink).not.toHaveBeenCalled();
  });
});
