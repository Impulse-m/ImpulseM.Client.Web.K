import {afterEach, describe, expect, it, vi} from 'vitest';

import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * Issue #141, realtime half. fetchCentrifugoToken() awaits whenImpulseSessionReady() before it
 * asks requireGrpcSessionToken() for the token. This test never started a restore, so under
 * vitest (`import.meta.env.DEV` is true) the gate answered with the DEV bypass -- the rejection
 * arrived from the wrong place, carrying the wrong message, and the token check this test is
 * named after was never reached. It has been red since the bypass and the test landed together
 * in 9f0801262.
 *
 * Boot the gate the way boot does -- every account slot reports in, all of them empty, so the
 * gate opens with nobody signed in -- and the refusal that follows is the one being asserted.
 */

const accountGet = vi.fn();

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

const REFUSAL_MUST_COME_FROM_THE_TOKEN_CHECK =
  'The Centrifugo handshake must be refused by requireGrpcSessionToken(), naming the missing ' +
  'session token. Any other message means the rejection came from somewhere ahead of the token ' +
  'check -- the DEV session-gate bypass answers with an ImpulseSessionRestoreError here, which ' +
  'looks like a refusal and proves nothing about the token. "token requested" means the ' +
  'handshake was attempted with no token at all.';

const NO_UNAUTHENTICATED_HANDSHAKE =
  'An unauthenticated Centrifugo handshake reached the network. Sync.GetCentrifugoToken is a ' +
  'signed-in call; issuing it without a session token gets the whole push channel refused and ' +
  'leaves the tab with no realtime updates for its lifetime.';


function everySlot(): ActiveAccountNumber[] {
  // createManagers builds managers for all four slots and calls after() on each, so the real boot
  // always restores every slot. The gate opens on the last one to report in.
  return Array.from({length: MAX_ACCOUNTS}, (unused, index) => (index + 1) as ActiveAccountNumber);
}


describe('Impulse realtime authentication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    accountGet.mockReset();
  });


  it('does not request a Centrifugo token without a gRPC session token', async() => {
    // No stored account in any slot: nobody is signed in, so the gate opens and there is no token.
    accountGet.mockResolvedValue(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {fetchCentrifugoToken} = await import('@lib/impulse/realtime');
    const {setGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));
    setGrpcSessionToken(1, undefined);

    // Requested on behalf of slot 1, which every slot above left empty.
    const outcome = await fetchCentrifugoToken(1).then(
      () => 'token requested',
      (error: any) => `refused: ${error?.message}`
    );

    expect(outcome, REFUSAL_MUST_COME_FROM_THE_TOKEN_CHECK).toBe('refused: Impulse session is not ready');
    expect(fetchMock, NO_UNAUTHENTICATED_HANDSHAKE).not.toHaveBeenCalled();
  });
});
