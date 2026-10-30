import {beforeEach, describe, expect, it, vi} from 'vitest';
import {setAppStateSilent, starsUiBlocked, giftsBlocked} from '@stores/appState';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import {sharedFleetPoolHarness} from './helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

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

const ACCOUNT: ActiveAccountNumber = 1;
const HELP_GET_APP_CONFIG: string = 'help.getAppConfig';

type ConfigListener = (update: {_: 'updateConfig'}) => void;

const socketHarness = sharedUpdateSocketHarness();
const fleetHarness = sharedFleetPoolHarness();

/** A receiver shaped as ApiManager is when after() runs, with the real getAppConfig and the server answer behind it. */
function managerStub(
  listeners: {current: Record<string, ConfigListener>},
  serverAppConfig: Record<string, unknown>
): Record<string, any> {
  const manager: Record<string, any> = {
    appConfig: undefined,
    requestedAppConfig: false,
    getConfig: vi.fn(),
    startRealtimeBringUp: vi.fn(),
    getAccountNumber: (): ActiveAccountNumber => ACCOUNT,
    rootScope: {addEventListener: vi.fn(), dispatchEvent: vi.fn()},
    appStateManager: {
      getState: vi.fn(async() => ({appConfig: undefined})),
      pushToState: (key: string, value: unknown) => setAppStateSilent(key as 'appConfig', value as any)
    },
    apiUpdatesManager: {
      addMultipleEventsListeners: (map: Record<string, ConfigListener>): void => {
        listeners.current = map;
      }
    },
    invokeApiSingleProcess: vi.fn(async({processResult}: {processResult: (answer: unknown) => unknown}) => {
      return processResult({_: 'help.appConfig', hash: 7, config: serverAppConfig});
    })
  };
  return manager;
}

async function bootManager(serverAppConfig: Record<string, unknown>) {
  const {ApiManager} = await import('@appManagers/apiManager');
  const listeners: {current: Record<string, ConfigListener>} = {current: {}};
  const manager = managerStub(listeners, serverAppConfig);
  const prototype: Record<string, unknown> = ApiManager.prototype as unknown as Record<string, unknown>;
  manager.getAppConfig = prototype.getAppConfig;
  manager.applyAppConfig = prototype.applyAppConfig;
  (ApiManager.prototype as unknown as {after(): unknown}).after.call(manager);
  return {manager, listeners};
}

beforeEach(async() => {
  vi.resetModules();
  fleetHarness.reset();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue({userId: 42, impulse_session_token: 'fixture-session'});
  setAppStateSilent('appConfig', {
    stars_purchase_blocked: true,
    stargifts_blocked: true,
    stars_gifts_enabled: false
  });
});

describe('an updateConfig update refetches the app config and the gates follow', () => {
  it('asks the server for the app config again and the switches read the new answer', async() => {
    const {manager, listeners} = await bootManager({
      stars_purchase_blocked: false,
      stargifts_blocked: false,
      stars_gifts_enabled: true
    });
    expect(starsUiBlocked()).toBe(true);
    expect(giftsBlocked()).toBe(true);

    listeners.current.updateConfig({_: 'updateConfig'});

    await vi.waitFor(() => expect(starsUiBlocked(), 'the refetched config unblocks Stars').toBe(false));
    expect(giftsBlocked(), 'the refetched config unblocks gifts').toBe(false);
    expect(manager.invokeApiSingleProcess).toHaveBeenCalledWith(expect.objectContaining({method: HELP_GET_APP_CONFIG}));
  });
});
