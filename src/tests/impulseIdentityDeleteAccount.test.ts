import {expect, it, vi} from 'vitest';
import {fromBinary} from '@bufbuild/protobuf';
import type {ApiManager} from '@appManagers/apiManager';
import type AppAccountManager from '@appManagers/appAccountManager';
import {DeleteAccountRequestSchema} from '@lib/impulse/grpc/gen/account_pb';
import type {DeleteAccountRequest} from '@lib/impulse/grpc/gen/account_pb';
import type {UpdateSocketCallRecord} from '@/tests/helpers/updateSocketStub';
import {identityDeclaration} from '@/tests/helpers/identityFixtures';
import {
  emptyReply,
  identityToken,
  loadIdentityHarness,
  pools,
  setupIdentityHarness,
  sockets,
  storage
} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('resets an account on the pending 2FA identity without a password and preserves it on 2FA_CONFIRM_WAIT_5', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  const {ApiManager} = await import('@appManagers/apiManager');
  const {default: AppAccountManager} = await import('@appManagers/appAccountManager');
  const logOut = vi.fn(async(): Promise<void> => client.clearImpulseSession(1));
  const apiManager: ApiManager = Object.assign(Object.create(ApiManager.prototype), {
    getAccountNumber: (): number => 1,
    logOut
  });
  const manager: AppAccountManager = Object.assign(Object.create(AppAccountManager.prototype), {apiManager});
  client.setImpulseSessionSignOutHandler(1, logOut);
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.signIn', (): never => {
    throw {code: 100, appCode: 401, appType: 'SESSION_PASSWORD_NEEDED'};
  });
  sockets.respond('account.deleteAccount', (): never => {
    throw {code: 100, appCode: 400, appType: '2FA_CONFIRM_WAIT_5'};
  });
  sockets.respond('account.getPassword', emptyReply);
  await expect(apiManager.invokeApi('auth.signIn', {
    phone_number: '+12025550123',
    phone_code_hash: 'code-hash',
    phone_code: '12345'
  })).rejects.toMatchObject({
    type: 'SESSION_PASSWORD_NEEDED',
    socketKind: 'identity'
  });
  const identityKey: string = client.fleetIdentityFor(1).key;

  await expect(manager.deleteAccount('Forgot password')).rejects.toMatchObject({
    type: '2FA_CONFIRM_WAIT_5',
    code: 400,
    socketKind: 'identity',
    socketKey: identityKey
  });
  await vi.advanceTimersByTimeAsync(100);

  const deletion: UpdateSocketCallRecord = sockets.calls.find(
    (call: UpdateSocketCallRecord): boolean => call.method === 'account.deleteAccount'
  );
  expect(deletion.presentedToken).toBe(identityToken);
  const request: DeleteAccountRequest = fromBinary(DeleteAccountRequestSchema, deletion.data);
  expect(request.reason).toBe('Forgot password');
  expect(request.password).toBeUndefined();
  await apiManager.invokeApi('account.getPassword');
  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual([
    'initConnection',
    'auth.signIn',
    'account.deleteAccount',
    'account.getPassword'
  ]);
  expect(sockets.calls.every((call: UpdateSocketCallRecord): boolean => call.presentedToken === identityToken)).toBe(true);
  expect(pools.calls.map((call): string => call.method)).toEqual(['connectionIdentity']);
  expect(sockets.sockets).toHaveLength(1);
  expect(sockets.sockets[0].disconnected).toBe(false);
  expect(client.fleetIdentityFor(1).key).toBe(identityKey);
  expect(client.getGrpcSessionToken(1)).toBeUndefined();
  expect(logOut).not.toHaveBeenCalled();
  expect(storage.update).not.toHaveBeenCalled();
  expect(storage.clearFields).not.toHaveBeenCalled();
});
