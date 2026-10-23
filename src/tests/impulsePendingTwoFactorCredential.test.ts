import {afterEach, describe, expect, it, vi} from 'vitest';

import {grpcWebTrailersOnly, grpcWebUnaryReply} from './helpers/grpcWebFrames';
import type {GrpcWebResponse} from './helpers/grpcWebFrames';

/*
 * #675 supporting unit RED — the per-slot pending-2FA credential the accepted architecture
 * (cloud-password-worker-211-20260918.txt, released as cloud-password-production-20260918.txt)
 * adds across adapter.ts / transport.ts / session.ts. Every test below drives ONLY existing
 * exported entry points — grpcInvoke, restoreImpulseSession, clearImpulseSession,
 * setGrpcSessionToken / getGrpcSessionToken / getGrpcUserId — through real ConnectError-shaped
 * gRPC-web wire responses. No new production symbol is imported or asserted to exist: RED here
 * is behavioral (the observed Authorization header, or lack of it), never an import/type failure
 * for a function this file invents.
 *
 * Live evidence for the failure this repairs: cloud-password-login-correlated-20260918.json —
 * auth.signIn -> SESSION_PASSWORD_NEEDED, 61ms later account.getPassword -> AUTH_KEY_UNREGISTERED
 * with a 0.5ms, zero-EF-Core-query rejection (JwtValidationInterceptor.cs:196-198: "no
 * Authorization header at all", the very first check, before any token parsing). The backend
 * already mints and sends the identity that call needs (ErrorOrGrpcExtensions.cs:62-70, gRPC
 * trailer `pending-token`, on the SESSION_PASSWORD_NEEDED response); the client has never read it.
 *
 * Canon: method/account.getPassword.md:37-39 and method/auth.checkPassword.md:44-46 both mark
 * themselves invocable "over an unauthenticated connection" — a pending 2FA challenge, not a
 * signed-in session. api/auth.md:816-830 models the in-between state as an authorization carrying
 * `password_pending:flags.2?true`; ImpulseM substitutes a signed, opaque, short-lived pending
 * token for the auth-key-bound identity canon relies on there.
 */

const accountGet = vi.fn();
const accountClearFields = vi.fn();
const accountUpdate = vi.fn();

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));


/**
 * A gRPC-web trailers-only ERROR response — the exact shape ErrorOrGrpcExtensions.ToRpcException
 * produces (grpc-status plus custom trailers, no message frame): `auth.signIn`'s
 * SESSION_PASSWORD_NEEDED carries `pending-token` exactly this way (ErrorOrGrpcExtensions.cs:62-70).
 * `16` is gRPC's Unauthenticated status, matching `resolveNumericCode`'s `Code.Unauthenticated -> 401`
 * (adapter.ts:497-515).
 */
function grpcWebError(
  status: number,
  trailers: Record<string, string>
): {status: number, headers: Headers, body: ReadableStream<Uint8Array>} {
  const lines = [`grpc-status:${status}`, ...Object.entries(trailers).map(([key, value]) => `${key}:${value}`)]
    .join('\r\n') + '\r\n';
  return grpcWebTrailersOnly(lines);
}

const SIGN_IN_PATH = '/v1.auth.Auth/SignIn';
const GET_PASSWORD_PATH = '/v1.account.Account/GetPassword';
// Confirmed live-wire path, GET_LANG_PACK_PATH in impulseSignedOutSessionGate.test.ts — an
// unrelated, definitely gRPC-mapped method used here only to prove it never borrows a pending
// bearer meant for GetPassword/CheckPassword.
const GET_LANG_PACK_PATH = '/v1.langpack.Langpack/GetLangPack';
// auth.sendCode's own path (AuthService's SendCode rpc, same `/v1.auth.Auth/<Method>` shape as
// SignIn/CheckPassword) — the call that unconditionally precedes any new or restarted
// phone-driven login, used below to model "a newer attempt has begun".
const SEND_CODE_PATH = '/v1.auth.Auth/SendCode';

type ObservedRequest = {path: string, authorization: string | null};

/** Stubs `fetch` and records every request's path + Authorization header, keyed by canned response. */
function stubFetch(byPath: Record<string, () => GrpcWebResponse>): ObservedRequest[] {
  const observed: ObservedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async(url: unknown, init: {headers?: HeadersInit}) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    observed.push({path, authorization: headers.get('authorization')});

    const respond = byPath[path];
    if(!respond) {
      throw new Error(`stubFetch: no canned response registered for gRPC-web path ${path}`);
    }

    return respond();
  }));

  return observed;
}

/**
 * Same recording as stubFetch, but each path is served from its own FIFO queue of responders
 * instead of one fixed canned response — needed to model real out-of-order arrival (a request
 * issued first can be made to RESOLVE last) without decoding protobuf request bodies to tell two
 * calls to the same path apart. Call order is fully within the test's control (it decides when to
 * `await` and when to leave a call in flight), so FIFO-per-path is enough to name "the first
 * auth.signIn call" vs "the second" precisely.
 */
function stubFetchWithQueue(): {
  observed: ObservedRequest[],
  enqueue: (path: string, responder: () => Promise<GrpcWebResponse>) => void
} {
  const observed: ObservedRequest[] = [];
  const queues = new Map<string, Array<() => Promise<GrpcWebResponse>>>();

  vi.stubGlobal('fetch', vi.fn(async(url: unknown, init: {headers?: HeadersInit}) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    observed.push({path, authorization: headers.get('authorization')});

    const queue = queues.get(path);
    const responder = queue?.shift();
    if(!responder) {
      throw new Error(`stubFetchWithQueue: no queued response left for gRPC-web path ${path}`);
    }

    return responder();
  }));

  return {
    observed,
    enqueue(path, responder) {
      const queue = queues.get(path) ?? [];
      queue.push(responder);
      queues.set(path, queue);
    }
  };
}

/** A promise this test resolves on its own schedule, plus the resolver — for modelling a specific in-flight gRPC call arriving out of order. */
function deferredResponse(): {promise: Promise<GrpcWebResponse>, resolve: (value: GrpcWebResponse) => void} {
  let resolve!: (value: GrpcWebResponse) => void;
  const promise = new Promise<GrpcWebResponse>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  accountGet.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockReset();
});

describe('#675 pending two-factor credential', () => {
  it(
    'retains the opaque pending-token from a real SESSION_PASSWORD_NEEDED ConnectError and attaches ' +
    'it to the very next allowed call for that account, without synthesizing a user identity',
    async() => {
      accountGet.mockResolvedValue(undefined); // a genuinely fresh, never-signed-in slot

      const observed = stubFetch({
        [SIGN_IN_PATH]: () => grpcWebError(16, {
          'error-code': 'SESSION_PASSWORD_NEEDED',
          'error-description': 'Two-factor authentication required',
          'pending-token': 'fixture-pending-token-1'
        }),
        [GET_PASSWORD_PATH]: () => grpcWebUnaryReply()
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcUserId, getGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      const signInOutcome = await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).then(() => 'resolved', (error: any) => ({type: error?.type, code: error?.code}));

      expect(
        signInOutcome,
        'SESSION_PASSWORD_NEEDED must still surface to the caller unchanged — AuthCodeCard navigates ' +
        'to the password card on exactly this shape (AuthCodeCard.tsx:127-129) and must keep doing so'
      ).toEqual({type: 'SESSION_PASSWORD_NEEDED', code: 401});

      expect(
        getGrpcUserId(1),
        'a pending 2FA challenge must never synthesize a signed-in identity for this slot'
      ).toBeUndefined();
      expect(
        getGrpcSessionToken(1),
        'a pending 2FA challenge is not a session — no session token may appear from it alone'
      ).toBeUndefined();

      // The in-memory getter and the header-attachment check below can both pass even if the
      // captured token never reaches storage — a reload would still land unauthenticated, exactly
      // the live incident this whole slice repairs. A preloaded restore fixture (test 4 below)
      // proves restore CAN read the field; it says nothing about whether capture ever WRITES it.
      // This must observe the actual persistence boundary directly.
      expect(
        accountUpdate,
        'capturing a pending token must persist it to this slot\'s AccountController record — the ' +
        'same place impulse_session_token/impulse_refresh_token already live (worker-211 §2) — not ' +
        'only hold it in memory. Without this, a reload while a challenge is still pending loses it ' +
        'and repeats the original #675 unauthenticated getPassword call.'
      ).toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: 'fixture-pending-token-1'}));

      await grpcInvoke('account.getPassword', {}, 1);

      const getPasswordRequest = observed.find((request) => request.path === GET_PASSWORD_PATH);
      expect(
        getPasswordRequest?.authorization,
        'account.getPassword must carry the pending token as its Authorization bearer once ' +
        'SESSION_PASSWORD_NEEDED has handed this slot one — today it goes out with no bearer at all, ' +
        'which is exactly the empty-header rejection JwtValidationInterceptor.cs:196-198 answers with ' +
        'AUTH_KEY_UNREGISTERED (the live evidence trace)'
      ).toBe('Bearer fixture-pending-token-1');
    }
  );

  it('never lets an unrelated RPC, or a different account slot, borrow the pending token', async() => {
    accountGet.mockResolvedValue(undefined);

    const observed = stubFetch({
      [SIGN_IN_PATH]: () => grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'fixture-pending-token-1'
      }),
      [GET_PASSWORD_PATH]: () => grpcWebUnaryReply(),
      [GET_LANG_PACK_PATH]: () => grpcWebUnaryReply()
    });

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await Promise.all([restoreImpulseSession(1), restoreImpulseSession(2)]);

    await grpcInvoke(
      'auth.signIn',
      {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
      1
    ).catch(() => {});

    await grpcInvoke('langpack.getLangPack', {langCode: 'en', langPack: 'web'}, 1);
    await grpcInvoke('account.getPassword', {}, 2);

    const unrelatedCallsOnSlot1 = observed.filter((request) => request.path === GET_LANG_PACK_PATH);
    const getPasswordOnSlot2 = observed.filter((request) => request.path === GET_PASSWORD_PATH);

    expect(unrelatedCallsOnSlot1.length, 'the unrelated call must actually have gone out to assert about it').toBeGreaterThan(0);
    expect(
      unrelatedCallsOnSlot1.every((request) => request.authorization === null),
      'an unrelated method must never carry a pending bearer, even from the slot that holds one — ' +
      'the pending credential is scoped to the four canon-allowed methods only, per the accepted ' +
      'architecture (worker-211 §1)'
    ).toBe(true);

    expect(getPasswordOnSlot2.length, 'the slot-2 call must actually have gone out to assert about it').toBeGreaterThan(0);
    expect(
      getPasswordOnSlot2.every((request) => request.authorization === null),
      'a different account slot must never borrow another slot\'s pending token — the same #436 ' +
      'per-account isolation every other credential in transport.ts already gets'
    ).toBe(true);
  });

  it(
    'prefers a real full-session bearer over a stored pending token on the same slot, and dropping ' +
    'the pending token via clearImpulseSession leaves the slot with no bearer at all once the session ' +
    'is gone too',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const observed = stubFetch({
        [SIGN_IN_PATH]: () => grpcWebError(16, {
          'error-code': 'SESSION_PASSWORD_NEEDED',
          'pending-token': 'fixture-pending-token-1'
        }),
        [GET_PASSWORD_PATH]: () => grpcWebUnaryReply()
      });

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {setGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);
      await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch(() => {});

      // A real session token arrives (e.g. a successful checkPassword elsewhere in the app) while
      // the pending token is still on the slot — it must win.
      setGrpcSessionToken(1, 'real-session-token');
      await grpcInvoke('account.getPassword', {}, 1);
      const getPasswordCallsWithRealSession = observed.filter((request) => request.path === GET_PASSWORD_PATH);
      const withRealSession = getPasswordCallsWithRealSession[getPasswordCallsWithRealSession.length - 1];
      expect(
        withRealSession?.authorization,
        'a real session bearer must take precedence over a stored pending token on the same slot'
      ).toBe('Bearer real-session-token');

      // Explicit clearing (success, abandoned login, or logOut all funnel through
      // clearImpulseSession, session.ts:300-310) must drop the PENDING token itself, not merely be
      // shadowed by whatever real session happened to exist — clear the session too and confirm
      // nothing is left to attach.
      setGrpcSessionToken(1, undefined);
      clearImpulseSession(1);
      await grpcInvoke('account.getPassword', {}, 1);
      const getPasswordCallsAfterClear = observed.filter((request) => request.path === GET_PASSWORD_PATH);
      const afterClear = getPasswordCallsAfterClear[getPasswordCallsAfterClear.length - 1];
      expect(
        afterClear?.authorization,
        'clearImpulseSession must drop the pending token itself — a stale one left behind would let ' +
        'a genuinely new/abandoned login on this slot silently authenticate against an old challenge'
      ).toBeNull();
    }
  );

  it(
    'restores a persisted pending challenge before the first password request, even with no ' +
    'userId on the record, and never authenticates or boots realtime for that slot from it alone',
    async() => {
      // The storage field name is a PREDICTION from the accepted architecture (worker-211 §2:
      // "the same place impulse_session_token / impulse_refresh_token already live" on the
      // AccountController record, following that exact naming). If the production change names
      // it differently, only this fixture's key needs a rename — no other assertion here depends
      // on the name.
      accountGet.mockImplementation(async(accountNumber: number) => (
        accountNumber === 1 ? {impulse_pending_token: 'fixture-persisted-pending-token'} : undefined
      ));

      const observed = stubFetch({[GET_PASSWORD_PATH]: () => grpcWebUnaryReply()});

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcUserId, getGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      expect(
        getGrpcUserId(1),
        'a persisted pending-only record has no userId and restore must not invent one for it ' +
        '(worker-211 §2: "a pending slot has no userId and must not be given one")'
      ).toBeUndefined();
      expect(
        getGrpcSessionToken(1),
        'a persisted pending-only record is not a session — restore must not treat it as one'
      ).toBeUndefined();

      await grpcInvoke('account.getPassword', {}, 1);

      const request = observed.find((entry) => entry.path === GET_PASSWORD_PATH);
      expect(
        request?.authorization,
        'a reload or SharedWorker restart that finds a persisted pending token must restore it BEFORE ' +
        'the password card\'s first getPassword call — today restore returns before reading anything ' +
        'past the missing userId (session.ts: "if(!data || data.userId === undefined) return"), so ' +
        'this call goes out unauthenticated exactly like the live incident\'s reload'
      ).toBe('Bearer fixture-persisted-pending-token');
    }
  );

  /*
   * #675 revision2 — worker-233/234's two confirmed production blockers, tests first. Both drive
   * ONLY existing entry points (grpcInvoke, restoreImpulseSession, getGrpcPendingToken /
   * setGrpcPendingToken / getGrpcSessionToken, all already exported in v1) — no new production
   * symbol. Error types below are taken directly from a fresh, whole-file read of
   * JwtValidationInterceptor.cs's pending branch (:196-308) rather than assumed:
   *   - no Authorization header at all -> AUTH_KEY_UNREGISTERED (:196-197) — NOT an expiry signal
   *     by itself; it is what a client that never attached a bearer gets (the original #675 bug).
   *   - a presented pending JWT whose signature/exp check fails with rejection===Expired ->
   *     AUTH_KEY_UNREGISTERED (:208-209) — genuine 5-minute-TTL expiry (JwtTokenService.cs:164).
   *   - a presented pending JWT whose jti is already on the single-use deny-list (consumed by an
   *     earlier successful checkPassword/recoverPassword, CheckPasswordCommand.cs:76-78) ->
   *     AUTH_TOKEN_INVALID, missingCap "pending-revoked" (:286-295) — a DIFFERENT code from
   *     expiry, sharing AUTH_TOKEN_INVALID with two other, unrelated causes (wrong method
   *     :272-281, malformed jti :283-284) that must NOT trigger a clear if they somehow occurred.
   * Both tests below react only to the specific case a REAL client can reach for a call it KNOWS
   * it just made with its own pending bearer and no session — never a blanket "any 401/400 clears
   * pending".
   */

  it(
    'clears a pending-scoped call\'s own token — memory and persisted — on an authoritative ' +
    'AUTH_KEY_UNREGISTERED (expired) rejection, leaving a different account slot\'s own pending ' +
    'token and this slot\'s own (absent) session untouched',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const observed = stubFetch({
        [SIGN_IN_PATH]: () => grpcWebError(16, {
          'error-code': 'SESSION_PASSWORD_NEEDED',
          'pending-token': 'fixture-pending-token-1'
        }),
        [GET_PASSWORD_PATH]: () => grpcWebError(16, {'error-code': 'AUTH_KEY_UNREGISTERED'})
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken, setGrpcPendingToken, getGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

      await Promise.all([restoreImpulseSession(1), restoreImpulseSession(2)]);

      await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch(() => {});
      expect(
        getGrpcPendingToken(1),
        'setup precondition: slot 1 must actually hold the pending token this test then has rejected'
      ).toBe('fixture-pending-token-1');

      // A different account slot's own, unrelated pending token — must survive whatever happens
      // to slot 1 below (#436 isolation).
      setGrpcPendingToken(2, 'fixture-pending-token-2');

      // The token slot 1 just captured is the one THIS call presents (no session exists yet); the
      // server authoritatively answers AUTH_KEY_UNREGISTERED for it.
      await grpcInvoke('account.getPassword', {}, 1).catch(() => {});

      const rejectedRequest = observed.filter((request) => request.path === GET_PASSWORD_PATH).pop();
      expect(
        rejectedRequest?.authorization,
        'setup precondition: the rejected call must actually have presented fixture-pending-token-1 ' +
        '— otherwise this test would not be exercising the token it claims to'
      ).toBe('Bearer fixture-pending-token-1');

      expect(
        getGrpcPendingToken(1),
        'a pending-scoped call that came back AUTH_KEY_UNREGISTERED for the token this slot itself ' +
        'just presented must clear that token — otherwise the client keeps re-presenting a rejected ' +
        'credential on every later call on this slot, forever'
      ).toBeUndefined();
      expect(
        accountClearFields,
        'clearing must also drop the PERSISTED pending token, not just the in-memory copy — a ' +
        'reload would otherwise restore the same dead token right back (restoreImpulseSession)'
      ).toHaveBeenCalledWith(1, ['impulse_pending_token']);
      expect(getGrpcSessionToken(1), 'clearing a rejected pending token must never fabricate a session').toBeUndefined();
      expect(
        getGrpcPendingToken(2),
        'clearing slot 1\'s rejected pending token must not touch a different account slot\'s own, ' +
        'unrelated pending token (#436 isolation)'
      ).toBe('fixture-pending-token-2');
    }
  );

  it(
    'clears a pending-scoped call\'s own token on an authoritative AUTH_TOKEN_INVALID (revoked / ' +
    'already-consumed) rejection — the same clearing obligation as AUTH_KEY_UNREGISTERED, under a ' +
    'DIFFERENT catalog code (JwtValidationInterceptor.cs:286-295, missingCap "pending-revoked")',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const observed = stubFetch({
        [SIGN_IN_PATH]: () => grpcWebError(16, {
          'error-code': 'SESSION_PASSWORD_NEEDED',
          'pending-token': 'fixture-pending-token-1'
        }),
        [GET_PASSWORD_PATH]: () => grpcWebError(3, {'error-code': 'AUTH_TOKEN_INVALID'})
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);
      await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch(() => {});
      expect(getGrpcPendingToken(1)).toBe('fixture-pending-token-1');

      await grpcInvoke('account.getPassword', {}, 1).catch(() => {});

      const rejectedRequest = observed.filter((request) => request.path === GET_PASSWORD_PATH).pop();
      expect(rejectedRequest?.authorization, 'setup precondition: the rejected call must have presented the pending token').toBe('Bearer fixture-pending-token-1');

      expect(
        getGrpcPendingToken(1),
        'AUTH_TOKEN_INVALID for the token this slot itself just presented means that specific ' +
        'pending token is dead (revoked/consumed) exactly as much as AUTH_KEY_UNREGISTERED does — ' +
        'it must be cleared too, not left attached to every subsequent call'
      ).toBeUndefined();
      expect(accountClearFields).toHaveBeenCalledWith(1, ['impulse_pending_token']);
    }
  );

  it(
    'still captures the pending token normally from auth.signIn when nothing has superseded the ' +
    'attempt before its response arrives (positive control for the two staleness tests below)',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      const signIn = deferredResponse();
      enqueue(SIGN_IN_PATH, () => signIn.promise);
      const signInCall = grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch((error: any) => ({type: error?.type}));

      signIn.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'fixture-pending-token-current'
      }));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'an ordinary, un-superseded SESSION_PASSWORD_NEEDED must still be captured — the staleness ' +
        'guard the next two tests require must not turn into "never capture anything"'
      ).toBe('fixture-pending-token-current');
    }
  );

  it(
    'a stale in-flight SESSION_PASSWORD_NEEDED cannot reintroduce its own abandoned pending token ' +
    'once a newer login attempt has already begun on the same slot',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      // Attempt X (phone A): auth.signIn is issued but its response is held back — modelling a
      // slow network round-trip the user does not wait for.
      const signInX = deferredResponse();
      enqueue(SIGN_IN_PATH, () => signInX.promise);
      const signInXCall = grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash-x', phone_code: '11111'},
        1
      ).catch((error: any) => ({type: error?.type}));

      // Attempt Y (a DIFFERENT phone) supersedes X: a fresh code is sent before X's signIn ever
      // settles — exactly "abandon X, start Y" with no cancellation, the concrete race named.
      enqueue(SEND_CODE_PATH, () => Promise.resolve(grpcWebUnaryReply()));
      await grpcInvoke(
        'auth.sendCode',
        {phone_number: '+9996622222', api_id: 1, api_hash: 'fixture-hash', settings: {_: 'codeSettings', pFlags: {}}},
        1
      );

      // X's stale signIn now FINALLY resolves, carrying X's own (abandoned) pending token.
      signInX.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'stale-pending-token-x'
      }));
      await signInXCall;

      expect(
        getGrpcPendingToken(1),
        'a SESSION_PASSWORD_NEEDED response belonging to an attempt already abandoned before it ' +
        'arrived (a newer auth.sendCode succeeded first) must not reintroduce that attempt\'s own ' +
        'pending token onto the slot — the scenario defines no replacement token, so the slot must ' +
        'end up with none at all, not merely "not X"'
      ).toBeUndefined();
    }
  );

  it(
    'a new sendCode attempt invalidates an older in-flight signIn as soon as it BEGINS, not only ' +
    'once it succeeds — releasing the old SESSION_PASSWORD_NEEDED while sendCode is still pending ' +
    'must not capture it, in memory or persisted',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      // Old attempt (phone X): signIn issued, held back.
      const signInX = deferredResponse();
      enqueue(SIGN_IN_PATH, () => signInX.promise);
      const signInXCall = grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash-x', phone_code: '11111'},
        1
      ).catch((error: any) => ({type: error?.type}));

      // A new attempt (phone Y) BEGINS — sendCode is issued but its OWN response is also held
      // back, not yet successful. Unlike the test above (which lets sendCode fully succeed before
      // releasing X), this is the narrower window the "clear on new/abandoned login" contract
      // wording actually names: the attempt beginning, not the attempt completing. If invalidation
      // only happens on sendCode's success, this window is exactly where a stale capture can still
      // slip through.
      const sendCodeY = deferredResponse();
      enqueue(SEND_CODE_PATH, () => sendCodeY.promise);
      const sendCodeYCall = grpcInvoke(
        'auth.sendCode',
        {phone_number: '+9996622222', api_id: 1, api_hash: 'fixture-hash', settings: {_: 'codeSettings', pFlags: {}}},
        1
      ).catch((error: any) => ({type: error?.type}));

      // X's stale SESSION_PASSWORD_NEEDED arrives BEFORE sendCode has resolved at all.
      signInX.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'stale-pending-token-during-sendcode'
      }));
      await signInXCall;

      expect(
        getGrpcPendingToken(1),
        'an already-in-flight (not yet successful) new sendCode attempt must invalidate an older ' +
        'signIn\'s own eventual SESSION_PASSWORD_NEEDED — capturing it here would restore a pending ' +
        'challenge for an attempt the user has already moved past, before the new attempt has even ' +
        'finished starting'
      ).toBeUndefined();
      expect(
        accountUpdate,
        'the stale response must not persist the abandoned pending token either, for the same reason'
      ).not.toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: expect.anything()}));

      // Let sendCode itself finish too, exactly as a real attempt would — settling every promise
      // this test created, and confirming its own success does not retroactively change anything.
      sendCodeY.resolve(grpcWebUnaryReply());
      await sendCodeYCall;

      expect(
        getGrpcPendingToken(1),
        'once both calls have fully settled the slot must still hold no pending token — sendCode\'s ' +
        'own success carries none to capture, and X\'s was already correctly discarded above'
      ).toBeUndefined();
    }
  );

  // Currently green by absence, like the isolation checks in the very first test above (v1 clears
  // nothing on AUTH_KEY_UNREGISTERED yet, so T2 is untouched for lack of any clearing at all) — a
  // forward guard against a NAIVE version of the two blocker fixes above ("just clear on any
  // AUTH_KEY_UNREGISTERED") that would start failing this one the moment it landed without also
  // checking the rejected call was for the token still current.
  it(
    'a late rejection belonging to an old, already-superseded pending token cannot clear the ' +
    'NEWER pending token that has since replaced it on the same slot',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      // T1 is captured first, ordinarily.
      enqueue(SIGN_IN_PATH, () => Promise.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'old-pending-token-t1'
      })));
      await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch(() => {});
      expect(getGrpcPendingToken(1)).toBe('old-pending-token-t1');

      // A pending-scoped call using T1 is issued but held back — its rejection arrives LATE, below.
      const oldGetPassword = deferredResponse();
      enqueue(GET_PASSWORD_PATH, () => oldGetPassword.promise);
      const oldGetPasswordCall = grpcInvoke('account.getPassword', {}, 1).catch((error: any) => ({type: error?.type}));

      // Meanwhile T1 is superseded by T2 on the SAME slot (e.g. the user retried and got a fresh
      // challenge) — this is the "new attempt begins" trigger, arriving BEFORE the old rejection.
      enqueue(SIGN_IN_PATH, () => Promise.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'newer-pending-token-t2'
      })));
      await grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '22222'},
        1
      ).catch(() => {});
      expect(getGrpcPendingToken(1), 'setup: T2 must actually be current before the late rejection arrives').toBe('newer-pending-token-t2');

      // NOW the OLD in-flight call — issued while T1 was current — finally rejects as dead.
      oldGetPassword.resolve(grpcWebError(16, {'error-code': 'AUTH_KEY_UNREGISTERED'}));
      await oldGetPasswordCall;

      expect(
        getGrpcPendingToken(1),
        'a late rejection for an OLD pending token (T1) must not clear the NEWER pending token (T2) ' +
        'that has since replaced it — control for the clearing tests above: clearing must be tied ' +
        'to the specific token/attempt that was rejected, not "whatever is current when the ' +
        'response arrives"'
      ).toBe('newer-pending-token-t2');
    }
  );

  // review #240/#241: the two remaining cases the revision2 task's own wording names explicitly
  // ("new login begins OR THE SLOT LOGS OUT" / "the full session must survive") — same seams as
  // the T1->T2 control above, no new helpers.

  it(
    'a stale SESSION_PASSWORD_NEEDED arriving after this slot has already logged out must not ' +
    'reintroduce a pending token, in memory or persisted',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      // A signIn is issued and held back — modelling the same slow round-trip as the sendCode
      // scenario above, this time superseded by a LOGOUT instead of a newer attempt.
      const signIn = deferredResponse();
      enqueue(SIGN_IN_PATH, () => signIn.promise);
      const signInCall = grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch((error: any) => ({type: error?.type}));

      // The slot logs out while that signIn is still in flight (clearImpulseSession — the exact
      // function apiManager.logOut() calls, session.ts:329-342). Isolate the assertions below to
      // what the STALE response itself does next, not logout's own already-covered clear.
      clearImpulseSession(1);
      accountClearFields.mockClear();
      accountUpdate.mockClear();

      // The stale signIn now finally resolves, carrying an abandoned pending token.
      signIn.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'stale-pending-token-after-logout'
      }));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'a SESSION_PASSWORD_NEEDED response belonging to an attempt this slot already logged out of ' +
        'before it arrived must not reintroduce a pending token in memory'
      ).toBeUndefined();
      expect(
        accountUpdate,
        'the stale response must not persist the abandoned pending token either — logout already ' +
        'cleared the persisted field, and the late arrival must not write a new value into it. (v1 ' +
        'note: nothing currently calls AccountController.update with impulse_pending_token at all — ' +
        'this stays green until that persistence is added, and guards it from day one once it is.)'
      ).not.toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: expect.anything()}));
    }
  );

  it(
    'a pending-scoped request rejected AFTER this slot has since gained a full session leaves that ' +
    'session untouched and does not restore the old pending identity',
    async() => {
      accountGet.mockResolvedValue(undefined);
      const {observed, enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken, getGrpcPendingToken, setGrpcSessionToken, setGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);

      // An old pending token exists before anything else happens — the concrete thing "must not be
      // restored" refers to.
      setGrpcPendingToken(1, 'old-pending-token');

      // A pending-scoped account.getPassword is issued (presenting that token) and held back.
      const oldGetPassword = deferredResponse();
      enqueue(GET_PASSWORD_PATH, () => oldGetPassword.promise);
      const oldGetPasswordCall = grpcInvoke('account.getPassword', {}, 1).catch((error: any) => ({type: error?.type}));

      // Let the call actually REACH the (stubbed) network — i.e. run the auth interceptor and
      // read the OLD pending token off `credentials` — before the credentials change below.
      // Observed directly (the real outgoing request, carrying the real old-token header) rather
      // than guessed via a scheduling delay: a fixed setTimeout(0) only asserts "some scheduler
      // tick elapsed", which proves nothing about whether THIS call in particular had reached
      // fetch by then, and ties the test to however many microtask hops grpcInvoke's own
      // internals happen to take today. Without this handshake, mutating credentials right after
      // issuing the call could race ahead of the interceptor and stamp the NEW session onto the
      // OLD request instead.
      await vi.waitFor(() => {
        const sent = observed.find((request) => request.path === GET_PASSWORD_PATH);
        expect(sent?.authorization, 'the old pending-scoped call has not reached the stubbed network yet').toBe('Bearer old-pending-token');
      });

      // The slot gains a FULL session in the meantime (e.g. a successful checkPassword elsewhere
      // completed first) — existing setters used directly rather than a hand-encoded protobuf
      // success response, matching this file's own established pattern (test 3 above) for the
      // same reason: `{ignoreErrors:true}`/wire-decoding of a realistic auth.authorization message
      // is not the thing under test here. Production's own capture path (captureImpulseSessionToken,
      // session.ts) clears pending in the same step a real session lands — modelled explicitly,
      // since this test's scenario depends on the pending token actually having been cleared by
      // the time the old rejection below arrives, not merely superseded.
      setGrpcSessionToken(1, 'real-session-token');
      setGrpcPendingToken(1, undefined);

      // NOW the old, pre-session pending-scoped call finally rejects. The waitFor above already
      // proved this specific call presented the OLD token before credentials changed.
      oldGetPassword.resolve(grpcWebError(16, {'error-code': 'AUTH_KEY_UNREGISTERED'}));
      await oldGetPasswordCall;

      expect(
        getGrpcSessionToken(1),
        'a late rejection belonging to a call issued BEFORE this slot had a session must not clear ' +
        'or otherwise disturb the real session the slot has since acquired'
      ).toBe('real-session-token');
      expect(
        getGrpcPendingToken(1),
        'the late rejection must not restore the old, already-cleared pending identity onto a slot ' +
        'that has already moved past the pending stage entirely'
      ).toBeUndefined();
    }
  );

  // #675 revision3, item A — minimal positive control plus one regression pin, both required
  // because the generation snapshot moved to the very top of grpcInvoke, before restore is even
  // guaranteed to have started resolving, not just before its own await. Both drive
  // AccountController.get through the existing deferred-promise technique test 4 above already
  // uses (there, resolved immediately; here, held open), not a new harness.

  it(
    'a call issued while restoring a persisted pending challenge waits for that genuinely in-flight ' +
    'restore to finish, then carries the token restore just loaded — the positive control for the ' +
    'boot-time race the generation-snapshot timing above exists to guard',
    async() => {
      let resolveAccountGet!: (value: {impulse_pending_token: string} | undefined) => void;
      accountGet.mockImplementation(() => new Promise((resolve) => {
        resolveAccountGet = resolve;
      }));

      const observed = stubFetch({[GET_PASSWORD_PATH]: () => grpcWebUnaryReply()});

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      // Restore is started but deliberately left pending — AccountController.get has not resolved
      // yet, unlike every earlier test's `await restoreImpulseSession(...)`, which always let it
      // settle before issuing a call.
      const restorePromise = restoreImpulseSession(1);

      // Issued while that restore is still genuinely in flight, not merely before its own await.
      const invokePromise = grpcInvoke('account.getPassword', {}, 1);

      // The persisted record now arrives, carrying a pending challenge from before the reload.
      resolveAccountGet({impulse_pending_token: 'fixture-persisted-pending-token-boot'});
      await restorePromise;
      await invokePromise;

      expect(
        getGrpcPendingToken(1),
        'setup precondition: restore must have actually loaded the persisted token for the request ' +
        'below to prove anything about it'
      ).toBe('fixture-persisted-pending-token-boot');

      const request = observed.find((entry) => entry.path === GET_PASSWORD_PATH);
      expect(
        request?.authorization,
        'a request that started before restore finished must still end up carrying the token restore ' +
        'loaded once restore actually completes — the call has to wait for readiness, not race past ' +
        'it with whatever this slot held before restore ran'
      ).toBe('Bearer fixture-persisted-pending-token-boot');
    }
  );

  it(
    'a logout that completes WHILE restore is still genuinely pending still invalidates an in-flight ' +
    'signIn issued before it, AND restore must not resurrect a real, NONEMPTY persisted pending token ' +
    'onto a slot the same logout already cleared — reviewer271\'s source-traced gap: restoreGrpcPendingToken ' +
    'applies unconditionally, with no check against a generation bump that landed while its own read was ' +
    'still in flight',
    async() => {
      let resolveAccountGet!: (value: {impulse_pending_token: string}) => void;
      accountGet.mockImplementation(() => new Promise((resolve) => {
        resolveAccountGet = resolve;
      }));
      const {observed, enqueue} = stubFetchWithQueue();

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/transport');

      // Restore is started but its own storage read has not resolved yet.
      const restorePromise = restoreImpulseSession(1);

      // signIn is issued while restore is still genuinely pending — it snapshots its own
      // pre-restore generation and then suspends on the very readiness gate restore has not
      // opened yet.
      const signIn = deferredResponse();
      enqueue(SIGN_IN_PATH, () => signIn.promise);
      const signInCall = grpcInvoke(
        'auth.signIn',
        {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'},
        1
      ).catch((error: any) => ({type: error?.type}));

      // The slot logs out — synchronously bumping the generation (clearPendingToken's
      // setGrpcPendingToken, transport.ts) — while readiness is STILL unsettled, i.e. before
      // restore's own storage read has come back at all. Not awaited, for the same reason the
      // already-restored logout test above does not await it either: it is the synchronous prefix
      // that has to land before anything else runs, not the trailing persisted clear.
      void clearImpulseSession(1);

      // Restore's OWN storage read now finally arrives — carrying a REAL, NONEMPTY persisted
      // pending token (the same restore-record shape as tests 4/13), unlike an empty slot, which
      // gives restoreGrpcPendingToken nothing to resurrect and cannot expose this gap at all. This
      // is the exact precondition reviewer271 traced: `AccountController.get`/`.clearFields` are
      // enqueue-backed and settle in ISSUANCE order, so a `get()` issued before the logout's own
      // `clearFields()` resolves with the PRE-clear record even though the in-memory generation has
      // already moved on — and restoreGrpcPendingToken writes it back unconditionally, with no
      // check against that.
      resolveAccountGet({impulse_pending_token: 'fixture-pending-token-revoked-by-concurrent-logout'});
      await restorePromise;

      // signIn's own response finally arrives, carrying a pending token for an attempt this slot
      // was already logged out of before it ever got the chance to settle.
      signIn.resolve(grpcWebError(16, {
        'error-code': 'SESSION_PASSWORD_NEEDED',
        'pending-token': 'stale-pending-token-during-restore'
      }));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'a logout that lands while this call was still waiting on a genuinely pending restore must ' +
        'leave this slot with NO pending token once everything above has settled — neither the stale ' +
        'signIn\'s own token (blocked by the generation guard, as the already-restored case above ' +
        'proves) NOR the real persisted token restore itself just read back from storage before the ' +
        'logout\'s persisted clear could land (reviewer271: restoreGrpcPendingToken has no generation ' +
        'check of its own, so it resurrects a credential the concurrent logout already revoked)'
      ).toBeUndefined();

      // The resurrected credential must not merely sit unused in memory — a subsequent allowed call
      // on this now-logged-out slot must not attach it either, or the resurrection is observable
      // beyond just this getter.
      enqueue(GET_PASSWORD_PATH, () => Promise.resolve(grpcWebUnaryReply()));
      await grpcInvoke('account.getPassword', {}, 1);
      const passwordRequest = observed.filter((request) => request.path === GET_PASSWORD_PATH).pop();
      expect(
        passwordRequest?.authorization,
        'a request issued after this slot logged out must never carry the credential restore ' +
        'resurrected — the slot is signed out and pending-less; nothing it sends should authenticate ' +
        'as if the revoked challenge were still current'
      ).toBeNull();
    }
  );
});
