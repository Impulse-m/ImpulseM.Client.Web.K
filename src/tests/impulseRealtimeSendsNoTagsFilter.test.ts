import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * The server filters a session's own echo and the actor's own shared-lane copy itself. The client
 * subscribes with no tags filter, whatever the lane: a client-side filter would put server
 * behaviour into every client.
 */
const {MockCentrifuge, centrifugeInstances, createClientCalls} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];
  const createClientCalls: string[] = [];

  class MockSubscription {
    constructor(public readonly channel: string, public readonly options: unknown) {}

    public on(): this {
      return this;
    }

    public subscribe(): void {}

    public unsubscribe(): void {}
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
  }

  return {MockCentrifuge, centrifugeInstances, createClientCalls};
});

vi.mock('@impulsem/centrifuge', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge')>();
  return {...actual, Centrifuge: MockCentrifuge};
});

vi.mock('@lib/impulse/session', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/session')>();
  return {
    ...actual,
    whenImpulseSessionReady: vi.fn(async() => {}),
    refreshImpulseSession: vi.fn(async() => true)
  };
});

vi.mock('@lib/impulse/grpc/credentials', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/grpc/credentials')>();
  return {...actual, requireGrpcSessionToken: vi.fn(() => 'session-token')};
});

vi.mock('@lib/impulse/fleet/fleet', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/fleet/fleet')>();
  const {create, toBinary} = await import('@bufbuild/protobuf');
  const {GetCentrifugoTokenResponseSchema} = await import('@lib/impulse/grpc/gen/v1/internal/impulse/sync/sync_service_pb');
  const tokenReply = (): Uint8Array => toBinary(GetCentrifugoTokenResponseSchema, create(GetCentrifugoTokenResponseSchema, {token: 'centrifugo-token'}));
  const callFleet = vi.fn(async(call: {method: string}): Promise<Uint8Array> => {
    createClientCalls.push(call.method);
    return tokenReply();
  });
  return {...actual, callFleet};
});

const NO_TAGS_FILTER = 'the server filters the echo itself; a subscription carrying a tags filter puts that work back on the client';

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe('subscriptions carry no tags filter', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
    createClientCalls.length = 0;
  });

  afterEach(async() => {
    const realtime = await import('@lib/impulse/realtime');
    ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
  });

  it('opens user:, call: and channel: lanes without tagsFilter or tf, and asks for no tag', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    for(let i = 0; i < 200 && centrifugeInstances.length < 1; ++i) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    realtime.setImpulseRealtimeCall(1, {callId: '558', channelId: 4244 as any});
    await settle();

    const subscriptions = centrifugeInstances[0].subscriptions;
    const channels: string[] = subscriptions.map((sub) => sub.channel);
    expect(channels).toEqual(expect.arrayContaining(['user:user-A', 'call:558', 'channel:4244']));

    for(const sub of subscriptions) {
      const options = (sub.options ?? {}) as Record<string, unknown>;
      expect(options.tagsFilter, NO_TAGS_FILTER).toBeUndefined();
      expect(options.tf, NO_TAGS_FILTER).toBeUndefined();
    }

    expect(createClientCalls).not.toContain('getOwnSessionTag');
    expect(createClientCalls).not.toContain('getChannelActorTags');
  });
});
