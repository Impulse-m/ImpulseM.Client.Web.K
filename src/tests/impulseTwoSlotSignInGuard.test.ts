import {beforeEach, describe, expect, it, vi} from 'vitest';

/*
 * Guard (passes on the current code): slot B's sign-in never closes slot A's access socket.
 *
 * Slot A is signed in and holds an access socket. Slot B starts on its identity socket and signs in through the real
 * session path (captureImpulseSessionToken), which retires B's identity socket and opens B's access socket. Only the
 * identity and pool sockets of the slot signing in may close (spec T5); A's access socket must stay open.
 */

const {MockCentrifuge, centrifugeInstances} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];

  class MockSubscription {
    public subscribed = false;

    public on(): this {
      return this;
    }

    public subscribe(): void {
      this.subscribed = true;
    }

    public unsubscribe(): void {
      this.subscribed = false;
    }
  }

  class MockCentrifuge {
    public disconnected = false;

    constructor(public readonly url: string, public readonly options: any) {
      centrifugeInstances.push(this);
    }

    public on(): this {
      return this;
    }

    public newSubscription(): MockSubscription {
      return new MockSubscription();
    }

    public removeSubscription(): void {}

    public connect(): void {}

    public disconnect(): void {
      this.disconnected = true;
    }
  }

  return {MockCentrifuge, centrifugeInstances};
});

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  return {...actual, Centrifuge: MockCentrifuge};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn(async(): Promise<undefined> => undefined),
    update: vi.fn(async(): Promise<void> => {}),
    clearFields: vi.fn(async(): Promise<void> => {})
  }
}));

describe('guard: a sign-in on one slot never closes another slot\'s access socket', () => {
  beforeEach(() => {
    centrifugeInstances.length = 0;
  });

  it('slot A\'s access socket stays open while slot B signs in, and only slot B\'s identity socket is retired', async() => {
    vi.resetModules();
    const {setFleetIdentitySource} = await import('@lib/impulse/fleet/fleet');
    const {fleetIdentityFor, captureImpulseSessionToken} = await import('@lib/impulse/session');
    const {setGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');
    const realtime = await import('@lib/impulse/realtime');

    setFleetIdentitySource(fleetIdentityFor);
    setGrpcSessionToken(1, 'slot-a-access-token');
    realtime.startImpulseRealtime('user-a', 1);
    realtime.startImpulseRealtime('user-b', 2);

    const socketA = centrifugeInstances[0];
    const identitySocketB = centrifugeInstances[1];
    expect(socketA, 'slot A must hold its own access socket').toBeDefined();
    expect(identitySocketB, 'slot B must hold its own identity socket before it signs in').toBeDefined();

    await captureImpulseSessionToken(2, {session_token: 'slot-b-access-token', refresh_token: 'slot-b-refresh-token'});

    expect(socketA.disconnected, 'slot A\'s access socket was closed by slot B\'s sign-in').toBe(false);
    expect(identitySocketB.disconnected, 'slot B\'s identity socket is retired by its own class change').toBe(true);
    expect(
      centrifugeInstances.slice(2).length,
      'slot B reconnects its own access socket after sign-in'
    ).toBeGreaterThan(0);

    realtime.stopImpulseRealtime(1);
    realtime.stopImpulseRealtime(2);
  });
});
