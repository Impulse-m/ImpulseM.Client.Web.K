import {expect, it} from 'vitest';
import {accessToken, loadIdentityHarness, setupIdentityHarness, sockets} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('every update socket has a token provider across boot, sign-in, sign-out and reconnect', async() => {
  const client = await loadIdentityHarness();
  await client.grpcInvoke('help.getConfig', {}, 1);
  await client.captureImpulseSessionToken(1, {session_token: accessToken, refresh_token: 'refresh'});
  await client.grpcInvoke('help.getConfig', {}, 1);
  await client.clearImpulseSession(1);
  await client.grpcInvoke('help.getConfig', {}, 1);
  client.stopImpulseRealtime(1);
  await client.grpcInvoke('help.getConfig', {}, 1);
  expect(sockets.sockets.length).toBeGreaterThanOrEqual(4);
  expect(sockets.sockets.some((socket) => !socket.options.token && !socket.options.getToken)).toBe(false);
});
