import {afterEach, describe, expect, it, vi} from 'vitest';
import {create, toBinary} from '@bufbuild/protobuf';

import {
  AuthAuthorizationSchema,
  AuthAuthorizationValueSchema,
  AuthLoginTokenSchema,
  AuthLoginTokenSuccessSchema
} from '@lib/impulse/grpc/gen/v1/types_pb';

/*
 * A QR login completes through auth.exportLoginToken, which answers auth.loginTokenSuccess.
 * On the wire the session and refresh tokens sit one level down, under
 * AuthLoginTokenSuccess.authorization, so captureImpulseSessionToken must read them there.
 * These tests drive grpcInvoke with a real protobuf-encoded gRPC-web reply and observe the
 * persistence boundary (AccountController.update) and the in-memory session token.
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

const EXPORT_LOGIN_TOKEN_PATH = '/v1.auth.Auth/ExportLoginToken';
const FIXTURE_SESSION_TOKEN = 'fixture-login-session-token';
const FIXTURE_REFRESH_TOKEN = 'fixture-login-refresh-token';

function envelope(flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

function grpcWebReply(payload: Uint8Array): {status: number, headers: Headers, body: ReadableStream<Uint8Array>} {
  const message = envelope(0, payload);
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

function stubFetchReply(payload: Uint8Array): void {
  vi.stubGlobal('fetch', vi.fn(async(url: unknown) => {
    const path = new URL(String(url)).pathname;
    if(path !== EXPORT_LOGIN_TOKEN_PATH) {
      throw new Error(`stubFetchReply: unexpected gRPC-web path ${path}`);
    }

    return grpcWebReply(payload);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
      stubFetchReply(loginTokenSuccessPayload());

      const {restoreImpulseSession} = await import('@lib/impulse/session');
      const {grpcInvoke} = await import('@lib/impulse/grpc/adapter');
      const {getGrpcSessionToken} = await import('@lib/impulse/grpc/transport');

      await restoreImpulseSession(1);
      await grpcInvoke('auth.exportLoginToken', {}, 1);

      expect(
        getGrpcSessionToken(1),
        'a loginTokenSuccess reply must put its session token on the transport for this slot; ' +
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
