/*
 * The session registers its identity source with the fleet at the composition root (ApiManager.after). A test that drives the
 * fleet or the update socket without an ApiManager registers the same source itself, after its vi.resetModules().
 */
export async function registerSessionIdentitySource(): Promise<void> {
  const {setFleetIdentitySource} = await import('@lib/impulse/fleet/fleet');
  const {fleetIdentityFor} = await import('@lib/impulse/session');
  setFleetIdentitySource(fleetIdentityFor);
}
