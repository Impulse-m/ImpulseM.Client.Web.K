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
const MEDIA_CALL_TIMEOUT_MS: number = 10_000;
const QUEUED_ROUNDS: number = 5;
const SLOTS_PER_ROUND: number = 4;
const ROUND_REPLY_DELAY_MS: number = 3_000;
const REPLY_DELAY_MS: number = 50;
const SCENARIO_TIMEOUT_MS: number = 40_000;
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
