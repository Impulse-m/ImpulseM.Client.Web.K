import {expect, it, vi} from 'vitest';
import {fromBinary} from '@bufbuild/protobuf';
import {ConnectionIdentityRequestSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {emptyReply, identityToken, loadIdentityHarness, pools, setupIdentityHarness, sockets, storage} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('mints through the token-less pool and sends login on the identity socket without initConnection', async() => {
  vi.stubEnv('VITE_IMPULSE_BACKEND_URL', 'https://identity.example:9443');
  const client = await loadIdentityHarness();
  sockets.respond('auth.sendCode', emptyReply);
  await client.grpcInvoke('auth.sendCode', {}, 1);
  expect(pools.calls.map((call) => call.method)).toEqual(['connectionIdentity']);
  expect(pools.calls[0].endpoint).toBe('wss://identity.example:9443/pool/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true');
  expect(fromBinary(ConnectionIdentityRequestSchema, pools.calls[0].data).identityToken).toBe('');
  expect(pools.pools[0].options.connection.getToken).toBeUndefined();
  expect(sockets.calls[0].presentedToken).toBe(identityToken);
  expect(sockets.calls.map((call) => call.method)).toEqual(['auth.sendCode']);
  expect(await client.fleetIdentityFor(1).getToken()).toBe(identityToken);
  expect(pools.calls).toHaveLength(1);
  expect(storage.update).not.toHaveBeenCalled();
  expect(storage.clearFields).not.toHaveBeenCalled();
});

it('ignores legacy persisted pending credentials and keeps account identities separate', async() => {
  const readPending = vi.fn(() => 'obsolete');
  storage.get.mockResolvedValue(Object.defineProperty({}, 'impulse_pending_token', {get: readPending}));
  const client = await loadIdentityHarness();
  await client.restoreImpulseSession(2);
  await client.callUpdateSocket({accountNumber: 1, method: 'help.getConfig', request: new Uint8Array()});
  await client.callUpdateSocket({accountNumber: 2, method: 'help.getConfig', request: new Uint8Array()});
  expect(readPending).not.toHaveBeenCalled();
  expect(pools.calls).toHaveLength(2);
  expect(sockets.sockets).toHaveLength(2);
});
