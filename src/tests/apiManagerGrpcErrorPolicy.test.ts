import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {errorCodes} from '@impulsem/centrifuge/build/protobuf';

import App from '@config/app';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import {setFleetConfig} from '@lib/impulse/fleet/fleet';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
import type {InputFileLocation, MessagesGetDialogs} from '@layer';
import {BoolResponseSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {apiManagerStub, prepareFleetAccount, serverError} from './helpers/apiManagerStub';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: sharedFleetPoolHarness().RpcPoolStub, Centrifuge: sharedUpdateSocketHarness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: vi.fn().mockResolvedValue({userId: 42, impulse_session_token: 'routing-session', impulse_refresh_token: 'refresh'}),
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

const ACCOUNT: ActiveAccountNumber = 1;
const GET_DIALOGS: 'messages.getDialogs' = 'messages.getDialogs';
const SAVE_FILE_PART: 'upload.saveFilePart' = 'upload.saveFilePart';
const GET_FILE: 'upload.getFile' = 'upload.getFile';
const SERVER_INTERNAL_ERROR_CODE: number = 500;
const SERVER_MIGRATE_CODE: number = 303;
const SERVER_FLOOD_CODE: number = 420;
const SERVER_UNAUTHORIZED_CODE: number = 401;
const SERVER_BAD_REQUEST_CODE: number = 400;
const FIRST_SERVER_BACKOFF_MS: number = 1_000;
const SECOND_SERVER_BACKOFF_MS: number = 2_500;
const THIRD_SERVER_BACKOFF_MS: number = 4_750;
const FOURTH_SERVER_BACKOFF_MS: number = 8_125;
const STOP_TIME_MS: number = 5_000;
const LONG_WAIT_MS: number = 60_000;
const CURRENT_DC: number = 2;
const MEDIA_HOST: string = 'media.impulsem.io';
const MEDIA_CONFIG: FleetConfig = {
  this_dc: CURRENT_DC,
  dc_options: [
    {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
    {id: CURRENT_DC, ip_address: MEDIA_HOST, port: 443, pFlags: {media_only: true}}
  ]
};
const APP_CONFIG = {
  upload_premium_speedup_notify_period: 0,
  upload_premium_speedup_upload: 10,
  upload_premium_speedup_download: 10
};
const FILE_PART_PARAMS = {file_id: 1, file_part: 0, file_total_parts: 1, bytes: new Uint8Array([7, 7, 7])};
const GET_FILE_PARAMS = {
  location: {
    _: 'inputDocumentFileLocation',
    id: 1,
    access_hash: 1,
    file_reference: new Uint8Array([1]),
    thumb_size: ''
  } as unknown as InputFileLocation,
  offset: 0,
  limit: 4096
};
const DIALOGS_PARAMS = {} as MessagesGetDialogs;

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();
const dispatchEvent = vi.fn();

function replyWithoutBody(): {data: Uint8Array} {
  return {data: new Uint8Array()};
}

function trueReply(): {data: Uint8Array} {
  return {data: toBinary(BoolResponseSchema, create(BoolResponseSchema, {value: true}))};
}

function callCount(method: string): number {
  return fleetHarness.calls.filter((call): boolean => call.method === method).length +
    socketHarness.calls.filter((call): boolean => call.method === method).length;
}

function outcomeOf(invoke: Promise<unknown>): Promise<unknown> {
  return invoke.catch((error: unknown): unknown => error);
}

async function policyManager() {
  const {setImpulseSessionSignOutHandler} = await import('@lib/impulse/session');
  const fields: Record<string, unknown> = {
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    log: Object.assign(vi.fn(), {error: vi.fn()}),
    rootScope: {dispatchEvent},
    baseDcId: App.baseDcId,
    getAppConfig: vi.fn().mockResolvedValue(APP_CONFIG),
    appStateManager: {getState: vi.fn().mockResolvedValue({}), pushToState: vi.fn()},
    logOut: vi.fn(),
    setBaseDcId: vi.fn(),
    cachedExportPromise: {},
    afterMessageTempIds: {},
    networkerFactory: {unsetConnectionInited: vi.fn()}
  };
  const manager = await apiManagerStub(fields);
  setImpulseSessionSignOutHandler(ACCOUNT, async(): Promise<void> => {
    await manager.logOut();
  });
  return manager;
}

beforeEach(async() => {
  fleetHarness.reset();
  socketHarness.reset();
  dispatchEvent.mockClear();
  await prepareFleetAccount(ACCOUNT, MEDIA_CONFIG);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a flood answer on the media fleet', () => {
  it('a media part answered FLOOD_WAIT_120 is refused at once, with no resend', async() => {
    fleetHarness.respondOnce(SAVE_FILE_PART, () => {
      throw serverError(SERVER_FLOOD_CODE, 'FLOOD_WAIT_120');
    });
    const manager = await policyManager();
    const settled = outcomeOf(manager.invokeApi(SAVE_FILE_PART, FILE_PART_PARAMS, {fileUpload: true}));

    await vi.advanceTimersByTimeAsync(119_999);

    expect(await settled, 'a flood wait over the 60 s floodMaxTimeout is refused, not waited out').toMatchObject({type: 'FLOOD_WAIT_120'});
    expect(callCount(SAVE_FILE_PART), 'the refused part is sent once').toBe(1);
  });

  it('a part answered FLOOD_PREMIUM_WAIT_3 is sent again after 3 s and raises file_speed_limited', async() => {
    fleetHarness.respondOnce(SAVE_FILE_PART, () => {
      throw serverError(SERVER_FLOOD_CODE, 'FLOOD_PREMIUM_WAIT_3');
    });
    fleetHarness.respondOnce(SAVE_FILE_PART, trueReply);
    const manager = await policyManager();
    const invoke = outcomeOf(manager.invokeApi(SAVE_FILE_PART, FILE_PART_PARAMS, {fileUpload: true}));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(callCount(SAVE_FILE_PART), 'the part waits out the 3 s premium flood wait').toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callCount(SAVE_FILE_PART), 'the part is sent again at 3 s').toBe(2);
    expect(await invoke).toBe(true);
    await vi.waitFor((): void => {
      expect(dispatchEvent).toHaveBeenCalledWith('file_speed_limited', {increaseTimes: 10, isUpload: true});
    });
  });
});

describe('a flood answer on the update socket', () => {
  it('a regular method answered FLOOD_WAIT_2 is sent again after 2 s', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => {
      throw serverError(SERVER_FLOOD_CODE, 'FLOOD_WAIT_2');
    });
    socketHarness.respondOnce(GET_DIALOGS, replyWithoutBody);
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(callCount(GET_DIALOGS), 'the regular method waits out its 2 s flood wait').toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callCount(GET_DIALOGS), 'the regular method is sent again at 2 s').toBe(2);
    await expect(invoke).resolves.toBeDefined();
  });
});

describe('a server INTERNAL_SERVER_ERROR on the update socket', () => {
  it('a gRPC INTERNAL_SERVER_ERROR is retried on tweb\'s first backoff of 1 s', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => {
      throw serverError(SERVER_INTERNAL_ERROR_CODE, 'INTERNAL_SERVER_ERROR');
    });
    socketHarness.respondOnce(GET_DIALOGS, replyWithoutBody);
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);

    await vi.advanceTimersByTimeAsync(FIRST_SERVER_BACKOFF_MS - 1);
    expect(callCount(GET_DIALOGS), 'the first retry waits the 1 s backoff').toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(callCount(GET_DIALOGS), 'the second send follows the 1 s backoff').toBe(2);
    await expect(invoke).resolves.toBeDefined();
  });

  it('a persistent INTERNAL_SERVER_ERROR keeps being retried on the capped backoff', async() => {
    socketHarness.respond(GET_DIALOGS, () => {
      throw serverError(SERVER_INTERNAL_ERROR_CODE, 'INTERNAL_SERVER_ERROR');
    });
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(FIRST_SERVER_BACKOFF_MS);
    expect(callCount(GET_DIALOGS), 'the second send lands at 1 000 ms').toBe(2);
    await vi.advanceTimersByTimeAsync(SECOND_SERVER_BACKOFF_MS - FIRST_SERVER_BACKOFF_MS);
    expect(callCount(GET_DIALOGS), 'the third send lands at 2 500 ms').toBe(3);
    await vi.advanceTimersByTimeAsync(THIRD_SERVER_BACKOFF_MS - SECOND_SERVER_BACKOFF_MS);
    expect(callCount(GET_DIALOGS), 'the fourth send lands at 4 750 ms').toBe(4);

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'without a stopTime the 500 is retried beyond the fourth send').toBeGreaterThan(4);
    invoke.cancel();
    expect(await settled).toMatchObject({type: 'CANCELED'});
  });

  it('a persistent INTERNAL_SERVER_ERROR stops once stopTime passes', async() => {
    socketHarness.respond(GET_DIALOGS, () => {
      throw serverError(SERVER_INTERNAL_ERROR_CODE, 'INTERNAL_SERVER_ERROR');
    });
    const manager = await policyManager();
    const settled = outcomeOf(manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS, {stopTime: Date.now() + STOP_TIME_MS}));

    await vi.advanceTimersByTimeAsync(FOURTH_SERVER_BACKOFF_MS);
    expect(callCount(GET_DIALOGS), 'five sends: 0, 1 000, 2 500, 4 750 and 8 125 ms').toBe(5);
    expect(await settled, 'the 500 is rethrown once stopTime has passed').toMatchObject({type: 'INTERNAL_SERVER_ERROR'});

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'no send after 8 125 ms').toBe(5);
  });

  it('cancelling during a 500 pause stops the resend', async() => {
    socketHarness.respond(GET_DIALOGS, () => {
      throw serverError(SERVER_INTERNAL_ERROR_CODE, 'INTERNAL_SERVER_ERROR');
    });
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(1_200);
    invoke.cancel();
    expect(await settled, 'the cancel lands inside the 1 500 ms pause').toMatchObject({type: 'CANCELED'});

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'the cancelled pause sends nothing more').toBe(2);
  });
});

describe('a cancel of a gRPC call', () => {
  it('cancelling during a flood pause stops the resend', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => {
      throw serverError(SERVER_FLOOD_CODE, 'FLOOD_WAIT_30');
    });
    socketHarness.respondOnce(GET_DIALOGS, replyWithoutBody);
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(1_000);
    invoke.cancel();
    expect(await settled).toMatchObject({type: 'CANCELED'});

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'the flood pause sends nothing after the cancel').toBe(1);
  });

  it('cancelling during a transport backoff stops the resend (#1079 item 2)', async() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fleetHarness.respondOnce(SAVE_FILE_PART, () => {
      throw {code: errorCodes.timeout, message: 'timeout'};
    });
    fleetHarness.respondOnce(SAVE_FILE_PART, trueReply);
    const manager = await policyManager();
    const invoke = manager.invokeApi(SAVE_FILE_PART, FILE_PART_PARAMS, {fileUpload: true});
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(100);
    invoke.cancel();
    expect(await settled, 'the cancel lands inside the 250 ms transport backoff').toMatchObject({type: 'CANCELED'});

    await vi.advanceTimersByTimeAsync(5_000);
    expect(callCount(SAVE_FILE_PART), 'the cancelled backoff sends nothing more').toBe(1);
  });

  it('the transport retry still resends an SDK timeout for a media method', async() => {
    fleetHarness.respondOnce(SAVE_FILE_PART, () => {
      throw {code: errorCodes.timeout, message: 'timeout'};
    });
    fleetHarness.respondOnce(SAVE_FILE_PART, trueReply);
    const manager = await policyManager();
    const invoke = outcomeOf(manager.invokeApi(SAVE_FILE_PART, FILE_PART_PARAMS, {fileUpload: true}));

    await vi.advanceTimersByTimeAsync(1);
    expect(await invoke).toBe(true);
    expect(callCount(SAVE_FILE_PART)).toBe(2);
  });

  it('cancelling an invoke in flight rejects it and resends nothing', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => new Promise<never>((): void => {}));
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS);
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(100);
    invoke.cancel();
    expect(await settled, 'the cancel rejects the call in flight').toMatchObject({type: 'CANCELED'});

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'the cancelled call is not sent again').toBe(1);
  });
});

describe('an authorization or migration answer on gRPC', () => {
  it('a CONNECTION_NOT_INITED that survives the adapter\'s replay reaches the caller', async() => {
    socketHarness.respond(GET_DIALOGS, () => {
      throw serverError(SERVER_BAD_REQUEST_CODE, 'CONNECTION_NOT_INITED');
    });
    const manager = await policyManager();

    await expect(manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS)).rejects.toMatchObject({type: 'CONNECTION_NOT_INITED'});
    expect(callCount(GET_DIALOGS), 'the original call and the one replay of the adapter').toBe(2);
  });

  it('a FILE_MIGRATE_2 on upload.getFile is re-sent to DC 2\'s media endpoint', async() => {
    setFleetConfig(ACCOUNT, {
      this_dc: 1,
      dc_options: [
        {id: 1, ip_address: 'media-1.example.org', port: 443, pFlags: {media_only: true}},
        {id: 2, ip_address: 'media-2.example.org', port: 443, pFlags: {media_only: true}}
      ]
    });
    fleetHarness.respondOnce(GET_FILE, () => {
      throw serverError(SERVER_MIGRATE_CODE, 'FILE_MIGRATE_2', {'migrate-dc': '2'});
    });
    fleetHarness.respondOnce(GET_FILE, replyWithoutBody);
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_FILE, GET_FILE_PARAMS, {});

    await vi.advanceTimersByTimeAsync(1);
    await expect(invoke).resolves.toBeDefined();
    const sends = fleetHarness.calls.filter((call): boolean => call.method === GET_FILE);
    expect(sends, 'the migrate answer is followed by one more send').toHaveLength(2);
    expect(sends[1].endpoint, 'the second send goes to DC 2\'s media endpoint').toBe(`wss://media-2.example.org:443${FLEET_CONNECTION_PATH}`);
  });

  it('a FILE_MIGRATE_2 answered again by DC 2 reaches the caller after two sends', async() => {
    setFleetConfig(ACCOUNT, {
      this_dc: 1,
      dc_options: [
        {id: 1, ip_address: 'media-1.example.org', port: 443, pFlags: {media_only: true}},
        {id: 2, ip_address: 'media-2.example.org', port: 443, pFlags: {media_only: true}}
      ]
    });
    fleetHarness.respond(GET_FILE, () => {
      throw serverError(SERVER_MIGRATE_CODE, 'FILE_MIGRATE_2', {'migrate-dc': '2'});
    });
    const manager = await policyManager();
    const invoke = manager.invokeApi(GET_FILE, GET_FILE_PARAMS, {});

    await vi.advanceTimersByTimeAsync(1);
    await expect(invoke).rejects.toMatchObject({type: 'FILE_MIGRATE_2', code: SERVER_MIGRATE_CODE});
    expect(callCount(GET_FILE)).toBe(2);
  });

  it('a FILE_MIGRATE_2 with no media option for DC 2 reaches the caller without a re-send', async() => {
    setFleetConfig(ACCOUNT, {
      this_dc: 1,
      dc_options: [{id: 1, ip_address: 'media-1.example.org', port: 443, pFlags: {media_only: true}}]
    });
    fleetHarness.respond(GET_FILE, () => {
      throw serverError(SERVER_MIGRATE_CODE, 'FILE_MIGRATE_2', {'migrate-dc': '2'});
    });
    const manager = await policyManager();

    await expect(manager.invokeApi(GET_FILE, GET_FILE_PARAMS, {})).rejects.toMatchObject({type: 'FILE_MIGRATE_2', code: SERVER_MIGRATE_CODE});
    expect(callCount(GET_FILE), 'no media endpoint for DC 2 means no extra request').toBe(1);
  });

  it('an unmapped server error type is not retried every second', async() => {
    socketHarness.respond(GET_DIALOGS, () => {
      throw serverError(SERVER_BAD_REQUEST_CODE, 'UNKNOWN');
    });
    const manager = await policyManager();
    const settled = outcomeOf(manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS));

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);
    expect(callCount(GET_DIALOGS), 'an UNKNOWN answer is sent once').toBe(1);
    expect(await settled).toMatchObject({type: 'UNKNOWN'});
  });
});

describe('the error log of a gRPC call', () => {
  it('the performRequest error log carries method, code and type only', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => {
      throw serverError(SERVER_BAD_REQUEST_CODE, 'PASSWORD_HASH_INVALID');
    });
    const manager = await policyManager();
    const params = {password: {secret_marker: 'S3CRET'}} as unknown as MessagesGetDialogs;

    await expect(manager.invokeApi(GET_DIALOGS, params)).rejects.toMatchObject({type: 'PASSWORD_HASH_INVALID'});
    expect(manager.log.error).toHaveBeenCalledWith('Error', SERVER_BAD_REQUEST_CODE, 'PASSWORD_HASH_INVALID', GET_DIALOGS);
    expect(JSON.stringify(vi.mocked(manager.log.error).mock.calls), 'the request params never reach the log').not.toContain('S3CRET');
  });

  it('the watchdog of a call still in flight logs its method and elapsed time only', async() => {
    socketHarness.respondOnce(GET_DIALOGS, (): Promise<never> => new Promise<never>((): void => {}));
    const manager = await policyManager();
    const params = {password: {secret_marker: 'S3CRET'}} as unknown as MessagesGetDialogs;
    const invoke = manager.invokeApi(GET_DIALOGS, params);
    const settled = outcomeOf(invoke);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.mocked(manager.log.error).mock.calls.length, 'the watchdog reports the call still in flight after 5 s').toBeGreaterThan(0);
    expect(JSON.stringify(vi.mocked(manager.log.error).mock.calls), 'the watchdog logs no request params').not.toContain('S3CRET');
    expect(manager.log.error, 'the watchdog names the method and the elapsed time').toHaveBeenCalledWith('Request is still processing:', GET_DIALOGS, 'time:', 5);

    invoke.cancel();
    expect(await settled).toMatchObject({type: 'CANCELED'});
  });
});

describe('a file call whose published config names no media option', () => {
  it('is refused to the caller once, as a client error, and is not sent again', async() => {
    setFleetConfig(ACCOUNT, {this_dc: CURRENT_DC, dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]});
    const manager = await policyManager();
    const outcome: {error?: unknown} = {};
    void outcomeOf(manager.invokeApi(GET_FILE, GET_FILE_PARAMS, {})).then((error: unknown): void => {
      outcome.error = error;
    });

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);

    expect(outcome.error, 'the refusal reaches the caller at once, not after retries').toMatchObject({
      type: 'FLEET_MEDIA_OPTION_MISSING',
      message: `${GET_FILE} has no media_only dcOption in the published config to travel`
    });
    expect(callCount(GET_FILE), 'no carrier is opened for a call the config cannot route').toBe(0);
    expect(vi.mocked(manager.log.error).mock.calls.length, 'the refused call is attempted once').toBe(1);
  });
});

// A 401 on the session marks its token refused, so every later call of the account renews it over the network. It runs last
// so that no other case inherits the refused session.
describe('a 401 on the session of the account', () => {
  it('a 401 with a set baseDcId is not re-authorised on another DC and reaches rejectPromise', async() => {
    socketHarness.respondOnce(GET_DIALOGS, () => {
      throw serverError(SERVER_UNAUTHORIZED_CODE, 'AUTH_KEY_UNREGISTERED');
    });
    const manager = await policyManager();
    const invokeSpy = vi.spyOn(manager, 'invokeApi');

    await expect(manager.invokeApi(GET_DIALOGS, DIALOGS_PARAMS)).rejects.toMatchObject({type: 'AUTH_KEY_UNREGISTERED'});
    expect(invokeSpy.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([GET_DIALOGS]);
  });
});
