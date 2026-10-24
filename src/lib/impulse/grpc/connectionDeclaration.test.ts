import {beforeEach, describe, expect, it, vi} from 'vitest';
import {create, fromBinary, toBinary} from '@bufbuild/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {sharedUpdateSocketHarness} from '../../../tests/helpers/updateSocketStub';
import {registerSessionIdentitySource} from '../../../tests/helpers/fleetIdentitySource';
import {
  InitConnectionRequestSchema,
  InitConnectionResponseSchema
} from './gen/v1/internal/impulse/auth/auth_types_pb';
import type {ConnectionDeclarationValues} from './credentials';

const {accountGet, accountUpdate, accountClearFields} = vi.hoisted(() => ({
  accountGet: vi.fn(),
  accountUpdate: vi.fn(),
  accountClearFields: vi.fn()
}));

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  const {sharedUpdateSocketHarness: harness} = await import('../../../tests/helpers/updateSocketStub');
  return {...actual, Centrifuge: harness().CentrifugeStub};
});

vi.mock('@lib/accounts/accountController', () => ({
  default: {
    get: accountGet,
    update: accountUpdate,
    clearFields: accountClearFields
  }
}));

const socketHarness = sharedUpdateSocketHarness();
const INIT_CONNECTION: string = 'initConnection';
const ACCOUNT_ONE = 1 as ActiveAccountNumber;
const ACCOUNT_TWO = 2 as ActiveAccountNumber;

function values(deviceModel: string): ConnectionDeclarationValues {
  return {
    apiId: 4,
    deviceModel,
    systemVersion: 'Linux x86_64',
    appVersion: '1.0 K',
    systemLangCode: 'en',
    langPack: 'webk',
    langCode: 'en',
    tzOffset: 10800
  };
}

function declaredDevice(data: Uint8Array): string | undefined {
  return fromBinary(InitConnectionRequestSchema, data).declaration?.deviceModel;
}

function emptyAnswer(): {data: Uint8Array} {
  return {data: toBinary(InitConnectionResponseSchema, create(InitConnectionResponseSchema, {}))};
}

function answerInitConnection(): void {
  socketHarness.respond(INIT_CONNECTION, () => emptyAnswer());
}

/** One InitConnection that stays in flight until the test releases it. */
function heldInitConnection(): {release: () => void} {
  let release!: () => void;
  socketHarness.respondOnce(INIT_CONNECTION, () => new Promise<void>((resolve: () => void): void => {
    release = resolve;
  }).then((): {data: Uint8Array} => emptyAnswer()));
  return {release: (): void => release()};
}

// Every module is loaded after the reset, so the session and the credentials it reads are one instance.
async function load() {
  const session = await import('@lib/impulse/session');
  const credentials = await import('./credentials');
  return {...session, ...credentials};
}

beforeEach(async() => {
  vi.resetModules();
  socketHarness.reset();
  accountGet.mockReset();
  accountUpdate.mockReset();
  accountClearFields.mockReset();
  accountGet.mockResolvedValue(undefined);
  await registerSessionIdentitySource();
  const {setGrpcSessionToken, resetConnectionInited, setConnectionDeclaration, restoreImpulseSession} = await load();
  // The boot opens every slot's gate; a call of this file has to pass it like any call of the app.
  await restoreImpulseSession(ACCOUNT_ONE);
  await restoreImpulseSession(ACCOUNT_TWO);
  for(const account of [ACCOUNT_ONE, ACCOUNT_TWO]) {
    setGrpcSessionToken(account, undefined);
    resetConnectionInited(account);
    setConnectionDeclaration(account, values('reset'));
    resetConnectionInited(account);
  }
});

describe('the connection declaration travels as the body of InitConnection', () => {
  it('is not sent while signed out', async() => {
    const {setConnectionDeclaration, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));

    expect(await ensureConnectionDeclared(ACCOUNT_ONE)).toBe(false);
    expect(socketHarness.calls, 'InitConnection binds a declaration to a session: there is none to bind').toHaveLength(0);
    expect(isConnectionInited(ACCOUNT_ONE)).toBe(false);
  });

  it('is sent once while signed in, with the declared values, and marks the slot inited on success', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    answerInitConnection();

    expect(await ensureConnectionDeclared(ACCOUNT_ONE)).toBe(true);

    expect(socketHarness.calls.map((call) => call.method)).toEqual([INIT_CONNECTION]);
    expect(declaredDevice(socketHarness.calls[0].data), 'the declaration rides the request body').toBe('Firefox');
    expect(isConnectionInited(ACCOUNT_ONE)).toBe(true);
    expect(await ensureConnectionDeclared(ACCOUNT_ONE)).toBe(true);
    expect(socketHarness.calls, 'an inited slot sends nothing more').toHaveLength(1);
  });

  it('concurrent callers share one InitConnection in flight', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const held = heldInitConnection();

    const first = ensureConnectionDeclared(ACCOUNT_ONE);
    const second = ensureConnectionDeclared(ACCOUNT_ONE);
    await vi.waitFor(() => expect(socketHarness.calls).toHaveLength(1));
    held.release();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(socketHarness.calls, 'a second caller must not send a second InitConnection').toHaveLength(1);
  });

  it('a failed InitConnection leaves the slot not inited and is recorded, not thrown into the caller', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    socketHarness.respondOnce(INIT_CONNECTION, () => {
      throw {code: 503, message: 'unavailable', appCode: 500, appType: 'INTERNAL_SERVER_ERROR'};
    });

    expect(await ensureConnectionDeclared(ACCOUNT_ONE), 'the failure is recorded in the answer of the handshake').toBe(false);
    expect(isConnectionInited(ACCOUNT_ONE)).toBe(false);
    expect(await ensureConnectionDeclared(ACCOUNT_ONE), 'a failed handshake is not retried at once').toBe(false);
    expect(socketHarness.calls).toHaveLength(1);
  });

  it('a changed declaration while InitConnection is in flight does not mark the slot inited', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const held = heldInitConnection();

    const inFlight = ensureConnectionDeclared(ACCOUNT_ONE);
    await vi.waitFor(() => expect(socketHarness.calls).toHaveLength(1));
    setConnectionDeclaration(ACCOUNT_ONE, values('My Laptop'));
    held.release();
    await inFlight;

    expect(isConnectionInited(ACCOUNT_ONE), 'the values changed while InitConnection was in flight').toBe(false);
  });

  it('a device rename clears the inited flag and the next declaration carries the new device', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    answerInitConnection();
    await ensureConnectionDeclared(ACCOUNT_ONE);

    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    expect(isConnectionInited(ACCOUNT_ONE), 'the same values change nothing').toBe(true);

    setConnectionDeclaration(ACCOUNT_ONE, values('My Laptop'));
    expect(isConnectionInited(ACCOUNT_ONE)).toBe(false);

    await ensureConnectionDeclared(ACCOUNT_ONE);
    expect(declaredDevice(socketHarness.calls[1].data)).toBe('My Laptop');
  });

  it('resetting the slot (logout, CONNECTION_NOT_INITED) makes the next declaration send again', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, resetConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    answerInitConnection();
    await ensureConnectionDeclared(ACCOUNT_ONE);

    resetConnectionInited(ACCOUNT_ONE);
    await ensureConnectionDeclared(ACCOUNT_ONE);

    expect(socketHarness.calls, 'a reset slot declares itself again').toHaveLength(2);
  });

  it('keeps accounts apart: values, flag and handshake are per slot', async() => {
    const {setConnectionDeclaration, setGrpcSessionToken, ensureConnectionDeclared, isConnectionInited} = await load();
    setConnectionDeclaration(ACCOUNT_ONE, values('One'));
    setConnectionDeclaration(ACCOUNT_TWO, values('Two'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token-one');
    answerInitConnection();

    await ensureConnectionDeclared(ACCOUNT_ONE);

    expect(isConnectionInited(ACCOUNT_ONE)).toBe(true);
    expect(isConnectionInited(ACCOUNT_TWO)).toBe(false);
    expect(await ensureConnectionDeclared(ACCOUNT_TWO), 'the second slot has no session, so it sends nothing').toBe(false);
    expect(socketHarness.calls).toHaveLength(1);
  });
});
