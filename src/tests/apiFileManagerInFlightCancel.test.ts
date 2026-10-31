import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import deferredPromise from '@helpers/cancellablePromise';
import {ApiFileManager} from '@appManagers/apiFileManager';
import type {DownloadOptions} from '@appManagers/apiFileManager';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {FleetConfig} from '@lib/impulse/fleet/fleetRoute';
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
const SAVE_FILE_PART: string = 'upload.saveFilePart';
const GET_FILE: string = 'upload.getFile';
const TWO_MIB: number = 2 * 1024 * 1024;
const FIRST_WAVE_PARTS: number = 4;
const DOWNLOAD_CANCEL_MS: number = 1_000;
const LONG_WAIT_MS: number = 60_000;
const CURRENT_DC: number = 2;
const MEDIA_CONFIG: FleetConfig = {
  this_dc: CURRENT_DC,
  dc_options: [
    {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
    {id: CURRENT_DC, ip_address: 'media.impulsem.io', port: 443, pFlags: {media_only: true}}
  ]
};
const DOCUMENT_LOCATION = {
  _: 'inputDocumentFileLocation',
  id: 1,
  access_hash: 1,
  file_reference: new Uint8Array([1]),
  thumb_size: ''
} as unknown as DownloadOptions['location'];

const fleetHarness = sharedFleetPoolHarness();
const socketHarness = sharedUpdateSocketHarness();

function callCount(method: string): number {
  return fleetHarness.calls.filter((call): boolean => call.method === method).length +
    socketHarness.calls.filter((call): boolean => call.method === method).length;
}

function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown): unknown => error);
}

async function advanceUntilSent(method: string, count: number): Promise<void> {
  for(let step: number = 0; step < 1_000 && callCount(method) < count; ++step) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

function fileManagerOf(apiManager: unknown): ApiFileManager {
  const writer = {write: vi.fn(), trim: vi.fn(), finalize: vi.fn()};
  const manager = Object.create(ApiFileManager.prototype) as ApiFileManager;
  return Object.assign(manager, {
    apiManager,
    log: Object.assign(vi.fn(), {bindPrefix: (): ReturnType<typeof vi.fn> => vi.fn(), error: vi.fn()}),
    tempId: 0,
    queueId: 0,
    debug: false,
    maxUploadParts: 4000,
    downloadPromises: {},
    uploadPromises: {},
    downloadPulls: {},
    downloadActives: {},
    requestFilePartReferences: new Map(),
    refreshReferencePromises: {},
    rootScope: {dispatchEvent: vi.fn(), premium: false},
    cacheStorage: {
      getFile: vi.fn((): Promise<Blob> => Promise.reject(new Error('NO_ENTRY_FOUND'))),
      prepareWriting: vi.fn(() => ({deferred: deferredPromise<Blob>(), getWriter: (): typeof writer => writer}))
    }
  });
}

beforeEach(async() => {
  fleetHarness.reset();
  socketHarness.reset();
  await prepareFleetAccount(ACCOUNT, MEDIA_CONFIG);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('cancelling a file transfer with its parts in flight', () => {
  it('cancelling an upload with four parts in flight sends none of them again', async() => {
    fleetHarness.respond(SAVE_FILE_PART, () => {
      throw serverError(420, 'FLOOD_WAIT_5');
    });
    const manager = await apiManagerStub({
      getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      rootScope: {dispatchEvent: vi.fn()}
    });
    const fileManager = fileManagerOf(manager);
    const upload = fileManager.upload({file: new Blob([new Uint8Array(TWO_MIB)]), fileName: 'two-mib.bin'});
    const settled = outcomeOf(upload);

    await advanceUntilSent(SAVE_FILE_PART, FIRST_WAVE_PARTS);
    expect(callCount(SAVE_FILE_PART), 'the four parts of the first wave are in flight').toBe(FIRST_WAVE_PARTS);

    upload.cancel();
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);

    expect(callCount(SAVE_FILE_PART), 'the paused parts are not sent again after the cancel').toBe(FIRST_WAVE_PARTS);
    expect(await settled).toMatchObject({type: 'UPLOAD_CANCELED'});
  });

  it('cancelling a download with its parts paused for a flood sends no further getFile', async() => {
    fleetHarness.respond(GET_FILE, () => {
      throw serverError(420, 'FLOOD_WAIT_30');
    });
    const manager = await apiManagerStub({
      getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      rootScope: {dispatchEvent: vi.fn()}
    });
    const fileManager = fileManagerOf(manager);
    const download = fileManager.download({dcId: CURRENT_DC, location: DOCUMENT_LOCATION, size: TWO_MIB, mimeType: 'application/pdf'});
    const settled = outcomeOf(download);

    await vi.advanceTimersByTimeAsync(DOWNLOAD_CANCEL_MS);
    expect(callCount(GET_FILE), 'the four parts of the first wave are in flight').toBe(FIRST_WAVE_PARTS);

    download.cancel();
    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS);

    expect(callCount(GET_FILE), 'the flood-paused parts send no getFile after the cancel').toBe(FIRST_WAVE_PARTS);
    expect(await settled).toMatchObject({type: 'DOWNLOAD_CANCELED'});
  });
});
