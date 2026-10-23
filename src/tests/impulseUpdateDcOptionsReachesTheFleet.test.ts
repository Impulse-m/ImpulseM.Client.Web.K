import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {UploadFileSchema, UploadFileValueSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {FLEET_CONNECTION_PATH} from '@lib/impulse/fleet/fleetPath';
import type {FleetConfig, FleetDcOption} from '@lib/impulse/fleet/fleetRoute';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * The server changes the data center options with updateDcOptions, which carries the changed dc_options only
 * (api/updates.md:17-18, constructor/updateDcOptions.md). The client applies them to its media fleet with the this_dc of
 * the config it holds. A file query issued before the config publishes waits for that publication.
 */

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('./helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('./helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

const ACCOUNT: ActiveAccountNumber = 1;
const CURRENT_DC: number = 2;
const GET_FILE: string = 'upload.getFile';
const GET_FILE_PARAMS = {offset: 0, limit: 1024};
const FILE_PAYLOAD: Uint8Array = new Uint8Array([7, 7, 7]);
const FIRST_MEDIA_URL: string = `wss://media.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const SECOND_MEDIA_URL: string = `wss://media-2.impulsem.io:443${FLEET_CONNECTION_PATH}`;
const UPDATE_LISTENER_MISSING: string =
  'ApiManager must route updateDcOptions to the media fleet beside updateConfig: no listener is registered for it';

type DcOptionUpdate = {_: 'updateDcOptions', dc_options: FleetDcOption[]};
type ListenerMap = Record<string, (update: DcOptionUpdate) => void>;

function dcOptionsOf(mediaHost: string): FleetDcOption[] {
  return [
    {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
    {id: CURRENT_DC, ip_address: mediaHost, port: 443, pFlags: {media_only: true}}
  ];
}

function updateDcOptions(mediaHost: string): DcOptionUpdate {
  return {_: 'updateDcOptions', dc_options: dcOptionsOf(mediaHost)};
}

function uploadedFile(): {data: Uint8Array} {
  return {
    data: toBinary(UploadFileSchema, create(UploadFileSchema, {
      value: {case: 'uploadFile', value: create(UploadFileValueSchema, {bytes: FILE_PAYLOAD})}
    }))
  };
}

/** A receiver shaped as ApiManager is when after() runs: its cached config, its root scope and its update listeners. */
function managerStub(listeners: {current: ListenerMap}, cachedConfig: FleetConfig | undefined): Record<string, unknown> {
  return {
    config: cachedConfig,
    getConfig: vi.fn(),
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    rootScope: {addEventListener: vi.fn(), dispatchEvent: vi.fn()},
    appStateManager: {getState: vi.fn(async() => ({appConfig: undefined}))},
    apiUpdatesManager: {
      addMultipleEventsListeners: (map: ListenerMap): void => {
        listeners.current = map;
      }
    }
  };
}

async function bootManager(
  cachedConfig: FleetConfig | undefined
): Promise<{manager: Record<string, unknown>, listeners: {current: ListenerMap}}> {
  const {ApiManager} = await import('@appManagers/apiManager');
  const listeners: {current: ListenerMap} = {current: {}};
  const manager = managerStub(listeners, cachedConfig);
  (ApiManager.prototype as unknown as {after(): unknown}).after.call(manager);
  return {manager, listeners};
}

function dispatchUpdate(listeners: {current: ListenerMap}, update: DcOptionUpdate): void {
  const handler = listeners.current[update._];
  expect(handler, UPDATE_LISTENER_MISSING).toBeTypeOf('function');
  handler(update);
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
});

describe('a media_only option arriving by updateDcOptions reaches the media fleet', () => {
  it('releases a file call waiting for the config, and later file calls go to the endpoint of the newer update', async() => {
    const {listeners} = await bootManager({this_dc: CURRENT_DC, dc_options: []});
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {fleetConfigWaiters} = await import('@lib/impulse/fleet/fleet');
    fleetHarness.respondOnce(GET_FILE, uploadedFile);
    fleetHarness.respondOnce(GET_FILE, uploadedFile);

    const first = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);
    await vi.waitFor(() => expect(fleetConfigWaiters(ACCOUNT), 'the file call waits for the config').toBe(1));
    dispatchUpdate(listeners, updateDcOptions('media.impulsem.io'));

    await expect(first, 'the update releases the waiting file call').resolves.toMatchObject({bytes: FILE_PAYLOAD});
    expect(fleetHarness.calls.map((call) => call.endpoint), 'the waiting call goes to the endpoint the update names')
      .toEqual([FIRST_MEDIA_URL]);

    dispatchUpdate(listeners, updateDcOptions('media-2.impulsem.io'));
    await grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);

    expect(fleetHarness.calls[1].endpoint, 'a later file call goes to the endpoint of the newer update').toBe(SECOND_MEDIA_URL);
  });

  it('applies the update at once, then re-reads the config: the answer, not the update, names the endpoint later calls use', async() => {
    const {manager, listeners} = await bootManager({this_dc: CURRENT_DC, dc_options: []});
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {fleetConfigWaiters, setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    const refetched: FleetConfig = {this_dc: CURRENT_DC, dc_options: dcOptionsOf('media-2.impulsem.io')};
    let publishRefetch: (() => void) | undefined;
    (manager.getConfig as ReturnType<typeof vi.fn>).mockImplementation((): void => {
      publishRefetch = (): void => setFleetConfig(ACCOUNT, refetched);
    });
    fleetHarness.respondOnce(GET_FILE, uploadedFile);
    fleetHarness.respondOnce(GET_FILE, uploadedFile);

    const first = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);
    await vi.waitFor(() => expect(fleetConfigWaiters(ACCOUNT), 'the file call waits for the config').toBe(1));
    dispatchUpdate(listeners, updateDcOptions('media.impulsem.io'));

    await expect(first, 'the update releases the waiting file call').resolves.toMatchObject({bytes: FILE_PAYLOAD});
    expect(fleetHarness.calls.map((call) => call.endpoint), 'the waiting call goes to the endpoint the update names')
      .toEqual([FIRST_MEDIA_URL]);

    expect(publishRefetch, 'the update re-requests help.getConfig, and the answer carries the config later calls use').toBeTypeOf('function');
    publishRefetch?.();
    await grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);

    expect(fleetHarness.calls[1].endpoint, 'a call after the re-read config goes to the endpoint that config names')
      .toBe(SECOND_MEDIA_URL);
  });

  it('without a cached config, the update re-reads the config, and the file call goes to the media option it publishes', async() => {
    const {manager, listeners} = await bootManager(undefined);
    const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const fetched: FleetConfig = {this_dc: CURRENT_DC, dc_options: dcOptionsOf('media.impulsem.io')};
    (manager.getConfig as ReturnType<typeof vi.fn>).mockImplementation((): void => {
      setFleetConfig(ACCOUNT, fetched);
    });
    fleetHarness.respondOnce(GET_FILE, uploadedFile);

    const reply = grpcInvoke(GET_FILE, GET_FILE_PARAMS, ACCOUNT);
    dispatchUpdate(listeners, updateDcOptions('media.impulsem.io'));

    await expect(reply, 'the file call completes once the config is re-read').resolves.toMatchObject({bytes: FILE_PAYLOAD});
    expect(fleetHarness.calls.map((call) => call.endpoint)).toEqual([FIRST_MEDIA_URL]);
  });
});
