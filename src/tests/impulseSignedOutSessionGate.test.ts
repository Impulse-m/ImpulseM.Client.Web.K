import {afterEach, describe, expect, it, vi} from 'vitest';

import {MAX_ACCOUNTS} from '@lib/accounts/constants';
import type {ActiveAccountNumber} from '@lib/accounts/types';


/*
 * Issue #137. A backend blip made a whole boot wave come back AUTH_TOKEN_INVALID, the 401
 * policy cleared the session token and left the account record behind -- and from that moment
 * every reload died before it drew anything:
 *
 *   [LANGPACK] getLangPack failed { langCode: "en", langPack: "web" }
 *   Error: Stored account has no Impulse session token
 *   Uncaught (in promise) Error: Stored account has no Impulse session token
 *
 * The session gate reported "this slot holds no token" through the same channel as "restore
 * broke", so it rejected; every boot consumer awaits that gate, so the boot died with it. The
 * user could not even reach the sign-in screen that would have fixed the state, and the only
 * way out was clearing site data by hand.
 *
 * These pin the behaviour, not the mechanism: a signed-out client reaches a usable screen, the
 * pre-auth call that draws that screen is allowed to travel without a token, and a restore that
 * genuinely failed still stops the boot wave.
 */

const accountGet = vi.fn();

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: vi.fn(),
    clearFields: vi.fn()
  }
}));

/**
 * `BootstrapExemptMethodContributor` lists this path as pre-auth exempt on purpose: canon needs
 * the langpack to render the login page itself, so it must be reachable with no session.
 */
const GET_LANG_PACK_PATH = '/v1.langpack.Langpack/GetLangPack';

/*
 * Exactly the storage state the CEO's browser was left in: the account record survives, its
 * tokens do not. Nothing is corrupt here -- this is what being signed out looks like on disk.
 */
const SIGNED_OUT_ACCOUNT = {userId: 42};

const STUCK_ON_A_BLANK_PAGE =
  'A stored account whose token the 401 policy cleared is the ordinary signed-out state, not a ' +
  'restore failure. The session gate rejected instead of opening, and every boot consumer awaits ' +
  'it, so a signed-out user is stuck on a blank page: the sign-in screen that would repair the ' +
  'state never renders, and only clearing site data by hand gets the client back.';

const LANGPACK_MUST_NOT_BE_BLOCKED =
  'langpack.getLangPack is served without a token by design -- the login page cannot draw its own ' +
  'strings otherwise. The gate blocked it before it ever reached the transport, which is the ' +
  '"[LANGPACK] getLangPack failed" the CEO saw one tick before the client went blank.';

const LANGPACK_MUST_LEAVE_ONCE =
  'The pre-auth langpack call must actually leave the client once the gate opens. No request ' +
  'reached the transport at all, so the sign-in screen has no strings to render.';

const LANGPACK_CARRIES_NO_TOKEN =
  'A signed-out client has no session token, and the pre-auth langpack call must travel without ' +
  'an Authorization header rather than be held back waiting for one. Requiring a token here is ' +
  'what turns a transient backend blip into a permanently bricked tab.';

const GATE_MUST_STILL_GUARD =
  'Treating a cleared token as the signed-out state must not degrade the gate into one that ' +
  'always opens. The gate exists so no boot RPC leaves before the stored token is on the headers; ' +
  'when the account store itself throws, nobody knows whether a token exists, and letting the ' +
  'wave go out unauthenticated is what signed a legitimately signed-in user out in the first place.';


function everySlot(): ActiveAccountNumber[] {
  // createManagers builds managers for all four slots and calls after() on each, so the real
  // boot always restores every slot. The gate opens on the last one to report in.
  return Array.from({length: MAX_ACCOUNTS}, (unused, index) => (index + 1) as ActiveAccountNumber);
}


function envelope(flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}


/**
 * A minimal well-formed gRPC-web unary reply: one empty message frame followed by the trailer
 * frame carrying `grpc-status: 0`. Enough for the transport to hand the caller a decoded
 * response, which is what makes "served" distinguishable from "blocked".
 */
function grpcWebOk(): {status: number, headers: Headers, body: ReadableStream<Uint8Array>} {
  const message = envelope(0, new Uint8Array(0));
  const trailer = envelope(0x80, new TextEncoder().encode('grpc-status:0\r\n'));
  const frames = new Uint8Array(message.length + trailer.length);
  frames.set(message);
  frames.set(trailer, message.length);

  return {
    status: 200,
    headers: new Headers({'content-type': 'application/grpc-web+proto'}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frames);
        controller.close();
      }
    })
  };
}


describe('Impulse session gate for a signed-out client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    accountGet.mockReset();
  });


  it('opens the boot gate when the stored account has lost its session token', async() => {
    accountGet.mockImplementation(async(accountNumber: ActiveAccountNumber) => (
      accountNumber === 1 ? SIGNED_OUT_ACCOUNT : undefined
    ));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    const outcome = await whenImpulseSessionReady().then(
      () => 'gate opened',
      (error: Error) => `gate rejected: ${error?.message}`
    );

    expect(outcome, STUCK_ON_A_BLANK_PAGE).toBe('gate opened');
  });


  it('lets the pre-auth langpack call leave without an Authorization header', async() => {
    accountGet.mockImplementation(async(accountNumber: ActiveAccountNumber) => (
      accountNumber === 1 ? SIGNED_OUT_ACCOUNT : undefined
    ));

    const observed: {url: string, authorization: string | null}[] = [];
    vi.stubGlobal('fetch', vi.fn(async(url: unknown, init: {headers?: HeadersInit}) => {
      const header = new Headers(init?.headers);
      observed.push({url: String(url), authorization: header.get('authorization')});
      return grpcWebOk();
    }));

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    const outcome = await grpcInvoke('langpack.getLangPack', {langPack: 'web', langCode: 'en'}).then(
      () => 'served',
      (error: any) => `blocked: ${error?.message ?? error?.type ?? String(error)}`
    );
    const langPackRequests = observed.filter((request) => request.url.endsWith(GET_LANG_PACK_PATH));

    expect(outcome, LANGPACK_MUST_NOT_BE_BLOCKED).toBe('served');
    expect(langPackRequests.length, LANGPACK_MUST_LEAVE_ONCE).toBe(1);
    expect(langPackRequests[0].authorization, LANGPACK_CARRIES_NO_TOKEN).toBeNull();
  });


  it('still rejects the boot gate when the account store genuinely fails', async() => {
    accountGet.mockRejectedValue(new Error('IndexedDB is unavailable'));
    const {restoreImpulseSession, whenImpulseSessionReady} = await import('@lib/impulse/session');

    await Promise.all(everySlot().map((accountNumber) => restoreImpulseSession(accountNumber)));

    const outcome = await whenImpulseSessionReady().then(
      () => ({name: 'gate opened', code: 'gate opened', message: 'gate opened'}),
      (error: any) => ({name: error?.name, code: error?.code, message: error?.message})
    );

    expect(outcome, GATE_MUST_STILL_GUARD).toMatchObject({
      name: 'ImpulseSessionRestoreError',
      code: 'IMPULSE_SESSION_RESTORE_FAILED',
      message: 'Failed to restore the Impulse session'
    });
  });
});
