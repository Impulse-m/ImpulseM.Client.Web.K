import {expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {AccountPasswordSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {identityToken, loadIdentityHarness, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('SESSION_PASSWORD_NEEDED preserves the identity and ignores pending-token metadata', async() => {
  const client = await loadIdentityHarness();
  sockets.respond('auth.signIn', () => {throw {code: 100, appCode: 401, appType: 'SESSION_PASSWORD_NEEDED', metadata: {'pending-token': 'legacy'}};});
  await expect(client.grpcInvoke('auth.signIn', {}, 1)).rejects.toMatchObject({type: 'SESSION_PASSWORD_NEEDED'});
  await client.grpcInvoke('help.getConfig', {}, 1);
  expect(sockets.sockets).toHaveLength(1);
  expect(sockets.calls.every((call) => call.presentedToken === identityToken)).toBe(true);
  expect(storage.update).not.toHaveBeenCalled();
});

it('fetches each SRP challenge on the same socket and waits FLOOD_WAIT before the next attempt', async() => {
  const client = await loadIdentityHarness();
  const {PasswordManager} = await import('@appManagers/passwordManager');
  const {ApiManager} = await import('@appManagers/apiManager');
  const apiManager = Object.assign(Object.create(ApiManager.prototype), {getAccountNumber: () => 1, setUser: vi.fn(), logOut: vi.fn()});
  const compute = vi.fn(async(method: string, password: string, state: {srp_id: number}) => ({_: 'inputCheckPasswordSRP', srp_id: state.srp_id}));
  const manager = Object.assign(Object.create(PasswordManager.prototype), {apiManager, cryptoWorker: {invokeCrypto: compute}});
  let srp: bigint = BigInt(0);
  sockets.respond('account.getPassword', () => ({data: toBinary(AccountPasswordSchema, create(AccountPasswordSchema, {srpId: ++srp}))}));
  sockets.respondOnce('auth.checkPassword', () => {throw {code: 100, appCode: 420, appType: 'FLOOD_WAIT_3'};});
  sockets.respond('auth.checkPassword', () => {throw {code: 100, appCode: 400, appType: 'PASSWORD_HASH_INVALID'};});
  await expect(manager.check('wrong', {srp_id: '999'}, {ignoreErrors: true})).rejects.toMatchObject({type: 'FLOOD_WAIT_3'});
  const second: Promise<unknown> = manager.check('again', {srp_id: '999'}, {ignoreErrors: true}).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(2999);
  expect(sockets.calls.map((call) => call.method)).toEqual(['account.getPassword', 'auth.checkPassword']);
  await vi.advanceTimersByTimeAsync(1);
  await second;
  expect(sockets.calls.map((call) => call.method)).toEqual(['account.getPassword', 'auth.checkPassword', 'account.getPassword', 'auth.checkPassword']);
  expect(compute.mock.calls.map((call) => call[2].srp_id)).toEqual([1, 2]);
  expect(sockets.sockets).toHaveLength(1);
  expect(client.fleetIdentityFor(1).kind).toBe('identity');
});
