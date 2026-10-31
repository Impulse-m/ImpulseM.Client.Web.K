import {expect, it, vi} from 'vitest';
import {accessToken, emptyReply, identityReply, jwt, loadIdentityHarness, now, pools, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';
import {apiManagerStub} from '@/tests/helpers/apiManagerStub';
import type {UploadGetFile} from '@layer';

setupIdentityHarness();

it('discards a refused identity, re-identifies and never logs out the login screen', async() => {
  const client = await loadIdentityHarness();
  const logOut = vi.fn().mockResolvedValue(undefined);
  const manager = await apiManagerStub({getAccountNumber: () => 1, log: Object.assign(vi.fn(), {error: vi.fn()}), logOut});
  sockets.respondOnce('account.getPassword', () => {throw {code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'};});
  const key: string = client.fleetIdentityFor(1).key;
  await expect(manager.invokeApi('account.getPassword', {})).rejects.toMatchObject({type: 'AUTH_KEY_UNREGISTERED'});
  await vi.advanceTimersByTimeAsync(100);
  expect(logOut).not.toHaveBeenCalled();
  expect(client.fleetIdentityFor(1).key).not.toBe(key);
  await client.grpcInvoke('help.getConfig', {}, 1);
  expect(pools.calls).toHaveLength(2);
  expect(storage.clearFields).not.toHaveBeenCalled();
});

it('an authorized AUTH_KEY_UNREGISTERED still logs out', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  await loadIdentityHarness();
  const logOut = vi.fn().mockResolvedValue(undefined);
  const manager = await apiManagerStub({getAccountNumber: () => 1, log: Object.assign(vi.fn(), {error: vi.fn()}), logOut});
  sockets.respondOnce('account.getPassword', () => {throw {code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'};});
  await expect(manager.invokeApi('account.getPassword', {})).rejects.toMatchObject({type: 'AUTH_KEY_UNREGISTERED'});
  await vi.advanceTimersByTimeAsync(100);
  expect(logOut).toHaveBeenCalledTimes(1);
});

it.each(['error', 'disconnected'])('drops a refused identity from a socket %s event', async(event: string) => {
  const client = await loadIdentityHarness();
  await client.grpcInvoke('help.getConfig', {}, 1);
  const key: string = client.fleetIdentityFor(1).key;
  pools.respond('connectionIdentity', () => identityReply(jwt({sub: 'i:second', orig_iat: now, iat: now, exp: now + 3600})));
  sockets.sockets[0].emit(event, event === 'error'
    ? {error: {code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'}}
    : {code: 4100, reason: 'identity_refused'});
  expect(sockets.sockets).toHaveLength(1);
  await client.callUpdateSocket({accountNumber: 1, method: 'help.getConfig', request: emptyReply().data});
  expect(client.fleetIdentityFor(1).key).not.toBe(key);
  expect(sockets.sockets).toHaveLength(2);
  expect(sockets.sockets[1].presentedToken).toBe(await client.fleetIdentityFor(1).getToken());
  expect(pools.calls).toHaveLength(2);
});

it('waits retry-after and retries an identity call only once', async() => {
  const client = await loadIdentityHarness();
  sockets.respond('auth.sendCode', () => {throw {code: 111, metadata: {'x-centrifugo-retry-after': '2'}};});
  const outcome: Promise<unknown> = client.grpcInvoke('auth.sendCode', {}, 1).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(sockets.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await outcome;
  expect(sockets.calls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sockets.calls).toHaveLength(2);
});

it('an authorized socket error discards the session', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  await client.grpcInvoke('help.getConfig', {}, 1);
  sockets.sockets[0].emit('error', {error: {code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'}});
  await vi.advanceTimersByTimeAsync(0);
  expect(client.getGrpcSessionToken(1)).toBeUndefined();
});

it.each(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED'])('a late %s from a retired session cannot log out its replacement', async(type: string) => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  const logOut = vi.fn().mockResolvedValue(undefined);
  const manager = await apiManagerStub({getAccountNumber: () => 1, log: Object.assign(vi.fn(), {error: vi.fn()}), logOut});
  let refuse: () => void;
  sockets.respond('account.getPassword', () => new Promise((resolve, reject) => {
    refuse = (): void => reject({code: 100, appCode: 401, appType: type});
  }));
  const request: Promise<unknown> = manager.invokeApi('account.getPassword', {}).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  await client.clearImpulseSession(1);
  await client.captureImpulseSessionToken(1, {session_token: 'replacement', refresh_token: 'next'});
  refuse();
  await request;
  await vi.advanceTimersByTimeAsync(100);
  expect(logOut).not.toHaveBeenCalled();
  expect(client.getGrpcSessionToken(1)).toBe('replacement');
});

it('a late media refusal cannot log out a replacement session', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  const {setFleetConfig} = await import('@lib/impulse/fleet/fleet');
  setFleetConfig(1, {this_dc: 2, dc_options: [{id: 2, ip_address: 'media.example', port: 443, pFlags: {media_only: true}}]});
  const logOut = vi.fn().mockResolvedValue(undefined);
  const manager = await apiManagerStub({getAccountNumber: () => 1, log: Object.assign(vi.fn(), {error: vi.fn()}), logOut});
  let refuse: () => void;
  pools.respond('upload.getFile', () => new Promise((resolve, reject) => {
    refuse = (): void => reject({code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'});
  }));
  const request: Promise<unknown> = manager.invokeApi('upload.getFile', {} as UploadGetFile).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  await client.captureImpulseSessionToken(1, {session_token: 'replacement', refresh_token: 'next'});
  refuse();
  await request;
  await vi.advanceTimersByTimeAsync(100);
  expect(logOut).not.toHaveBeenCalled();
});
