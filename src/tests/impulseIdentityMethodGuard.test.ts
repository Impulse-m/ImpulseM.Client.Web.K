import {expect, it, vi} from 'vitest';
import {accessToken, emptyReply, loadIdentityHarness, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

vi.mock('@appManagers/appStoragesManager', () => ({AppStoragesManager: {shiftStorages: vi.fn()}}));
vi.mock('@lib/passcode/deferredIsUsingPasscode', () => ({default: {isUsingPasscode: async(): Promise<boolean> => false}}));

const login: string[] = ['auth.sendCode', 'auth.cancelCode', 'auth.signIn', 'auth.signUp', 'auth.requestFirebaseSms', 'auth.resetLoginEmail', 'auth.reportMissingCode', 'auth.checkPaidAuth', 'auth.importBotAuthorization', 'auth.importWebTokenAuthorization', 'auth.exportLoginToken', 'auth.importLoginToken', 'auth.initPasskeyLogin', 'auth.finishPasskeyLogin'];
const allowed: string[] = [...login, 'auth.resendCode', 'account.sendVerifyEmailCode', 'account.verifyEmail', 'auth.checkPassword', 'auth.requestPasswordRecovery', 'auth.recoverPassword', 'auth.checkRecoveryPassword', 'account.getPassword', 'initConnection', 'connectionIdentity', 'refreshSession', 'help.getConfig', 'help.getAppConfig', 'help.getNearestDc', 'help.getCountriesList', 'help.getDeepLinkInfo', 'help.saveAppLog', 'langpack.getLangPack', 'langpack.getStrings', 'langpack.getDifference', 'langpack.getLanguage', 'langpack.getLanguages', 'account.deleteAccount'];

it.each([true, false])('refuses identity user methods locally (DEV=%s)', async(dev: boolean) => {
  vi.stubEnv('DEV', dev);
  const client = await loadIdentityHarness();
  sockets.respond('messages.getDialogs', emptyReply);
  const call: Promise<Uint8Array> = client.callUpdateSocket({accountNumber: 1, method: 'messages.getDialogs', request: new Uint8Array()});
  if(dev) {
    await expect(call).rejects.toThrow(/identity.*messages.getDialogs/);
  } else {
    await expect(call).rejects.toMatchObject({type: 'CLIENT_METHOD_REFUSED', code: 0});
  }
  expect(sockets.calls).toHaveLength(0);
});

it('allows every identity-set method', async() => {
  const client = await loadIdentityHarness();
  for(const method of allowed) {
    sockets.respond(method, emptyReply);
    await client.callUpdateSocket({accountNumber: 1, method, request: new Uint8Array()});
  }
  expect(sockets.calls.map((call) => call.method)).toEqual(allowed);
});

it.each([true, false])('refuses every login-only method on a session (DEV=%s)', async(dev: boolean) => {
  vi.stubEnv('DEV', dev);
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  for(const method of login) {
    sockets.respond(method, emptyReply);
    const call: Promise<Uint8Array> = client.callUpdateSocket({accountNumber: 1, method, request: new Uint8Array()});
    if(dev) {
      await expect(call).rejects.toThrow(new RegExp(`session.*${method}`));
    } else {
      await expect(call).rejects.toMatchObject({type: 'CLIENT_METHOD_REFUSED', code: 0});
    }
  }
  expect(sockets.calls).toHaveLength(0);
  sockets.respond('messages.getDialogs', emptyReply);
  await client.callUpdateSocket({accountNumber: 1, method: 'messages.getDialogs', request: new Uint8Array()});
  expect(sockets.calls.map((call) => call.method)).toEqual(['messages.getDialogs']);
});

it('skips auth.logOut when the slot has no session even if old DC keys remain', async() => {
  await loadIdentityHarness();
  const {ApiManager} = await import('@appManagers/apiManager');
  storage.get.mockResolvedValue({dc2_auth_key: 'old'});
  const invokeApi = vi.fn().mockResolvedValue(true);
  const manager = Object.assign(Object.create(ApiManager.prototype), {
    getAccountNumber: () => 1,
    invokeApi,
    rootScope: {dispatchEvent: vi.fn()}
  });
  await manager.logOut();
  expect(invokeApi).not.toHaveBeenCalled();
  expect(storage.clearFields).toHaveBeenCalledWith(1, ['impulse_session_token', 'impulse_refresh_token']);
});

it('skips cancelled web-token imports without a session', async() => {
  await loadIdentityHarness();
  const {default: AppAccountManager} = await import('@appManagers/appAccountManager');
  const invokeApi = vi.fn().mockResolvedValue(true);
  const manager = Object.assign(new AppAccountManager(), {
    getAccountNumber: () => 1,
    apiManager: {invokeApi},
    log: {error: vi.fn()}
  });
  manager.cancelWebTokenAuthorization('abandoned-import', 2);
  expect(invokeApi).not.toHaveBeenCalled();
});
