import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callMediaFleet, resetFleetIdentity, setFleetConfig, setFleetIdentitySource} from '@lib/impulse/fleet/fleet';
import type {FleetCall, FleetIdentity} from '@lib/impulse/fleet/fleet';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import {installFakeRpcSocket} from './helpers/fakeRpcSocket';
import type {FakeRpcSocketServer, ReceivedRpc} from './helpers/fakeRpcSocket';

const warn = vi.hoisted(() => vi.fn());

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({info: vi.fn(), warn, debug: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

const ACCOUNT: ActiveAccountNumber = 1;
const CURRENT_DC: number = 2;
const SAVE_FILE_PART: string = 'upload.saveFilePart';
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const REGULAR_FILE_FANOUT: number = 72;
const MEDIA_CALL_TIMEOUT_MS: number = 40_000;
const MEDIA_CONNECTIONS_PER_ENDPOINT: number = 3;
const MEDIA_INFLIGHT_PER_CONNECTION: number = 2;
const MEDIA_WINDOW: number = MEDIA_CONNECTIONS_PER_ENDPOINT * MEDIA_INFLIGHT_PER_CONNECTION;
const QUEUED_ROUNDS: number = 8;
const SLOTS_PER_ROUND: number = MEDIA_WINDOW;
const ROUND_REPLY_DELAY_MS: number = 6_000;
const REPLY_DELAY_MS: number = 50;
const WINDOW_REPLY_DELAY_MS: number = 150;
const WINDOW_CALL_COUNT: number = 30;
const SCENARIO_TIMEOUT_MS: number = 60_000;
const IDENTITY_TOKEN: string = 'identity-token-current';

const IDENTITY: FleetIdentity = {kind: 'identity', key: 'identity:0', getToken: async(): Promise<string> => IDENTITY_TOKEN};

let socketServer: FakeRpcSocketServer | undefined;

function mediaConfig(): FleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
    ]
  };
}

function saveFilePartCall(): FleetCall {
  return {accountNumber: ACCOUNT, method: SAVE_FILE_PART, request: REQUEST_BYTES};
}

function rejectionsOf(outcomes: PromiseSettledResult<Uint8Array>[]): unknown[] {
  return outcomes.flatMap((outcome: PromiseSettledResult<Uint8Array>): unknown[] => (
    outcome.status === 'rejected' ? [outcome.reason] : []
  ));
}

function peakInFlight(rpcs: ReceivedRpc[]): number {
  let peak: number = 0;
  for(const rpc of rpcs) {
    const inFlight: number = rpcs.filter((other: ReceivedRpc): boolean => (
      other.arrivedAt <= rpc.arrivedAt && rpc.arrivedAt < (other.repliedAt ?? Infinity)
    )).length;
    peak = Math.max(peak, inFlight);
  }

  return peak;
}

beforeEach(() => {
  resetFleetIdentity(ACCOUNT);
  setFleetIdentitySource(() => IDENTITY);
  setFleetConfig(ACCOUNT, mediaConfig());
  warn.mockClear();
});

afterEach(() => {
  resetFleetIdentity(ACCOUNT);
  socketServer?.restore();
  socketServer = undefined;
});

describe('the media lane of the real SDK pool', () => {
  it('the 72 concurrent file calls of a regular account are all answered, none refused by the pool', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => REPLY_DELAY_MS);
    socketServer = server;

    const outcomes = await Promise.allSettled(
      Array.from({length: REGULAR_FILE_FANOUT}, () => callMediaFleet(saveFilePartCall()))
    );

    expect(
      rejectionsOf(outcomes),
      'every call the regular fan-out issues on one lane is answered: the pool refuses none of them'
    ).toEqual([]);
    expect(server.received, 'every call reaches the fleet endpoint').toHaveLength(REGULAR_FILE_FANOUT);
  }, SCENARIO_TIMEOUT_MS);

  it('a call that waits in the lane queue past MEDIA_CALL_TIMEOUT_MS is answered: the deadline covers the call on the wire only', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => ROUND_REPLY_DELAY_MS);
    socketServer = server;
    const callCount: number = SLOTS_PER_ROUND * QUEUED_ROUNDS;
    const submittedAt: number = Date.now();

    const outcomes = await Promise.allSettled(
      Array.from({length: callCount}, () => callMediaFleet(saveFilePartCall()))
    );

    expect(
      rejectionsOf(outcomes),
      'a call waiting for a slot in the queue is not failed by the wait: each call is answered within its wire time'
    ).toEqual([]);
    const lastArrival: number = Math.max(...server.received.map((rpc: ReceivedRpc): number => rpc.arrivedAt));
    expect(
      lastArrival - submittedAt,
      'the scenario queues a call past MEDIA_CALL_TIMEOUT_MS, so the wait is what the test measures'
    ).toBeGreaterThan(MEDIA_CALL_TIMEOUT_MS);
  }, SCENARIO_TIMEOUT_MS);
});

describe('the media window of the real SDK pool', () => {
  it('at most MEDIA_WINDOW calls are on the wire at once, spread over the connections with at most 2 each', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => WINDOW_REPLY_DELAY_MS);
    socketServer = server;

    const outcomes = await Promise.allSettled(
      Array.from({length: WINDOW_CALL_COUNT}, () => callMediaFleet(saveFilePartCall()))
    );

    expect(rejectionsOf(outcomes), 'every call of the window is answered').toEqual([]);
    expect(peakInFlight(server.received), 'the window carries MEDIA_WINDOW calls at once, and never more').toBe(MEDIA_WINDOW);
    const socketIndexes: number[] = [...new Set(server.received.map((rpc: ReceivedRpc): number => rpc.socketIndex))];
    expect(socketIndexes, 'the window is spread over MEDIA_CONNECTIONS_PER_ENDPOINT connections').toHaveLength(MEDIA_CONNECTIONS_PER_ENDPOINT);
    const peaksPerSocket: number[] = socketIndexes.map((socketIndex: number): number => peakInFlight(
      server.received.filter((rpc: ReceivedRpc): boolean => rpc.socketIndex === socketIndex)
    ));
    expect(
      Math.max(...peaksPerSocket),
      'a connection carries MEDIA_INFLIGHT_PER_CONNECTION calls at most'
    ).toBeLessThanOrEqual(MEDIA_INFLIGHT_PER_CONNECTION);
  }, SCENARIO_TIMEOUT_MS);

  it('a settled call is replaced at once: the window is full before the first reply, and the next call goes on the wire after it', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => WINDOW_REPLY_DELAY_MS);
    socketServer = server;

    await Promise.allSettled(Array.from({length: WINDOW_CALL_COUNT}, () => callMediaFleet(saveFilePartCall())));

    const firstReplyAt: number = Math.min(...server.received.map((rpc: ReceivedRpc): number => rpc.repliedAt ?? Infinity));
    expect(
      server.received.filter((rpc: ReceivedRpc): boolean => rpc.arrivedAt < firstReplyAt),
      'the window of MEDIA_WINDOW calls is on the wire before any of them is answered'
    ).toHaveLength(MEDIA_WINDOW);
    expect(
      server.received[MEDIA_WINDOW].arrivedAt,
      'the call after the window goes on the wire once a call of the window settles'
    ).toBeGreaterThanOrEqual(firstReplyAt);
  }, SCENARIO_TIMEOUT_MS);

  it('a call aborted while it waits for the window is settled as cancelled and never goes on the wire', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => WINDOW_REPLY_DELAY_MS);
    socketServer = server;
    const inWindow: Promise<Uint8Array>[] = Array.from({length: MEDIA_WINDOW}, () => callMediaFleet(saveFilePartCall()));
    const controller: AbortController = new AbortController();

    const waiting: Promise<Uint8Array> = callMediaFleet({...saveFilePartCall(), signal: controller.signal});
    controller.abort();

    await expect(waiting, 'the aborted call settles as cancelled').rejects.toMatchObject({type: 'CANCELED'});
    await Promise.all(inWindow);
    expect(server.received, 'the aborted call never reaches the fleet').toHaveLength(MEDIA_WINDOW);
  }, SCENARIO_TIMEOUT_MS);

  it('retiring the lane answers the calls it has queued: none is failed by the close', async() => {
    const server: FakeRpcSocketServer = installFakeRpcSocket((): number => WINDOW_REPLY_DELAY_MS);
    socketServer = server;
    const calls: Promise<Uint8Array>[] = Array.from({length: WINDOW_CALL_COUNT}, () => callMediaFleet(saveFilePartCall()));

    resetFleetIdentity(ACCOUNT);

    const outcomes = await Promise.allSettled(calls);
    expect(rejectionsOf(outcomes), 'the calls queued on the retired lane are answered before it closes').toEqual([]);
    expect(server.received, 'every queued call reaches the fleet').toHaveLength(WINDOW_CALL_COUNT);
  }, SCENARIO_TIMEOUT_MS);
});
