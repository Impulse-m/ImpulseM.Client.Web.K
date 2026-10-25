import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {FleetIdentity} from '@lib/impulse/fleet/fleet';

/*
 * A call refused at maxPendingRpc (SDK README.md:340) was not sent: the socket holds it in a FIFO until a settled call
 * releases it, and a waiting call keeps its own deadline and signal.
 */

const {MockCentrifuge, centrifugeInstances, SDK_DEFAULT_MAX_PENDING_RPC, LIMIT_EXCEEDED, CANCELLED} = vi.hoisted(() => {
  const centrifugeInstances: MockCentrifuge[] = [];
  const SDK_DEFAULT_MAX_PENDING_RPC: number = 32;
  const LIMIT_EXCEEDED: number = 16;
  const CANCELLED: number = 17;

  type Reply = {data: Uint8Array};

  type SentCall = {
    data: Uint8Array,
    options: {signal?: AbortSignal, timeout?: number}
  };

  type HeldCall = {
    data: Uint8Array,
    settle: (reply: Reply) => void
  };

  // The SDK's tracked calls: one slot per call from the call until it settles, and a refusal at the bound.
  class MockCentrifuge {
    public readonly sent: SentCall[] = [];
    public readonly held: HeldCall[] = [];

    public constructor(public readonly url: string, public readonly options: any) {
      centrifugeInstances.push(this);
    }

    public on(): this {
      return this;
    }

    public connect(): void {}

    public disconnect(): void {}

    public rpc(method: string, data: Uint8Array, options: SentCall['options'] = {}): Promise<Reply> {
      const limit: number = this.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
      if(this.held.length >= limit) {
        return Promise.reject({code: LIMIT_EXCEEDED, message: 'too many pending rpc calls'});
      }

      return new Promise<Reply>((resolve: (reply: Reply) => void, reject: (error: unknown) => void): void => {
        const held: HeldCall = {
          data,
          settle: (reply: Reply): void => {
            this.held.splice(this.held.indexOf(held), 1);
            resolve(reply);
          }
        };
        this.held.push(held);
        this.sent.push({data, options});
        options.signal?.addEventListener('abort', (): void => {
          this.held.splice(this.held.indexOf(held), 1);
          reject({code: CANCELLED, message: 'cancelled'});
        }, {once: true});
      });
    }
  }

  return {MockCentrifuge, centrifugeInstances, SDK_DEFAULT_MAX_PENDING_RPC, LIMIT_EXCEEDED, CANCELLED};
});

type MockSocket = InstanceType<typeof MockCentrifuge>;

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  return {...actual, Centrifuge: MockCentrifuge};
});

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

const ACCOUNT: ActiveAccountNumber = 1;
const METHOD: string = 'messages.getDialogs';
const TIMEOUT_CODE: number = 1;
const WAITING_FIRST: number = 200;
const WAITING_SECOND: number = 201;
const WAITING_QUEUE_BASE: number = 100;
const WAITING_OVERFLOW: number = 250;

function callOf(marker: number, signal?: AbortSignal): {accountNumber: ActiveAccountNumber, method: string, request: Uint8Array, signal?: AbortSignal} {
  return {accountNumber: ACCOUNT, method: METHOD, request: new Uint8Array([marker]), signal};
}

// Lets the promise chains of settled calls run before the next expectation reads the mock.
async function settleChains(): Promise<void> {
  for(let step: number = 0; step < 64; ++step) {
    await Promise.resolve();
  }
}

async function socketAfterFirstCall(realtime: typeof import('@lib/impulse/realtime')): Promise<MockSocket> {
  realtime.callUpdateSocket(callOf(0)).catch((): void => undefined);
  await settleChains();
  return centrifugeInstances[0];
}

beforeEach(async() => {
  vi.resetModules();
  centrifugeInstances.length = 0;
  const {setFleetIdentitySource} = await import('@lib/impulse/fleet/fleet');
  const identity: FleetIdentity = {kind: 'session', key: 'session:fixture', getToken: async(): Promise<string> => 'token'};
  setFleetIdentitySource(() => identity);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('update socket rpc queue (SDK README.md:338-340)', () => {
  it('sends a call refused at the bound when a tracked call settles, with the deadline it has left', async() => {
    vi.useFakeTimers();
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    const socket: MockSocket = await socketAfterFirstCall(realtime);
    const limit: number = socket.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
    for(let marker: number = 1; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(marker)).catch((): void => undefined);
    }
    realtime.callUpdateSocket(callOf(WAITING_FIRST)).catch((): void => undefined);
    await settleChains();

    expect(socket.sent.length, 'the call beyond maxPendingRpc must wait, not be sent').toBe(limit);

    await vi.advanceTimersByTimeAsync(10_000);
    socket.held[0].settle({data: new Uint8Array([1])});
    await settleChains();

    expect(socket.sent.length, 'a refused call must be sent once a tracked call settles').toBe(limit + 1);
    expect(socket.sent[limit].data[0], 'the waiting call must be the one sent').toBe(WAITING_FIRST);
    expect(
      socket.sent[limit].options.timeout,
      'the released call keeps the deadline it had when it was refused, not a new full timeout'
    ).toBe(socket.options.timeout - 10_000);
  });

  it('rejects a waiting call with a timeout at its own deadline, and does not send it', async() => {
    vi.useFakeTimers();
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    const socket: MockSocket = await socketAfterFirstCall(realtime);
    const limit: number = socket.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
    for(let marker: number = 1; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(marker)).catch((): void => undefined);
    }
    let outcome: unknown = 'pending';
    realtime.callUpdateSocket(callOf(WAITING_FIRST)).then(
      (): void => {
        outcome = 'resolved';
      },
      (error: unknown): void => {
        outcome = error;
      }
    );
    await settleChains();

    const callTimeout: number = socket.options.timeout;
    await vi.advanceTimersByTimeAsync(callTimeout - 1);
    expect(outcome, 'a waiting call must still wait before its deadline').toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(outcome, 'a waiting call must reject with the timeout code at its deadline').toMatchObject({
      originalError: {code: TIMEOUT_CODE}
    });
    expect(socket.sent.length, 'a call that timed out while waiting must never have been sent').toBe(limit);
  });

  it('rejects a waiting call as cancelled when its signal aborts, and leaves the queue', async() => {
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    const socket: MockSocket = await socketAfterFirstCall(realtime);
    const limit: number = socket.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
    for(let marker: number = 1; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(marker)).catch((): void => undefined);
    }
    const controller: AbortController = new AbortController();
    const aborted: Promise<unknown> = realtime.callUpdateSocket(callOf(WAITING_FIRST, controller.signal))
      .then((): undefined => undefined, (error: unknown): unknown => error);
    const following: Promise<unknown> = realtime.callUpdateSocket(callOf(WAITING_SECOND));
    following.catch((): void => undefined);
    await settleChains();

    controller.abort();
    expect(await aborted, 'an aborted waiting call must reject as cancelled').toMatchObject({type: 'CANCELED'});

    socket.held[0].settle({data: new Uint8Array([1])});
    await settleChains();

    expect(socket.sent.length, 'the aborted call must leave the queue, so the next waiting call takes its place').toBe(limit + 1);
    expect(socket.sent[limit].data[0], 'the call behind the aborted one must be sent next').toBe(WAITING_SECOND);
  });

  it('releases the call behind a head waiter whose deadline already passed', async() => {
    vi.useFakeTimers();
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    const socket: MockSocket = await socketAfterFirstCall(realtime);
    const limit: number = socket.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
    for(let marker: number = 1; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(marker)).catch((): void => undefined);
    }
    let headOutcome: unknown = 'pending';
    realtime.callUpdateSocket(callOf(WAITING_FIRST)).then(
      (): void => {
        headOutcome = 'resolved';
      },
      (error: unknown): void => {
        headOutcome = error;
      }
    );
    await settleChains();

    // The next waiter arrives later, so its deadline is still ahead when the head's has passed.
    const headDeadlineShift: number = 1_000;
    vi.setSystemTime(Date.now() + headDeadlineShift);
    realtime.callUpdateSocket(callOf(WAITING_SECOND)).catch((): void => undefined);
    await settleChains();

    // The clock passes the head's deadline while its timer has not fired yet.
    vi.setSystemTime(Date.now() + socket.options.timeout - headDeadlineShift + 1);
    socket.held[0].settle({data: new Uint8Array([1])});
    await settleChains();

    expect(headOutcome, 'the head waiter must reject as a timeout once its deadline has passed').toMatchObject({
      originalError: {code: TIMEOUT_CODE}
    });
    expect(
      socket.sent.length,
      'a freed slot must go to the next waiting call even when the head waiter has already expired'
    ).toBe(limit + 1);
    expect(socket.sent[limit].data[0], 'the call behind the expired head must be the one sent').toBe(WAITING_SECOND);
  });

  it('rejects a call beyond the queue bound at once, with the SDK limitExceeded code', async() => {
    vi.useFakeTimers();
    const realtime: typeof import('@lib/impulse/realtime') = await import('@lib/impulse/realtime');
    const socket: MockSocket = await socketAfterFirstCall(realtime);
    const limit: number = socket.options.maxPendingRpc ?? SDK_DEFAULT_MAX_PENDING_RPC;
    for(let marker: number = 1; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(marker)).catch((): void => undefined);
    }
    for(let marker: number = 0; marker < limit; ++marker) {
      realtime.callUpdateSocket(callOf(WAITING_QUEUE_BASE + marker)).catch((): void => undefined);
    }
    await settleChains();

    let overflow: unknown = 'pending';
    realtime.callUpdateSocket(callOf(WAITING_OVERFLOW)).then(
      (): void => {
        overflow = 'resolved';
      },
      (error: unknown): void => {
        overflow = error;
      }
    );
    await settleChains();

    expect(overflow, 'a call beyond the queue bound must reject at once, not wait behind the bound').toMatchObject({
      originalError: {code: LIMIT_EXCEEDED}
    });
    expect(socket.sent.length, 'a rejected call must never be sent').toBe(limit);
  });
});
