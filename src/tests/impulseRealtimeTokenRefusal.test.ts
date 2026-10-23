import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {UnauthorizedError} from '@impulsem/centrifuge';
import {create, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {GetCentrifugoTokenResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/sync/sync_service_pb';


/*
 * The SDK retries a failing getToken forever and stops only when it throws its UnauthorizedError.
 * A 401 or 403 from the Centrifugo token call is a refusal of the session, not an outage: the connection must stop
 * instead of hammering the token call on every reconnect.
 */
const {MockCentrifuge, centrifugeInstances, callFleet} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];
  const callFleet = vi.fn();

  class MockCentrifuge {
    constructor(
      public readonly url: string,
      public readonly options: {getToken: () => Promise<string>, stopOnRefusedToken?: boolean}
    ) {
      centrifugeInstances.push(this);
    }

    public on(): this {
      return this;
    }

    public newSubscription(): {on: () => void, subscribe: () => void, unsubscribe: () => void} {
      return {on() {}, subscribe() {}, unsubscribe() {}};
    }

    public removeSubscription(): void {}

    public connect(): void {}

    public disconnect(): void {}
  }

  return {MockCentrifuge, centrifugeInstances, callFleet};
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
    refreshImpulseSession: vi.fn(async() => false)
  };
});

vi.mock('@lib/impulse/grpc/credentials', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/grpc/credentials')>();
  return {...actual, requireGrpcSessionToken: vi.fn(() => 'session-token')};
});

vi.mock('@lib/impulse/fleet/fleet', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/fleet/fleet')>();
  return {...actual, callFleet};
});

const SDK_MUST_STOP_ON_A_REFUSED_SESSION =
  'getToken must throw the SDK\'s UnauthorizedError on a refused session: any other error is retried forever';

function tokenReply(token: string): Uint8Array {
  return toBinary(GetCentrifugoTokenResponseSchema, create(GetCentrifugoTokenResponseSchema, {token}));
}

async function sdkGetToken(): Promise<() => Promise<string>> {
  const realtime = await import('@lib/impulse/realtime');
  realtime.startImpulseRealtime('user-A', 1);
  for(let i = 0; i < 200 && centrifugeInstances.length < 1; ++i) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  return centrifugeInstances[0].options.getToken;
}

describe('getToken handed to the SDK', () => {
  beforeEach(() => {
    vi.resetModules();
    centrifugeInstances.length = 0;
    callFleet.mockReset();
    callFleet.mockResolvedValueOnce(tokenReply('first-token'));
  });

  afterEach(async() => {
    const realtime = await import('@lib/impulse/realtime');
    ([1, 2, 3, 4] as ActiveAccountNumber[]).forEach((accountNumber) => realtime.stopImpulseRealtime(accountNumber));
  });

  it('returns the minted token', async() => {
    const getToken = await sdkGetToken();
    callFleet.mockResolvedValueOnce(tokenReply('renewed-token'));

    await expect(getToken()).resolves.toBe('renewed-token');
  });

  it.each([
    ['401 unauthenticated', {type: 'AUTH_KEY_UNREGISTERED', code: 401}],
    ['403 forbidden', {type: 'FORBIDDEN', code: 403}]
  ])('throws UnauthorizedError on %s', async(_name: string, refusal: {type: string, code: number}) => {
    const getToken = await sdkGetToken();
    callFleet.mockRejectedValueOnce(refusal);

    await expect(getToken(), SDK_MUST_STOP_ON_A_REFUSED_SESSION).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('lets an outage through unchanged so the SDK keeps retrying', async() => {
    const getToken = await sdkGetToken();
    const outage = {type: 'NETWORK_BAD_RESPONSE', code: 500};
    callFleet.mockRejectedValueOnce(outage);

    const error: unknown = await getToken().then((): undefined => undefined, (err: unknown): unknown => err);

    expect(error).toBe(outage);
    expect(error).not.toBeInstanceOf(UnauthorizedError);
  });

  it('mints a fresh token each time the SDK asks after a refusal, instead of reusing the refused one', async() => {
    const getToken = await sdkGetToken();
    callFleet.mockResolvedValueOnce(tokenReply('after-refusal-token'));

    await expect(getToken(), 'the retry after a refused token must reach the fleet for a new one').resolves.toBe('after-refusal-token');
    expect(callFleet).toHaveBeenCalledTimes(2);
  });

  it('pins the refused-token retry to the SDK 1.0.0 behaviour, which sent the token getToken returned', async() => {
    await sdkGetToken();

    expect(
      centrifugeInstances[0].options.stopOnRefusedToken,
      'SDK 1.6.0 blocks a token the server refused unless this is false; 1.0.0 had no such memory'
    ).toBe(false);
  });
});
