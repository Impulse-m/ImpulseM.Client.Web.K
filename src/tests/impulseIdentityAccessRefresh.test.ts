import {expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {RefreshSessionRequestSchema, RefreshSessionResponseSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {accessToken, jwt, loadIdentityHarness, now, pools, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it.each([
  {code: 109},
  {code: 100, appCode: 400, appType: 'CONNECTION_NOT_INITED'}
])('a late $code/$appType cannot replay a request under a replacement session', async(error) => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  let refuse: () => void;
  sockets.respondOnce('help.getConfig', () => new Promise((resolve, reject) => {
    refuse = (): void => reject(error);
  }));
  sockets.respond('refreshSession', refreshReply);
  const request: Promise<unknown> = client.grpcInvoke('help.getConfig', {}, 1).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  await client.captureImpulseSessionToken(1, {session_token: accessToken, refresh_token: 'next'});
  refuse();
  await request;
  expect(sockets.calls.map((call) => call.method)).toEqual(['help.getConfig']);
});

const renewed: string = jwt({sub: '42', iat: now + 3300, exp: now + 7200});
const refreshReply = (): {data: Uint8Array} => ({data: toBinary(RefreshSessionResponseSchema, create(RefreshSessionResponseSchema, {userId: BigInt(42), sessionToken: renewed, refreshToken: 'next'}))});

it('refreshes live on the update socket and keeps its key and connection', async() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  sockets.respond('refreshSession', refreshReply);
  await client.grpcInvoke('help.getConfig', {}, 1);
  const key: string = client.fleetIdentityFor(1).key;
  await vi.advanceTimersByTimeAsync(3300_000);
  expect(sockets.calls.map((call) => call.method)).toEqual(['help.getConfig', 'refreshSession']);
  expect(fromBinary(RefreshSessionRequestSchema, sockets.calls[1].data).refreshToken).toBe('refresh');
  expect(client.getGrpcSessionToken(1)).toBe(renewed);
  expect(await sockets.sockets[0].options.getToken()).toBe(renewed);
  expect(client.fleetIdentityFor(1).key).toBe(key);
  expect(sockets.sockets).toHaveLength(1);
  expect(pools.calls).toHaveLength(0);
  expect(storage.update).toHaveBeenCalledWith(1, {impulse_session_token: renewed, impulse_refresh_token: 'next'});
});

it('single-flights expired access through a token-less pool', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: jwt({exp: now}), impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  pools.respond('refreshSession', refreshReply);
  const identity = client.fleetIdentityFor(1);
  expect(await Promise.all([identity.getToken(), identity.getToken()])).toEqual([renewed, renewed]);
  expect(pools.calls.map((call) => call.method)).toEqual(['refreshSession']);
  expect(pools.pools[0].options.connection.getToken).toBeUndefined();
  expect(sockets.calls).toHaveLength(0);
});

it.each([
  {code: 103, appCode: 400, appType: 'AUTH_TOKEN_INVALID'},
  {code: 109, appCode: 400, appType: 'AUTH_TOKEN_EXPIRED'},
  {code: 100, appCode: 401, appType: 'AUTH_KEY_UNREGISTERED'},
  {code: 100, appCode: 403, appType: 'USER_DEACTIVATED'}
])('a refused refresh ends the session ($appType)', async(refusal) => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: jwt({exp: now}), impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  pools.respond('refreshSession', () => {throw refusal;});
  await expect(client.fleetIdentityFor(1).getToken()).rejects.toBeInstanceOf(Error);
  expect(client.getGrpcSessionToken(1)).toBeUndefined();
});

it('retries transient live refresh failure before the two-minute deadline', async() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  sockets.respondOnce('refreshSession', () => {throw {code: 100, appCode: 500, appType: 'INTERNAL_SERVER_ERROR'};});
  sockets.respond('refreshSession', refreshReply);
  await client.grpcInvoke('help.getConfig', {}, 1);
  await vi.advanceTimersByTimeAsync(3480_000);
  expect(client.getGrpcSessionToken(1)).toBe(renewed);
  expect(sockets.calls.filter((call) => call.method === 'refreshSession')).toHaveLength(2);
  expect(sockets.sockets).toHaveLength(1);
});

it('a new session does not wait for the previous session refresh', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: jwt({exp: now}), impulse_refresh_token: 'old-refresh'});
  const client = await loadIdentityHarness();
  let release: () => void;
  pools.respondOnce('refreshSession', () => new Promise<{data: Uint8Array}>((resolve) => {
    release = (): void => resolve(refreshReply());
  }));
  const oldRefresh: Promise<boolean> = client.refreshImpulseSession(1);
  await vi.advanceTimersByTimeAsync(0);
  await client.captureImpulseSessionToken(1, {session_token: accessToken, refresh_token: 'new-refresh'});
  sockets.respond('refreshSession', refreshReply);
  const nextRefresh: Promise<boolean> = client.refreshImpulseSession(1);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.calls.map((call) => call.method)).toEqual(['refreshSession']);
  } finally {
    release();
    await Promise.all([oldRefresh, nextRefresh]);
  }
  expect(client.getGrpcSessionToken(1)).toBe(renewed);
});

it('an in-flight declaration stays valid across access rotation on the same socket', async() => {
  storage.get.mockResolvedValue({userId: 42, impulse_session_token: accessToken, impulse_refresh_token: 'refresh'});
  const client = await loadIdentityHarness();
  const {setConnectionDeclaration} = await import('@lib/impulse/grpc/credentials');
  setConnectionDeclaration(1, {apiId: 1, deviceModel: 'test', systemVersion: 'test', appVersion: 'test', systemLangCode: 'en', langPack: 'webk', langCode: 'en'});
  let release: () => void;
  sockets.respond('initConnection', () => new Promise<{data: Uint8Array}>((resolve) => {
    release = (): void => resolve({data: new Uint8Array()});
  }));
  const declaration: Promise<boolean> = client.ensureConnectionDeclared(1);
  await vi.advanceTimersByTimeAsync(0);
  sockets.respond('refreshSession', refreshReply);
  await client.refreshImpulseSession(1);
  release();
  expect(await declaration).toBe(true);
  expect(sockets.calls.map((call) => call.method)).toEqual(['initConnection', 'refreshSession']);
});
