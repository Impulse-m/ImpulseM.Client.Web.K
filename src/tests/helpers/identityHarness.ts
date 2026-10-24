import {identityReply, identityToken, now} from '@/tests/helpers/identityFixtures';
export {accessToken, identityReply, identityToken, jwt, now} from '@/tests/helpers/identityFixtures';
import {afterEach, beforeEach, vi} from 'vitest';
import {sharedFleetPoolHarness} from '@/tests/helpers/fleetPoolStub';
import {sharedUpdateSocketHarness} from '@/tests/helpers/updateSocketStub';
import {registerSessionIdentitySource} from '@/tests/helpers/fleetIdentitySource';

const accountStorage = vi.hoisted(() => ({get: vi.fn(), update: vi.fn(), clearFields: vi.fn(), getTotalAccounts: vi.fn(), shiftAccounts: vi.fn()}));

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

vi.mock('@lib/accounts/accountController', () => ({default: accountStorage}));
vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedFleetPoolHarness: pools} = await import('@/tests/helpers/fleetPoolStub');
  const {sharedUpdateSocketHarness: sockets} = await import('@/tests/helpers/updateSocketStub');
  return {...actual, RpcPool: pools().RpcPoolStub, Centrifuge: sockets().CentrifugeStub};
});

export const storage = accountStorage;

export const pools = sharedFleetPoolHarness();
export const sockets = sharedUpdateSocketHarness();
export const emptyReply = (): {data: Uint8Array} => ({data: new Uint8Array()});

export async function loadIdentityHarness() {
  const session = await import('@lib/impulse/session');
  const realtime = await import('@lib/impulse/realtime');
  const adapter = await import('@lib/impulse/grpc/adapter');
  const credentials = await import('@lib/impulse/grpc/credentials');
  await session.restoreImpulseSession(1);
  return {...session, ...realtime, ...adapter, ...credentials};
}

export function setupIdentityHarness(): void {
  beforeEach(async() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    pools.reset();
    sockets.reset();
    storage.get.mockReset().mockResolvedValue(undefined);
    storage.update.mockReset().mockResolvedValue(undefined);
    storage.clearFields.mockReset().mockResolvedValue(undefined);
    storage.getTotalAccounts.mockReset().mockResolvedValue(2);
    storage.shiftAccounts.mockReset().mockResolvedValue(undefined);
    pools.respond('connectionIdentity', () => identityReply(identityToken));
    sockets.respond('help.getConfig', emptyReply);
    await registerSessionIdentitySource();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
}
