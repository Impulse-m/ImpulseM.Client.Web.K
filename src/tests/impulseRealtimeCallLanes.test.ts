import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {MaxChannelSubscriptions, RealtimeSubscriptions} from '@lib/impulse/realtimeSubscriptions';


/*
 * A joined group call keeps two realtime lanes the dialog window does not promise: the channel's own
 * `channel:{id}` lane (a channel call's updateGroupCall / updateGroupCallParticipants ride it) whatever
 * MaxChannelSubscriptions holds, and `call:{id}` (updateGroupCallMessage / updateDeleteGroupCallMessages,
 * published to the call's participants only; the subscribe proxy authorizes it). Both are released when
 * the call is left.
 */
const {MockCentrifuge, centrifugeInstances} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];

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

    public live(): string[] {
      return this.subscriptions.filter((sub) => sub.subscribed && !sub.unsubscribed).map((sub) => sub.channel);
    }
  }

  return {MockCentrifuge, centrifugeInstances};
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
  return {...actual, callFleet: vi.fn(async(): Promise<Uint8Array> => tokenReply())};
});


async function waitForInstances(count: number): Promise<void> {
  for(let i = 0; i < 200 && centrifugeInstances.length < count; ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe('RealtimeSubscriptions pin', () => {
  it('keeps a pinned channel outside the window, and releases it when unpinned', () => {
    const set = new RealtimeSubscriptions('1');
    const ids: number[] = [];
    for(let i = 1; i <= MaxChannelSubscriptions; ++i) {
      ids.push(i);
    }
    set.showDialogs(ids as any);
    expect(set.getChannels()).not.toContain('channel:5000');

    const pinned = set.pin(5000 as any);
    expect(pinned.subscribe).toEqual(['channel:5000']);
    expect(pinned.unsubscribe).toEqual([]);
    expect(set.getChannels().filter((channel) => channel.startsWith('channel:'))).toHaveLength(MaxChannelSubscriptions + 1);

    // a busy dialog list rotating does not drop it
    const rotated = set.showDialogs([6001, 6002, 6003] as any);
    expect(rotated.unsubscribe).not.toContain('channel:5000');
    expect(set.getChannels()).toContain('channel:5000');

    const released = set.pin(undefined);
    expect(released.unsubscribe).toContain('channel:5000');
    expect(set.getChannels()).not.toContain('channel:5000');
  });

  it('does not unsubscribe a pinned channel that is also in the window when it is unpinned', () => {
    const set = new RealtimeSubscriptions('1');
    set.showDialogs([7 as any]);
    set.pin(7 as any);
    const released = set.pin(undefined);
    expect(released.unsubscribe).toEqual([]);
    expect(set.getChannels()).toContain('channel:7');
  });
});

describe('realtime lanes of a joined group call', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
  });

  afterEach(async() => {
    const realtime = await import('@lib/impulse/realtime');
    ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
  });

  it('subscribes call:{id} while joined and unsubscribes it on leave', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    const socket = centrifugeInstances[0];

    realtime.setImpulseRealtimeCall(1, {callId: '555', channelId: undefined});
    expect(socket.live()).toContain('call:555');
    expect(socket.live().some((channel) => channel.startsWith('chat:'))).toBe(false);

    realtime.setImpulseRealtimeCall(1, undefined);
    expect(socket.live()).not.toContain('call:555');
  });

  it('subscribes the channel lane of a channel call outside the window and releases it when the call closes', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    const socket = centrifugeInstances[0];

    realtime.setImpulseRealtimeCall(1, {callId: '556', channelId: 4242 as any});
    await settle();
    expect(socket.live()).toEqual(expect.arrayContaining(['call:556', 'channel:4242']));

    realtime.setImpulseRealtimeCall(1, undefined);
    await settle();
    expect(socket.live()).not.toContain('call:556');
    expect(socket.live()).not.toContain('channel:4242');
  });

  it('brings the call lanes back when the socket is torn down and raised again during the call', async() => {
    const realtime = await import('@lib/impulse/realtime');
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(1);
    realtime.setImpulseRealtimeCall(1, {callId: '557', channelId: 4243 as any});
    await settle();

    realtime.stopImpulseRealtime(1);
    realtime.startImpulseRealtime('user-A', 1);
    await waitForInstances(2);
    await settle();

    expect(centrifugeInstances[1].live()).toEqual(expect.arrayContaining(['call:557', 'channel:4243']));
  });
});
