import {expect, it, vi} from 'vitest';
import {fromBinary} from '@bufbuild/protobuf';
import {ConnectionIdentityRequestSchema} from '@lib/impulse/grpc/gen/v1/internal/impulse/auth/auth_service_pb';
import {identityReply, identityToken, jwt, loadIdentityHarness, now, setupIdentityHarness, sockets} from '@/tests/helpers/identityHarness';

setupIdentityHarness();

it('renews on the identity socket with the current token and keeps a same-identity connection', async() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const client = await loadIdentityHarness();
  const renewed: string = jwt({sub: 'i:first', orig_iat: now, iat: now + 3300, exp: now + 7200});
  sockets.respond('connectionIdentity', () => identityReply(renewed));
  await client.grpcInvoke('help.getConfig', {}, 1);
  const key: string = client.fleetIdentityFor(1).key;
  await vi.advanceTimersByTimeAsync(3300_000);
  expect(sockets.calls.map((call) => call.method)).toEqual(['help.getConfig', 'connectionIdentity']);
  expect(fromBinary(ConnectionIdentityRequestSchema, sockets.calls[1].data).identityToken).toBe(identityToken);
  expect(client.fleetIdentityFor(1).key).toBe(key);
  expect(await sockets.sockets[0].options.getToken()).toBe(renewed);
  expect(sockets.sockets).toHaveLength(1);
});

it('reconnects once when renewal returns a new identity', async() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const client = await loadIdentityHarness();
  const renewed: string = jwt({sub: 'i:new', orig_iat: now + 3300, iat: now + 3300, exp: now + 7200});
  sockets.respond('connectionIdentity', () => identityReply(renewed));
  await client.grpcInvoke('help.getConfig', {}, 1);
  const key: string = client.fleetIdentityFor(1).key;
  await vi.advanceTimersByTimeAsync(3300_000);
  expect(sockets.sockets).toHaveLength(2);
  expect(sockets.sockets[0].disconnected).toBe(true);
  expect(await client.fleetIdentityFor(1).getToken()).toBe(renewed);
  expect(client.fleetIdentityFor(1).key).not.toBe(key);
});

it('spreads one renewal timer uniformly over the specified window for 1000 seeded samples', async() => {
  const modulePath: string = '/src/lib/impulse/tokenRenewal.ts';
  const {scheduleTokenRenewal} = await import(/* @vite-ignore */ modulePath);
  let seed: number = 7;
  const random = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const schedule = vi.spyOn(globalThis, 'setTimeout');
  const bins: number[] = [0, 0, 0, 0, 0, 0];
  for(let index: number = 0; index < 1000; index++) {
    const cancel: () => void = scheduleTokenRenewal({exp: now + 3600, random, renew: async(): Promise<void> => {}});
    const delay: number = Number(schedule.mock.calls[schedule.mock.calls.length - 1][1]);
    expect(delay).toBeGreaterThanOrEqual(3300_000);
    expect(delay).toBeLessThanOrEqual(3480_000);
    bins[Math.min(5, Math.floor((delay - 3300_000) / 30_000))]++;
    cancel();
  }
  expect(bins.every((count: number): boolean => count > 120 && count < 220)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
