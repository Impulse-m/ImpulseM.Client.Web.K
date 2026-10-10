import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * The sending session must not receive the echo of its own send on user:{id}: the server tags that
 * publication with auth_session = the sending session's hash, and the subscription filters that tag
 * out with a neq filter. Every other session keeps the publication, and a publication without the tag
 * (every other kind of update) passes.
 */
const {MockCentrifuge, centrifugeInstances, getOwnSessionTag} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];
  const getOwnSessionTag = vi.fn(async() => ({key: 'auth_session', value: '4242'}));

  class MockSubscription {
    public subscribed = false;
    public unsubscribed = false;

    constructor(public readonly channel: string, public readonly options: unknown) {}

    public on(): this {
      return this;
    }

    public subscribe(): void {
      this.subscribed = true;
    }

    public unsubscribe(): void {
      this.unsubscribed = true;
    }
  }

  class MockCentrifuge {
    public readonly subscriptions: MockSubscription[] = [];

    constructor(public readonly url: string, public readonly options: unknown) {
      centrifugeInstances.push(this);
    }

    public on(): this {
      return this;
    }

    public newSubscription(channel: string, options?: unknown): MockSubscription {
      const sub = new MockSubscription(channel, options);
      this.subscriptions.push(sub);
      return sub;
    }

    public removeSubscription(): void {}

    public connect(): void {}

    public disconnect(): void {}

    public subscriptionFor(channel: string): MockSubscription | undefined {
      return this.subscriptions.find((sub) => sub.channel === channel);
    }
  }

  return {MockCentrifuge, centrifugeInstances, getOwnSessionTag};
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
  return {
    ...actual,
    createClient: vi.fn(() => ({
      getCentrifugoToken: vi.fn(async() => ({token: 'centrifugo-token'})),
      getOwnSessionTag
    }))
  };
});

type PublicationTags = Record<string, string> | undefined;

// Centrifugo evaluates a neq filter node against the publication's tags: a missing key does not
// exclude the publication.
function passesTagsFilter(options: unknown, tags: PublicationTags): boolean {
  const filter = (options as {tagsFilter?: {key: string, cmp: string, val: string}} | undefined)?.tagsFilter;
  if(!filter) {
    return true;
  }

  const value: string | undefined = tags?.[filter.key];
  if(filter.cmp !== 'neq' || value === undefined) {
    return true;
  }

  return value !== filter.val;
}

async function waitForInstances(count: number): Promise<void> {
  for(let i = 0; i < 200 && centrifugeInstances.length < count; ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForSubscription(socket: (typeof centrifugeInstances)[number], channel: string): Promise<void> {
  for(let i = 0; i < 200 && !socket.subscriptionFor(channel); ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('own session tag on the user channel', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
    getOwnSessionTag.mockClear();
    getOwnSessionTag.mockImplementation(async() => ({key: 'auth_session', value: '4242'}));
  });

  afterEach(async() => {
    const realtime = await import('@lib/impulse/realtime');
    ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
  });

  it('subscribes user:{id} with a neq filter on auth_session carrying this session\'s hash', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    await waitForSubscription(centrifugeInstances[0], 'user:user-A');

    const sub = centrifugeInstances[0].subscriptionFor('user:user-A');
    expect(sub?.options).toEqual({tagsFilter: {key: 'auth_session', cmp: 'neq', val: '4242'}});
  });

  it('delivers a publication tagged by another session and withholds the one tagged by this session', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    await waitForSubscription(centrifugeInstances[0], 'user:user-A');

    const sub = centrifugeInstances[0].subscriptionFor('user:user-A');
    expect(passesTagsFilter(sub?.options, {auth_session: '7777'})).toBe(true);
    expect(passesTagsFilter(sub?.options, {auth_session: '4242'})).toBe(false);
  });

  it('delivers a publication that carries no auth_session tag', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    await waitForSubscription(centrifugeInstances[0], 'user:user-A');

    const sub = centrifugeInstances[0].subscriptionFor('user:user-A');
    expect(passesTagsFilter(sub?.options, undefined)).toBe(true);
    expect(passesTagsFilter(sub?.options, {})).toBe(true);
  });

  it('fetches the own tag once for the session credentials, not once per spin-up', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    await waitForSubscription(centrifugeInstances[0], 'user:user-A');

    realtime.stopImpulseRealtime(1);
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(2);
    await waitForSubscription(centrifugeInstances[1], 'user:user-A');

    expect(getOwnSessionTag).toHaveBeenCalledTimes(1);
    expect(centrifugeInstances[1].subscriptionFor('user:user-A')?.options).toEqual({
      tagsFilter: {key: 'auth_session', cmp: 'neq', val: '4242'}
    });
  });

  it('subscribes user:{id} without a filter when GetOwnSessionTag rejects', async() => {
    getOwnSessionTag.mockImplementation(async() => {
      throw new Error('Sync.GetOwnSessionTag unavailable');
    });

    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    await waitForSubscription(centrifugeInstances[0], 'user:user-A');

    const sub = centrifugeInstances[0].subscriptionFor('user:user-A');
    expect(sub).toBeDefined();
    expect(sub?.options).toBeUndefined();
    expect(sub?.subscribed).toBe(true);
  });
});
