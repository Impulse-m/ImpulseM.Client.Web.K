import {beforeEach, describe, expect, it, vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import type {UpdateSocketReply} from './helpers/updateSocketStub';
import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';
import {registerSessionIdentitySource} from './helpers/fleetIdentitySource';

/*
 * A storage failure of a pending-token write reaches the caller of the call that caused it. The server's answer is never
 * replaced by the local write: the failure is recorded on that answer.
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

const ACCOUNT: ActiveAccountNumber = 1;
const SIGN_IN = 'auth.signIn';
const GET_PASSWORD = 'account.getPassword';
const SEND_CODE = 'auth.sendCode';
const SIGN_IN_ARGS = {phone_number: '+9996611111', phone_code_hash: 'fixture-hash', phone_code: '11111'};
const SEND_CODE_ARGS = {phone_number: '+9996622222', api_id: 1, api_hash: 'fixture-hash', settings: {_: 'codeSettings', pFlags: {}}};
const STORAGE_FAILURE: Error = new Error('storage unavailable');
const PENDING_TOKEN: string = 'fixture-pending-token-1';

const APP_CODE_OF: Record<string, number> = {
  SESSION_PASSWORD_NEEDED: 401,
  AUTH_TOKEN_INVALID: 400
};

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

function outcomeOf(call: Promise<unknown>): Promise<unknown> {
  return call.then((): string => 'resolved', (error: unknown): unknown => error);
}

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  accountGet.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockReset();
  accountGet.mockResolvedValue(undefined);
  accountUpdate.mockResolvedValue(undefined);
  accountClearFields.mockResolvedValue(undefined);
  await registerSessionIdentitySource();
});

describe('a storage failure of the pending token write reaches the caller of the call that wrote it', () => {
  it('a new code request reports the failed clear of the stale challenge instead of sending as if it were clean', async() => {
    accountClearFields.mockRejectedValue(STORAGE_FAILURE);
    socketHarness.respond(SEND_CODE, answered());

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    await restoreImpulseSession(ACCOUNT);

    await expect(
      outcomeOf(grpcInvoke(SEND_CODE, SEND_CODE_ARGS, ACCOUNT)),
      'the new code request must not report success while the stale challenge it supersedes stays in storage'
    ).resolves.toBe(STORAGE_FAILURE);
  });

  it('a refused challenge keeps its AUTH_TOKEN_INVALID answer, with the failed clear recorded on it', async() => {
    accountClearFields.mockRejectedValue(STORAGE_FAILURE);
    socketHarness.respond(SIGN_IN, rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': PENDING_TOKEN}));
    socketHarness.respond(GET_PASSWORD, rejecting('AUTH_TOKEN_INVALID'));

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    await restoreImpulseSession(ACCOUNT);
    await outcomeOf(grpcInvoke(SIGN_IN, SIGN_IN_ARGS, ACCOUNT));

    const outcome = await outcomeOf(grpcInvoke(GET_PASSWORD, {}, ACCOUNT));

    expect(
      outcome,
      'the refusal of the presented token is the answer the caller gets; a failed local clear must not replace it'
    ).toMatchObject({type: 'AUTH_TOKEN_INVALID'});
    expect(
      (outcome as {cause?: unknown}).cause,
      'the storage failure of the clear is recorded on the refusal the caller receives'
    ).toBe(STORAGE_FAILURE);
  });

  it('a new challenge keeps its SESSION_PASSWORD_NEEDED answer, with the failed write recorded on it', async() => {
    accountUpdate.mockRejectedValue(STORAGE_FAILURE);
    socketHarness.respond(SIGN_IN, rejecting('SESSION_PASSWORD_NEEDED', {'pending-token': PENDING_TOKEN}));

    const {restoreImpulseSession} = await import('@lib/impulse/session');
    const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
    const {getGrpcPendingToken} = await import('@lib/impulse/grpc/credentials');
    await restoreImpulseSession(ACCOUNT);

    const outcome = await outcomeOf(grpcInvoke(SIGN_IN, SIGN_IN_ARGS, ACCOUNT));

    expect(
      outcome,
      'SESSION_PASSWORD_NEEDED is the answer the password card needs; a failed persist must not replace it'
    ).toMatchObject({type: 'SESSION_PASSWORD_NEEDED', code: 401});
    expect((outcome as {cause?: unknown}).cause, 'the failed persist is recorded on that answer').toBe(STORAGE_FAILURE);
    expect(
      getGrpcPendingToken(ACCOUNT),
      'the challenge stays usable for this tab even though its persist failed'
    ).toBe(PENDING_TOKEN);
  });
});
