import {expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';
import {AuthAuthorizationSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {accessToken, identityToken, loadIdentityHarness, pools, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('sign-in stores both tokens, drops the identity and reconnects exactly once', async() => {
  const client = await loadIdentityHarness();
  await client.grpcInvoke('help.getConfig', {}, 1);
  const key: string = client.fleetIdentityFor(1).key;
  await client.captureImpulseSessionToken(1, {_: 'auth.authorization', session_token: accessToken, refresh_token: 'refresh'});
  expect(sockets.sockets).toHaveLength(2);
  await client.grpcInvoke('help.getConfig', {}, 1);
  expect(sockets.sockets[0].disconnected).toBe(true);
  expect(sockets.sockets[1].presentedToken).toBe(accessToken);
  expect(sockets.sockets).toHaveLength(2);
  expect(client.getGrpcSessionToken(1)).toBe(accessToken);
  expect(storage.update).toHaveBeenCalledWith(1, {impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  expect(client.fleetIdentityFor(1).key).not.toBe(key);
  await client.clearImpulseSession(1);
  await client.grpcInvoke('help.getConfig', {}, 1);
  expect(pools.calls.filter((call) => call.method === 'connectionIdentity')).toHaveLength(2);
  expect(sockets.sockets[2].presentedToken).toBe(identityToken);
  expect(client.fleetIdentityFor(1).key).not.toBe(key);
});

it('retired socket token providers cannot obtain credentials of the replacement class or session', async() => {
  const client = await loadIdentityHarness();
  const identity = client.fleetIdentityFor(1);
  await identity.getToken();
  await client.captureImpulseSessionToken(1, {session_token: accessToken, refresh_token: 'refresh'});
  const session = client.fleetIdentityFor(1);
  await expect(identity.getToken()).rejects.toBeInstanceOf(Error);
  await client.clearImpulseSession(1);
  await client.captureImpulseSessionToken(1, {session_token: 'new-session', refresh_token: 'next'});
  await expect(session.getToken()).rejects.toBeInstanceOf(Error);
  expect(pools.calls).toHaveLength(1);
});

it('a late authorization cannot replace a newer session', async() => {
  const client = await loadIdentityHarness();
  let release: () => void;
  const reply: Uint8Array = toBinary(AuthAuthorizationSchema, create(AuthAuthorizationSchema, {
    value: {case: 'authAuthorization', value: {sessionToken: 'stale', refreshToken: 'stale-refresh'}}
  }));
  sockets.respond('auth.signIn', () => new Promise<{data: Uint8Array}>((resolve) => {
    release = (): void => resolve({data: reply});
  }));
  const request: Promise<unknown> = client.grpcInvoke('auth.signIn', {}, 1).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  await client.captureImpulseSessionToken(1, {session_token: accessToken, refresh_token: 'refresh'});
  release();
  await request;
  expect(client.getGrpcSessionToken(1)).toBe(accessToken);
  expect(storage.update).toHaveBeenCalledTimes(1);
});
