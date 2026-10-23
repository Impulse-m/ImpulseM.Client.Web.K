import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';

/*
 * The fleet names the identity of a slot through a source registered by the composition root (ApiManager.after), not by
 * loading the session module. Without a source the failure is a typed client catalog error.
 */

const ACCOUNT: ActiveAccountNumber = 1;

function errorThrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch(error: unknown) {
    return error;
  }

  return undefined;
}

beforeEach(() => {
  vi.resetModules();
});

describe('the identity source of the fleet', () => {
  it('is not registered by loading the session module', async() => {
    await import('@lib/impulse/session');
    const {fleetIdentityOf} = await import('@lib/impulse/fleet/fleet');

    expect(
      errorThrownBy(() => fleetIdentityOf(ACCOUNT)),
      'loading the session must not register the source: the composition root does it, once'
    ).toMatchObject({type: 'FLEET_IDENTITY_UNREGISTERED'});
  });

  it('answers a call made with no source registered by a typed ApiError, not a bare Error', async() => {
    const {fleetIdentityOf} = await import('@lib/impulse/fleet/fleet');
    const thrown: unknown = errorThrownBy(() => fleetIdentityOf(ACCOUNT));

    expect(thrown, 'an unregistered source must throw, not return an identity').toBeDefined();
    expect(thrown, 'the failure is an ApiError carrying a client catalog type').toMatchObject({
      type: 'FLEET_IDENTITY_UNREGISTERED',
      code: 500,
      message: 'No fleet identity source is registered'
    });
    expect(thrown, 'the failure must not be a bare Error').not.toBeInstanceOf(Error);
  });
});
