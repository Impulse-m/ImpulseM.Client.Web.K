import {expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {InitConnectionRequestSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_types_pb';
import {AuthAuthorizationSchema} from '@lib/impulse/grpc/gen/v1/types_pb';
import {AUTH_TOKEN_INVALID_CODE} from '@lib/impulse/centrifugoCodes';
import type {UpdateSocketCallRecord, UpdateSocketReply} from '@/tests/helpers/updateSocketStub';
import {identityDeclaration} from '@/tests/helpers/identityFixtures';
import {
  accessToken,
  emptyReply,
  identityToken,
  loadIdentityHarness,
  pools,
  setupIdentityHarness,
  sockets
} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

function signInReply(): UpdateSocketReply {
  return {data: toBinary(AuthAuthorizationSchema, create(AuthAuthorizationSchema, {
    value: {case: 'authAuthorization', value: {sessionToken: accessToken, refreshToken: 'refresh'}}
  }))};
}

it('declares a fresh identity socket before sending auth.sendCode', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  let release: () => void;
  sockets.respond('initConnection', (): Promise<UpdateSocketReply> => new Promise((resolve): void => {
    release = (): void => resolve(emptyReply());
  }));
  sockets.respond('auth.sendCode', emptyReply);

  const login: Promise<unknown> = client.grpcInvoke('auth.sendCode', {}, 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual(['initConnection']);
  const {tzOffset, ...declaration} = identityDeclaration;
  expect(fromBinary(InitConnectionRequestSchema, sockets.calls[0].data).declaration).toMatchObject({
    ...declaration,
    params: {tzOffset}
  });
  release();
  await login;

  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual(['initConnection', 'auth.sendCode']);
  expect(sockets.calls.every((call: UpdateSocketCallRecord): boolean => call.presentedToken === identityToken)).toBe(true);
  expect(pools.calls.map((call): string => call.method)).toEqual(['connectionIdentity']);
});

it('declares again before a second login using the same identity token after sign-in spent it', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.signIn', signInReply);
  sockets.respond('auth.sendCode', emptyReply);
  await client.grpcInvoke('auth.signIn', {}, 1);
  expect(client.getGrpcSessionToken(1)).toBe(accessToken);
  await client.clearImpulseSession(1);
  const firstAttemptCalls: number = sockets.calls.length;

  await client.grpcInvoke('auth.sendCode', {}, 1);

  const secondAttempt: UpdateSocketCallRecord[] = sockets.calls.slice(firstAttemptCalls);
  expect(secondAttempt.map((call: UpdateSocketCallRecord): string => call.method)).toEqual(['initConnection', 'auth.sendCode']);
  expect(secondAttempt.every((call: UpdateSocketCallRecord): boolean => call.presentedToken === identityToken)).toBe(true);
  expect(sockets.sockets[0].disconnected).toBe(true);
  expect(pools.calls).toHaveLength(2);
});

it('still declares the signed-in socket after the sign-in reconnect', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.signIn', signInReply);
  await client.grpcInvoke('auth.signIn', {}, 1);

  await client.grpcInvoke('help.getConfig', {}, 1);

  const authorizedCalls: UpdateSocketCallRecord[] = sockets.calls.filter(
    (call: UpdateSocketCallRecord): boolean => call.presentedToken === accessToken
  );
  expect(authorizedCalls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual(['initConnection', 'help.getConfig']);
  expect(sockets.sockets).toHaveLength(2);
  expect(sockets.sockets[0].disconnected).toBe(true);
  expect(client.isConnectionInited(1)).toBe(true);
});

it('declares and replays a login once after CONNECTION_NOT_INITED', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respond('initConnection', emptyReply);
  client.markConnectionInited(1, client.getDeclarationGeneration(1));
  sockets.respondOnce('auth.sendCode', (): never => {
    throw {code: 100, appCode: 400, appType: 'CONNECTION_NOT_INITED'};
  });
  sockets.respond('auth.sendCode', emptyReply);

  await client.grpcInvoke('auth.sendCode', {}, 1);

  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual([
    'auth.sendCode',
    'initConnection',
    'auth.sendCode'
  ]);
  expect(sockets.calls.every((call: UpdateSocketCallRecord): boolean => call.presentedToken === identityToken)).toBe(true);
  expect(sockets.sockets).toHaveLength(1);
  expect(client.isConnectionInited(1)).toBe(true);
});

it('declares a replacement identity socket before its first login after refusal', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.sendCode', emptyReply);
  await client.grpcInvoke('auth.sendCode', {}, 1);
  client.fleetIdentityFor(1).onRefused();
  const previousCalls: number = sockets.calls.length;

  await client.grpcInvoke('auth.sendCode', {}, 1);

  expect(sockets.calls.slice(previousCalls).map((call: UpdateSocketCallRecord): string => call.method)).toEqual([
    'initConnection',
    'auth.sendCode'
  ]);
  expect(sockets.sockets).toHaveLength(2);
  expect(sockets.sockets[0].disconnected).toBe(true);
  expect(client.isConnectionInited(1)).toBe(true);
});

it('cancels a login whose declaration refused its identity and declares the replacement without stale backoff', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  sockets.respondOnce('initConnection', (): never => {
    throw {code: AUTH_TOKEN_INVALID_CODE};
  });
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.sendCode', emptyReply);

  await expect(client.grpcInvoke('auth.sendCode', {}, 1)).rejects.toMatchObject({type: 'CANCELED'});
  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual(['initConnection']);
  await client.grpcInvoke('auth.sendCode', {}, 1);

  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual([
    'initConnection',
    'initConnection',
    'auth.sendCode'
  ]);
  expect(sockets.sockets).toHaveLength(2);
  expect(client.isConnectionInited(1)).toBe(true);
});

it('does not reuse a retired identity declaration while it is still pending', async(): Promise<void> => {
  const client: Awaited<ReturnType<typeof loadIdentityHarness>> = await loadIdentityHarness();
  client.setConnectionDeclaration(1, identityDeclaration);
  let release: () => void;
  sockets.respondOnce('initConnection', (): Promise<UpdateSocketReply> => new Promise((resolve): void => {
    release = (): void => resolve(emptyReply());
  }));
  sockets.respond('initConnection', emptyReply);
  sockets.respond('auth.sendCode', emptyReply);
  const oldLogin: Promise<unknown> = client.grpcInvoke('auth.sendCode', {}, 1).catch((error: unknown): unknown => error);
  await vi.advanceTimersByTimeAsync(0);
  client.fleetIdentityFor(1).onRefused();
  const nextLogin: Promise<unknown> = client.grpcInvoke('auth.sendCode', {}, 1);
  await vi.advanceTimersByTimeAsync(0);

  expect(sockets.calls.map((call: UpdateSocketCallRecord): string => call.method)).toEqual([
    'initConnection',
    'initConnection',
    'auth.sendCode'
  ]);
  await nextLogin;
  release();
  await expect(oldLogin).resolves.toMatchObject({type: 'CANCELED'});
  expect(sockets.calls).toHaveLength(3);
  expect(client.isConnectionInited(1)).toBe(true);
});
