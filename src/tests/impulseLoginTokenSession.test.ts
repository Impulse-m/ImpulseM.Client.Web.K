import {afterEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {
  AuthAuthorizationSchema,
  AuthAuthorizationValueSchema,
  AuthLoginTokenSchema,
  AuthLoginTokenSuccessSchema
} from '@lib/impulse/grpc/gen/v1/types_pb';

import {sharedUpdateSocketHarness} from './helpers/updateSocketStub';

/*
 * A QR login completes through auth.exportLoginToken, which answers auth.loginTokenSuccess.
 * On the wire the session and refresh tokens sit one level down, under
 * AuthLoginTokenSuccess.authorization, so captureImpulseSessionToken must read them there.
 * These tests drive grpcInvoke through the update socket, answered by its stand-in, and observe the
 * persistence boundary (AccountController.update) and the in-memory session token.
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

const EXPORT_LOGIN_TOKEN = 'auth.exportLoginToken';
const FIXTURE_SESSION_TOKEN = 'fixture-login-session-token';
const FIXTURE_REFRESH_TOKEN = 'fixture-login-refresh-token';

function loginTokenSuccessPayload(): Uint8Array {
  const loginToken = create(AuthLoginTokenSchema, {
    value: {
      case: 'authLoginTokenSuccess',
      value: create(AuthLoginTokenSuccessSchema, {
        authorization: create(AuthAuthorizationSchema, {
          value: {
            case: 'authAuthorization',
            value: create(AuthAuthorizationValueSchema, {
              sessionToken: FIXTURE_SESSION_TOKEN,
              refreshToken: FIXTURE_REFRESH_TOKEN
            })
          }
        })
      })
    }
  });

  return toBinary(AuthLoginTokenSchema, loginToken);
}

afterEach(() => {
  vi.resetModules();
  socketHarness.reset();
  accountGet.mockReset();
  accountClearFields.mockReset();
  accountUpdate.mockReset();
});

describe('QR login session token capture', () => {
  it(
    'stores and persists the session and refresh tokens carried by an auth.loginTokenSuccess reply',
    async() => {
      accountGet.mockResolvedValue(undefined);
      accountUpdate.mockResolvedValue(undefined);
      socketHarness.respondOnce(EXPORT_LOGIN_TOKEN, () => ({data: loginTokenSuccessPayload()}));

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken} = await import('@lib/impulse/grpc/credentials');

      await restoreImpulseSession(1);
      await grpcInvoke('auth.exportLoginToken', {}, 1);

      expect(
        getGrpcSessionToken(1),
        'a loginTokenSuccess reply must put its session token on the credentials of this slot; ' +
        'the token sits under authorization, not at the top level of the reply'
      ).toBe(FIXTURE_SESSION_TOKEN);

      expect(
        accountUpdate,
        'the session and refresh tokens from a loginTokenSuccess reply must be persisted to this ' +
        'slot\'s AccountController record, or a reload loses the session and the next call is ' +
        'unauthenticated'
      ).toHaveBeenCalledWith(1, {
        impulse_session_token: FIXTURE_SESSION_TOKEN,
        impulse_refresh_token: FIXTURE_REFRESH_TOKEN
      });
    }
  );
});
