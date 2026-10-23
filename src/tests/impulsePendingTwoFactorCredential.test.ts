import {afterEach, describe, expect, it, vi} from 'vitest';

import type {UpdateSocketReply} from './helpers/updateSocketStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * #675 — the per-slot pending-2FA credential. Every test below drives ONLY existing exported entry points — grpcInvoke,
 * restoreImpulseSession, clearImpulseSession, setGrpcSessionToken / getGrpcSessionToken / setGrpcPendingToken /
 * getGrpcPendingToken — through the update socket of the slot, answered by its stand-in. What the server would have seen
 * is the connection token the socket presented when it connected.
 *
 * Live evidence for the failure this repairs: cloud-password-login-correlated-20260918.json — auth.signIn ->
 * SESSION_PASSWORD_NEEDED, 61ms later account.getPassword -> AUTH_KEY_UNREGISTERED with a 0.5ms, zero-EF-Core-query
 * rejection (JwtValidationInterceptor.cs:196-198: no credential at all, the very first check). The backend already
 * mints and sends the identity that call needs (ErrorOrGrpcExtensions.cs:62-70, metadata `pending-token`, on the
 * SESSION_PASSWORD_NEEDED response); the client has never read it.
 *
 * Canon: method/account.getPassword.md:37-39 and method/auth.checkPassword.md:44-46 both mark themselves invocable
 * "over an unauthenticated connection" — a pending 2FA challenge, not a signed-in session.
 */

const socketHarness = sharedUpdateSocketHarness();

const accountGet = vi.fn();
const accountClearFields = vi.fn();
const accountUpdate = vi.fn();

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('./helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const SIGN_IN = 'auth.signIn';
const GET_PASSWORD = 'account.getPassword';
const CHECK_PASSWORD = 'auth.checkPassword';
// Confirmed live method, used here only to prove it never borrows a pending token meant for GetPassword/CheckPassword.
const GET_LANG_PACK = 'langpack.getLangPack';
// The call that unconditionally precedes any new or restarted phone-driven login.
const SEND_CODE = 'auth.sendCode';

const APP_CODE_OF: Record<string, number> = {
  SESSION_PASSWORD_NEEDED: 401,
  AUTH_KEY_UNREGISTERED: 401,
  AUTH_TOKEN_INVALID: 400
};

/**
 * A server rejection as the pool reports it: the application type and its metadata, as ErrorOrGrpcExtensions.ToRpcException
 * writes them. AUTH_TOKEN_INVALID arrives with the refusal code of the registry (103), the other types with the generic one.
 */
function serverError(appType: string, metadata: Record<string, string> = {}): {
  code: number,
  message: string,
  appCode: number,
  appType: string,
  metadata: Record<string, string>
} {
  return {
    code: appType === 'AUTH_TOKEN_INVALID' ? 103 : 100,
    message: appType,
    appCode: APP_CODE_OF[appType],
    appType,
    metadata
  };
}

function rejecting(appType: string, metadata: Record<string, string> = {}): () => never {
  return (): never => {
    throw serverError(appType, metadata);
  };
}

function answered(): () => UpdateSocketReply {
  return (): UpdateSocketReply => ({data: new Uint8Array(0)});
}

function respondAll(responders: Record<string, (data: Uint8Array) => UpdateSocketReply | Promise<UpdateSocketReply>>): void {
  for(const [method, responder] of Object.entries(responders)) {
    socketHarness.respond(method, responder);
  }
}

/** A reply the test resolves or rejects on its own schedule, to model an in-flight call arriving out of order. */
function deferredReply(): {
  promise: Promise<UpdateSocketReply>,
  resolve: (value: UpdateSocketReply) => void,
  reject: (error: unknown) => void
} {
  let resolve!: (value: UpdateSocketReply) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<UpdateSocketReply>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

const SIGN_IN_ARGS = {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'};
const SEND_CODE_ARGS = {phone_number: '+9996622222', api_id: 1, api_hash: 'fixture-hash', settings: {_: 'codeSettings', pFlags: {}}};

function callsOf(method: string): Array<{method: string, presentedToken: string | undefined}> {
  return socketHarness.calls.filter((call) => call.method === method);
}

function lastCallOf(method: string): {method: string, presentedToken: string | undefined} | undefined {
  const calls = callsOf(method);
  return calls[calls.length - 1];
}

afterEach(() => {
  vi.resetModules();
  socketHarness.reset();
  accountGet.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockReset();
});

describe('#675 pending two-factor credential', () => {
  it(
    'retains the opaque pending-token from a real SESSION_PASSWORD_NEEDED rejection and presents it on the very next ' +
    'allowed call for that account, without synthesizing a session',
    async() => {
      accountGet.mockResolvedValue(undefined); // a genuinely fresh, never-signed-in slot
      respondAll({
        [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {
          'error-description': 'Two-factor authentication required',
          'pending-token': 'fixture-pending-token-1'
        }),
        [GET_PASSWORD]: answered()
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      const signInOutcome = await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1)
        .then(() => 'resolved', (error: any) => ({type: error?.type, code: error?.code}));

      expect(
        signInOutcome,
        'SESSION_PASSWORD_NEEDED must still surface to the caller unchanged — AuthCodeCard navigates ' +
        'to the password card on exactly this shape (AuthCodeCard.tsx:127-129) and must keep doing so'
      ).toEqual({type: 'SESSION_PASSWORD_NEEDED', code: 401});

      expect(
        getGrpcSessionToken(1),
        'a pending 2FA challenge is not a session — no session token may appear from it alone'
      ).toBeUndefined();

      // The in-memory getter and the connection check below can both pass even if the captured token never reaches
      // storage — a reload would still land unauthenticated. This must observe the persistence boundary directly.
      expect(
        accountUpdate,
        'capturing a pending token must persist it to this slot\'s AccountController record — the same place ' +
        'impulse_session_token/impulse_refresh_token already live (worker-211 §2) — not only hold it in memory. ' +
        'Without this, a reload while a challenge is still pending loses it and repeats the original #675 ' +
        'unauthenticated getPassword call.'
      ).toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: 'fixture-pending-token-1'}));

      await grpcInvoke(GET_PASSWORD, {}, 1);

      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'account.getPassword must present the pending token as its connection token once SESSION_PASSWORD_NEEDED ' +
        'has handed this slot one — today it goes out with no token at all, which is exactly the rejection ' +
        'JwtValidationInterceptor.cs:196-198 answers with AUTH_KEY_UNREGISTERED (the live evidence trace)'
      ).toBe('fixture-pending-token-1');
    }
  );

  it('never lets a different account slot borrow the pending token', async() => {
    accountGet.mockResolvedValue(undefined);
    respondAll({
      [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-1'}),
      [GET_PASSWORD]: answered()
    });

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');

    await Promise.all([restoreImpulseSession(1), restoreImpulseSession(2)]);

    await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});

    await grpcInvoke(GET_PASSWORD, {}, 2);

    const getPasswordOnSlot2 = callsOf(GET_PASSWORD);

    expect(getPasswordOnSlot2.length, 'the slot-2 call must actually have gone out to assert about it').toBeGreaterThan(0);
    expect(
      getPasswordOnSlot2.every((call) => call.presentedToken === undefined),
      'a different account slot must never borrow another slot\'s pending token — the same #436 per-account ' +
      'isolation every other credential already gets'
    ).toBe(true);
  });

  it(
    'prefers a real full-session token over a stored pending token on the same slot, and dropping the pending token ' +
    'via clearImpulseSession leaves the slot with no token at all once the session is gone too',
    async() => {
      accountGet.mockResolvedValue(undefined);
      respondAll({
        [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-1'}),
        [GET_PASSWORD]: answered()
      });

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {setGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);
      await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});

      // A real session token arrives (e.g. a successful checkPassword elsewhere in the app) while the pending token is
      // still on the slot — it must win.
      setGrpcSessionToken(1, 'real-session-token');
      await grpcInvoke(GET_PASSWORD, {}, 1);
      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'a real session token must take precedence over a stored pending token on the same slot'
      ).toBe('real-session-token');

      // Explicit clearing (success, abandoned login, or logOut all funnel through clearImpulseSession) must drop the
      // PENDING token itself, not merely be shadowed by whatever real session happened to exist.
      setGrpcSessionToken(1, undefined);
      clearImpulseSession(1);
      await grpcInvoke(GET_PASSWORD, {}, 1);
      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'clearImpulseSession must drop the pending token itself — a stale one left behind would let a genuinely new or ' +
        'abandoned login on this slot silently authenticate against an old challenge'
      ).toBeUndefined();
    }
  );

  it(
    'restores a persisted pending challenge before the first password request, with no session on the record, and ' +
    'presents it from that alone',
    async() => {
      accountGet.mockImplementation(async(accountNumber: number) => (
        accountNumber === 1 ? {impulse_pending_token: 'fixture-persisted-pending-token'} : undefined
      ));
      respondAll({[GET_PASSWORD]: answered()});

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      expect(
        getGrpcSessionToken(1),
        'a persisted pending-only record is not a session — restore must not treat it as one'
      ).toBeUndefined();

      await grpcInvoke(GET_PASSWORD, {}, 1);

      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'a reload or SharedWorker restart that finds a persisted pending token must restore it BEFORE the password ' +
        'card\'s first getPassword call — otherwise this call goes out unauthenticated exactly like the live incident\'s reload'
      ).toBe('fixture-persisted-pending-token');
    }
  );

  /*
   * #675 revision2 — the two confirmed production blockers. The error types are the server's own: a pending token
   * the server refuses as expired (AUTH_KEY_UNREGISTERED, JwtValidationInterceptor.cs:208-209) or as revoked or
   * consumed (AUTH_TOKEN_INVALID, pending-revoked, :286-295). Both tests react only to the case a real client reaches
   * for a call it KNOWS it just made with its own pending token and no session.
   */

  it(
    'clears a pending-scoped call\'s own token — memory and persisted — on an authoritative AUTH_TOKEN_INVALID ' +
    'rejection, leaving a different account slot\'s own pending token and this slot\'s own (absent) session untouched',
    async() => {
      accountGet.mockResolvedValue(undefined);
      respondAll({
        [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-1'}),
        [GET_PASSWORD]: rejecting('AUTH_TOKEN_INVALID')
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken, setGrpcPendingToken, getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');

      await Promise.all([restoreImpulseSession(1), restoreImpulseSession(2)]);

      await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});
      expect(
        getGrpcPendingToken(1),
        'setup precondition: slot 1 must actually hold the pending token this test then has rejected'
      ).toBe('fixture-pending-token-1');

      // A different account slot's own, unrelated pending token — must survive whatever happens to slot 1 below.
      setGrpcPendingToken(2, 'fixture-pending-token-2');

      await grpcInvoke(GET_PASSWORD, {}, 1).catch(() => {});

      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'setup precondition: the rejected call must actually have presented fixture-pending-token-1 — otherwise this ' +
        'test would not be exercising the token it claims to'
      ).toBe('fixture-pending-token-1');

      expect(
        getGrpcPendingToken(1),
        'a pending-scoped call that came back AUTH_TOKEN_INVALID for the token this slot itself just presented must ' +
        'clear that token — otherwise the client keeps re-presenting a rejected credential on every later call, forever'
      ).toBeUndefined();
      expect(
        accountClearFields,
        'clearing must also drop the PERSISTED pending token, not just the in-memory copy — a reload would otherwise ' +
        'restore the same dead token right back (restoreImpulseSession)'
      ).toHaveBeenCalledWith(1, ['impulse_pending_token']);
      expect(getGrpcSessionToken(1), 'clearing a rejected pending token must never fabricate a session').toBeUndefined();
      expect(
        getGrpcPendingToken(2),
        'clearing slot 1\'s rejected pending token must not touch a different account slot\'s own, unrelated pending token (#436)'
      ).toBe('fixture-pending-token-2');
    }
  );

  it(
    'clears a pending-scoped call\'s own token on an authoritative AUTH_TOKEN_INVALID (revoked / already-consumed) ' +
    'rejection of a pending token the server has revoked or consumed (JwtValidationInterceptor.cs:286-295, pending-revoked)',
    async() => {
      accountGet.mockResolvedValue(undefined);
      respondAll({
        [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-1'}),
        [GET_PASSWORD]: rejecting('AUTH_TOKEN_INVALID')
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);
      await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});
      expect(getGrpcPendingToken(1)).toBe('fixture-pending-token-1');

      await grpcInvoke(GET_PASSWORD, {}, 1).catch(() => {});

      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'setup precondition: the rejected call must have presented the pending token'
      ).toBe('fixture-pending-token-1');

      expect(
        getGrpcPendingToken(1),
        'AUTH_TOKEN_INVALID for the token this slot itself just presented means that specific pending token is dead ' +
        '(revoked or consumed) — it must be cleared too'
      ).toBeUndefined();
      expect(accountClearFields).toHaveBeenCalledWith(1, ['impulse_pending_token']);
    }
  );

  it(
    'still captures the pending token normally from auth.signIn when nothing has superseded the attempt before its ' +
    'response arrives (positive control for the two staleness tests below)',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      const signIn = deferredReply();
      socketHarness.respondOnce(SIGN_IN, () => signIn.promise);
      const signInCall = grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch((error: any) => ({type: error?.type}));

      signIn.reject(serverError('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-current'}));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'an ordinary, un-superseded SESSION_PASSWORD_NEEDED must still be captured — the staleness guard the next two ' +
        'tests require must not turn into "never capture anything"'
      ).toBe('fixture-pending-token-current');
    }
  );

  it(
    'a stale in-flight SESSION_PASSWORD_NEEDED cannot reintroduce its own abandoned pending token once a newer login ' +
    'attempt has already begun on the same slot',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      // Attempt X (phone A): auth.signIn is issued but its response is held back.
      const signInX = deferredReply();
      socketHarness.respondOnce(SIGN_IN, () => signInX.promise);
      const signInXCall = grpcInvoke(SIGN_IN, {...SIGN_IN_ARGS, phone_code_hash: 'fixture-hash-x'}, 1).catch((error: any) => ({type: error?.type}));

      // Attempt Y (a DIFFERENT phone) supersedes X: a fresh code is sent before X's signIn ever settles.
      socketHarness.respondOnce(SEND_CODE, answered());
      await grpcInvoke(SEND_CODE, SEND_CODE_ARGS, 1);

      // X's stale signIn now finally resolves, carrying X's own (abandoned) pending token.
      signInX.reject(serverError('SESSION_PASSWORD_NEEDED', {'pending-token': 'stale-pending-token-x'}));
      await signInXCall;

      expect(
        getGrpcPendingToken(1),
        'a SESSION_PASSWORD_NEEDED response belonging to an attempt already abandoned before it arrived (a newer ' +
        'auth.sendCode succeeded first) must not reintroduce that attempt\'s own pending token onto the slot — the ' +
        'slot must end up with none at all, not merely "not X"'
      ).toBeUndefined();
    }
  );

  it(
    'a new sendCode attempt invalidates an older in-flight signIn as soon as it BEGINS, not only once it succeeds — ' +
    'releasing the old SESSION_PASSWORD_NEEDED while sendCode is still pending must not capture it, in memory or persisted',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      // Old attempt (phone X): signIn issued, held back.
      const signInX = deferredReply();
      socketHarness.respondOnce(SIGN_IN, () => signInX.promise);
      const signInXCall = grpcInvoke(SIGN_IN, {...SIGN_IN_ARGS, phone_code_hash: 'fixture-hash-x'}, 1).catch((error: any) => ({type: error?.type}));

      // A new attempt (phone Y) BEGINS — sendCode is issued but its OWN response is also held back, not yet successful.
      const sendCodeY = deferredReply();
      socketHarness.respondOnce(SEND_CODE, () => sendCodeY.promise);
      const sendCodeYCall = grpcInvoke(SEND_CODE, SEND_CODE_ARGS, 1).catch((error: any) => ({type: error?.type}));

      // X's stale SESSION_PASSWORD_NEEDED arrives BEFORE sendCode has resolved at all.
      signInX.reject(serverError('SESSION_PASSWORD_NEEDED', {'pending-token': 'stale-pending-token-during-sendcode'}));
      await signInXCall;

      expect(
        getGrpcPendingToken(1),
        'an already-in-flight (not yet successful) new sendCode attempt must invalidate an older signIn\'s own eventual ' +
        'SESSION_PASSWORD_NEEDED — capturing it here would restore a pending challenge for an attempt the user has ' +
        'already moved past, before the new attempt has even finished starting'
      ).toBeUndefined();
      expect(
        accountUpdate,
        'the stale response must not persist the abandoned pending token either, for the same reason'
      ).not.toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: expect.anything()}));

      sendCodeY.resolve({data: new Uint8Array(0)});
      await sendCodeYCall;

      expect(
        getGrpcPendingToken(1),
        'once both calls have fully settled the slot must still hold no pending token — sendCode\'s own success carries ' +
        'none to capture, and X\'s was already correctly discarded above'
      ).toBeUndefined();
    }
  );

  // A clearing that ignores which token was rejected would fail here: it must check the rejected call was for the token
  // still current.
  it(
    'a late rejection belonging to an old, already-superseded pending token cannot clear the NEWER pending token that ' +
    'has since replaced it on the same slot',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      // T1 is captured first, ordinarily.
      socketHarness.respondOnce(SIGN_IN, rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'old-pending-token-t1'}));
      await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});
      expect(getGrpcPendingToken(1)).toBe('old-pending-token-t1');

      // A pending-scoped call using T1 is issued but held back — its rejection arrives LATE, below.
      const oldGetPassword = deferredReply();
      socketHarness.respondOnce(GET_PASSWORD, () => oldGetPassword.promise);
      const oldGetPasswordCall = grpcInvoke(GET_PASSWORD, {}, 1).catch((error: any) => ({type: error?.type}));

      // Meanwhile T1 is superseded by T2 on the SAME slot.
      socketHarness.respondOnce(SIGN_IN, rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'newer-pending-token-t2'}));
      await grpcInvoke(SIGN_IN, {...SIGN_IN_ARGS, phone_code: '22222'}, 1).catch(() => {});
      expect(getGrpcPendingToken(1), 'setup: T2 must actually be current before the late rejection arrives').toBe('newer-pending-token-t2');

      // NOW the OLD in-flight call — issued while T1 was current — finally rejects as dead.
      oldGetPassword.reject(serverError('AUTH_TOKEN_INVALID'));
      await oldGetPasswordCall;

      expect(
        getGrpcPendingToken(1),
        'a late rejection for an OLD pending token (T1) must not clear the NEWER pending token (T2) that has since replaced ' +
        'it — clearing must be tied to the specific token that was rejected, not to whatever is current when the response arrives'
      ).toBe('newer-pending-token-t2');
    }
  );

  it(
    'a stale SESSION_PASSWORD_NEEDED arriving after this slot has already logged out must not reintroduce a pending ' +
    'token, in memory or persisted',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      // A signIn is issued and held back, then superseded by a LOGOUT instead of a newer attempt.
      const signIn = deferredReply();
      socketHarness.respondOnce(SIGN_IN, () => signIn.promise);
      const signInCall = grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch((error: any) => ({type: error?.type}));

      // The slot logs out while that signIn is still in flight (clearImpulseSession, which apiManager.logOut() calls).
      clearImpulseSession(1);
      accountClearFields.mockClear();
      accountUpdate.mockClear();

      // The stale signIn now finally resolves, carrying an abandoned pending token.
      signIn.reject(serverError('SESSION_PASSWORD_NEEDED', {'pending-token': 'stale-pending-token-after-logout'}));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'a SESSION_PASSWORD_NEEDED response belonging to an attempt this slot already logged out of before it arrived ' +
        'must not reintroduce a pending token in memory'
      ).toBeUndefined();
      expect(
        accountUpdate,
        'the stale response must not persist the abandoned pending token either — logout already cleared the persisted field'
      ).not.toHaveBeenCalledWith(1, expect.objectContaining({impulse_pending_token: expect.anything()}));
    }
  );

  it(
    'a pending-scoped request rejected AFTER this slot has since gained a full session leaves that session untouched ' +
    'and does not restore the old pending identity',
    async() => {
      accountGet.mockResolvedValue(undefined);

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken, getGrpcPendingToken, setGrpcSessionToken, setGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);

      // An old pending token exists before anything else happens.
      setGrpcPendingToken(1, 'old-pending-token');

      // A pending-scoped account.getPassword is issued (presenting that token) and held back.
      const oldGetPassword = deferredReply();
      socketHarness.respondOnce(GET_PASSWORD, () => oldGetPassword.promise);
      const oldGetPasswordCall = grpcInvoke(GET_PASSWORD, {}, 1).catch((error: any) => ({type: error?.type}));

      // Let the call actually reach the (stubbed) connection — observed, not guessed from a scheduling delay.
      await vi.waitFor(() => {
        expect(lastCallOf(GET_PASSWORD)?.presentedToken, 'the old pending-scoped call has not reached the stubbed connection yet')
          .toBe('old-pending-token');
      });

      // The slot gains a FULL session in the meantime; production's own capture path clears pending in the same step.
      setGrpcSessionToken(1, 'real-session-token');
      setGrpcPendingToken(1, undefined);

      // NOW the old, pre-session pending-scoped call finally rejects.
      oldGetPassword.reject(serverError('AUTH_TOKEN_INVALID'));
      await oldGetPasswordCall;

      expect(
        getGrpcSessionToken(1),
        'a late rejection belonging to a call issued BEFORE this slot had a session must not clear or otherwise disturb ' +
        'the real session the slot has since acquired'
      ).toBe('real-session-token');
      expect(
        getGrpcPendingToken(1),
        'the late rejection must not restore the old, already-cleared pending identity onto a slot that has already moved past the pending stage'
      ).toBeUndefined();
    }
  );

  // #675 revision3, item A — a call issued while restore is still in flight waits for it, and a logout landing
  // meanwhile must not be undone by the restore's stale read.
  it(
    'a call issued while restoring a persisted pending challenge waits for that genuinely in-flight restore to finish, ' +
    'then presents the token restore just loaded',
    async() => {
      let resolveAccountGet!: (value: {impulse_pending_token: string} | undefined) => void;
      accountGet.mockImplementation(() => new Promise((resolve) => {
        resolveAccountGet = resolve;
      }));
      respondAll({[GET_PASSWORD]: answered()});

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      // Restore is started but deliberately left pending.
      const restorePromise = restoreImpulseSession(1);

      // Issued while that restore is still genuinely in flight.
      const invokePromise = grpcInvoke(GET_PASSWORD, {}, 1);

      // The persisted record now arrives, carrying a pending challenge from before the reload.
      resolveAccountGet({impulse_pending_token: 'fixture-persisted-pending-token-boot'});
      await restorePromise;
      await invokePromise;

      expect(
        getGrpcPendingToken(1),
        'setup precondition: restore must have actually loaded the persisted token for the request below to prove anything about it'
      ).toBe('fixture-persisted-pending-token-boot');

      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'a request that started before restore finished must still end up presenting the token restore loaded once restore ' +
        'actually completes — the call has to wait for readiness, not race past it with whatever this slot held before restore ran'
      ).toBe('fixture-persisted-pending-token-boot');
    }
  );

  it(
    'a logout that completes WHILE restore is still genuinely pending still invalidates an in-flight signIn issued before ' +
    'it, AND restore must not resurrect a real, nonempty persisted pending token onto a slot the same logout already cleared',
    async() => {
      let resolveAccountGet!: (value: {impulse_pending_token: string}) => void;
      accountGet.mockImplementation(() => new Promise((resolve) => {
        resolveAccountGet = resolve;
      }));

      const {restoreImpulseSession, clearImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      // Restore is started but its own storage read has not resolved yet.
      const restorePromise = restoreImpulseSession(1);

      // signIn is issued while restore is still genuinely pending.
      const signIn = deferredReply();
      socketHarness.respondOnce(SIGN_IN, () => signIn.promise);
      const signInCall = grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch((error: any) => ({type: error?.type}));

      // The slot logs out while readiness is still unsettled.
      void clearImpulseSession(1);

      // Restore's own storage read now arrives carrying a real, nonempty persisted pending token that the logout revoked.
      resolveAccountGet({impulse_pending_token: 'fixture-pending-token-revoked-by-concurrent-logout'});
      await restorePromise;

      // signIn's own response finally arrives, carrying a pending token for an attempt this slot was already logged out of.
      signIn.reject(serverError('SESSION_PASSWORD_NEEDED', {'pending-token': 'stale-pending-token-during-restore'}));
      await signInCall;

      expect(
        getGrpcPendingToken(1),
        'a logout that lands while this call was still waiting on a genuinely pending restore must leave this slot with NO ' +
        'pending token once everything above has settled — neither the stale signIn\'s own token nor the real persisted token ' +
        'restore read back from storage before the logout\'s persisted clear could land'
      ).toBeUndefined();

      // The resurrected credential must not merely sit unused in memory — a subsequent allowed call must not attach it either.
      socketHarness.respondOnce(GET_PASSWORD, answered());
      await grpcInvoke(GET_PASSWORD, {}, 1);
      expect(
        lastCallOf(GET_PASSWORD)?.presentedToken,
        'a request issued after this slot logged out must never present the credential restore resurrected — the slot is ' +
        'signed out and pending-less; nothing it sends should authenticate as if the revoked challenge were still current'
      ).toBeUndefined();
    }
  );

  it(
    'a method outside the pending set is refused with SESSION_PASSWORD_NEEDED, which leaves the pending challenge intact: ' +
    'auth.checkPassword still presents the same pending token afterwards',
    async() => {
      accountGet.mockResolvedValue(undefined);
      respondAll({
        [SIGN_IN]: rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': 'fixture-pending-token-1'}),
        [GET_LANG_PACK]: rejecting('SESSION_PASSWORD_NEEDED'),
        [CHECK_PASSWORD]: answered()
      });

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);
      await grpcInvoke(SIGN_IN, SIGN_IN_ARGS, 1).catch(() => {});

      const outcome = await grpcInvoke(GET_LANG_PACK, {}, 1)
        .then(() => 'resolved', (error: any) => ({type: error?.type, code: error?.code}));

      expect(
        outcome,
        'the server refuses a method outside the pending set with SESSION_PASSWORD_NEEDED (401): the caller sees that answer'
      ).toEqual({type: 'SESSION_PASSWORD_NEEDED', code: 401});
      expect(getGrpcPendingToken(1), 'SESSION_PASSWORD_NEEDED leaves the pending challenge intact').toBe('fixture-pending-token-1');

      await grpcInvoke(CHECK_PASSWORD, {}, 1);
      expect(
        lastCallOf(CHECK_PASSWORD)?.presentedToken,
        'auth.checkPassword still presents the same pending token after the stray refusal'
      ).toBe('fixture-pending-token-1');
    }
  );
});
