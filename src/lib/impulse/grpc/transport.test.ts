import {beforeEach, describe, expect, it} from 'vitest';
import {fromBinary} from '@bufbuild/protobuf';
import {createContextValues, decodeBinaryHeader} from '@connectrpc/connect';
import type {Interceptor, UnaryRequest, UnaryResponse} from '@connectrpc/connect';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {AuthService} from './gen/v1/internal/impulse/auth/auth_service_pb';
import {ConnectionDeclarationSchema} from './gen/v1/internal/impulse/auth/auth_types_pb';
import {
  bindDeclarationToNewSession,
  createAuthInterceptor,
  isGrpcConnectionInited,
  resetConnectionInited,
  setConnectionDeclaration,
  setGrpcSessionToken,
  stampedDeclarationGenerationKey
} from './transport';
import type {ConnectionDeclarationValues, InitConnectionSender} from './transport';


const ACCOUNT_ONE = 1 as ActiveAccountNumber;
const ACCOUNT_TWO = 2 as ActiveAccountNumber;
const HEADER = 'x-impulse-init-connection-bin';

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

type Call = {
  header: Headers,
  contextValues: ReturnType<typeof createContextValues>
};

function request(typeName: string, methodName: string): UnaryRequest {
  return {
    header: new Headers(),
    contextValues: createContextValues(),
    service: {typeName},
    method: {name: methodName}
  } as unknown as UnaryRequest;
}

async function call(
  interceptor: Interceptor,
  typeName = 'v1.help.Help',
  methodName = 'GetConfig'
): Promise<Call> {
  const req = request(typeName, methodName);
  const next = async(r: UnaryRequest): Promise<UnaryResponse> => ({
    header: new Headers(),
    trailer: new Headers(),
    message: {}
  } as unknown as UnaryResponse);
  await (interceptor as any)(next)(req);
  return {header: req.header, contextValues: req.contextValues};
}

function decoded(header: Headers) {
  return fromBinary(ConnectionDeclarationSchema, decodeBinaryHeader(header.get(HEADER)));
}

type Handshake = {
  sent: Array<{account: ActiveAccountNumber, declaration: ConnectionDeclarationValues}>,
  release: () => void,
  fail: (error: Error) => void,
  sender: InitConnectionSender
};

function deferredHandshake(): Handshake {
  const sent: Handshake['sent'] = [];
  let release!: () => void;
  let fail!: (error: Error) => void;
  const handshake: Handshake = {
    sent,
    release: () => release(),
    fail: (error: Error) => fail(error),
    sender: (account, declaration) => {
      sent.push({account, declaration});
      return new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    }
  };
  return handshake;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));


describe('connection declaration on the gRPC transport', () => {
  beforeEach(() => {
    for(const account of [ACCOUNT_ONE, ACCOUNT_TWO]) {
      setGrpcSessionToken(account, undefined);
      resetConnectionInited(account);
      setConnectionDeclaration(account, values('reset'));
      resetConnectionInited(account);
    }
  });

  it('stamps every call while not inited, carrying the declared values', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, deferredHandshake().sender);

    for(let index = 0; index < 3; ++index) {
      const {header} = await call(interceptor);
      const declaration = decoded(header);
      expect(declaration.apiId).toBe(4);
      expect(declaration.deviceModel).toBe('Firefox');
      expect(declaration.langPack).toBe('webk');
      expect(declaration.params?.tzOffset).toBe(10800);
    }
  });

  it('sends nothing but the header when signed out, on every call', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    await call(interceptor);
    await call(interceptor);
    await flush();

    expect(handshake.sent).toHaveLength(0);
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);
    expect((await call(interceptor)).header.has(HEADER)).toBe(true);
  });

  it('sends InitConnection once while signed in, never concurrently duplicated, and stops stamping after success', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    // None of these waits for the handshake; all are stamped because it has not finished.
    const first = await call(interceptor);
    const second = await call(interceptor);
    const third = await call(interceptor);
    expect(first.header.has(HEADER)).toBe(true);
    expect(second.header.has(HEADER)).toBe(true);
    expect(third.header.has(HEADER)).toBe(true);
    expect(handshake.sent).toHaveLength(1);
    expect(handshake.sent[0].declaration.deviceModel).toBe('Firefox');

    handshake.release();
    await flush();

    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);
    expect((await call(interceptor)).header.has(HEADER)).toBe(false);
    expect(handshake.sent).toHaveLength(1);
  });

  it('does not trigger a handshake from the InitConnection call itself', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    await call(interceptor, AuthService.typeName, 'InitConnection');

    expect(handshake.sent).toHaveLength(0);
  });

  it('re-stamps and re-binds after a value change (device rename)', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    await call(interceptor);
    handshake.release();
    await flush();
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);

    // Same values: nothing changes.
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);

    setConnectionDeclaration(ACCOUNT_ONE, values('My Laptop'));
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);

    const renamed = await call(interceptor);
    expect(decoded(renamed.header).deviceModel).toBe('My Laptop');
    expect(handshake.sent).toHaveLength(2);
    expect(handshake.sent[1].declaration.deviceModel).toBe('My Laptop');

    handshake.release();
    await flush();
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);
  });

  it('does not mark inited when the values changed while InitConnection was in flight', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    await call(interceptor);
    setConnectionDeclaration(ACCOUNT_ONE, values('My Laptop'));
    handshake.release();
    await flush();

    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);
  });

  it('stays not inited when InitConnection fails', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token');
    const handshake = deferredHandshake();
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, handshake.sender);

    await call(interceptor);
    handshake.fail(new Error('unavailable'));
    await flush();

    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);
    expect((await call(interceptor)).header.has(HEADER)).toBe(true);
  });

  it('a session-creating call that carried the declaration binds it; one that did not leaves the slot not inited', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, deferredHandshake().sender);

    const stamped = await call(interceptor, 'v1.auth.Auth', 'SignIn');
    bindDeclarationToNewSession(ACCOUNT_ONE, stamped.contextValues.get(stampedDeclarationGenerationKey));
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);

    bindDeclarationToNewSession(ACCOUNT_ONE, undefined);
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);
  });

  it('a stamp from before a value change does not bind the new values', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, deferredHandshake().sender);

    const stamped = await call(interceptor, 'v1.auth.Auth', 'SignIn');
    setConnectionDeclaration(ACCOUNT_ONE, values('My Laptop'));
    bindDeclarationToNewSession(ACCOUNT_ONE, stamped.contextValues.get(stampedDeclarationGenerationKey));

    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(false);
  });

  it('resetConnectionInited (logout, CONNECTION_NOT_INITED) makes the next call carry the declaration again', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('Firefox'));
    const interceptor = createAuthInterceptor(ACCOUNT_ONE, deferredHandshake().sender);
    bindDeclarationToNewSession(ACCOUNT_ONE, (await call(interceptor)).contextValues.get(stampedDeclarationGenerationKey));
    expect((await call(interceptor)).header.has(HEADER)).toBe(false);

    resetConnectionInited(ACCOUNT_ONE);

    expect((await call(interceptor)).header.has(HEADER)).toBe(true);
  });

  it('keeps accounts apart: values, flag and handshake are per slot', async() => {
    setConnectionDeclaration(ACCOUNT_ONE, values('One'));
    setConnectionDeclaration(ACCOUNT_TWO, values('Two'));
    setGrpcSessionToken(ACCOUNT_ONE, 'token-one');
    const handshakeOne = deferredHandshake();
    const handshakeTwo = deferredHandshake();
    const one = createAuthInterceptor(ACCOUNT_ONE, handshakeOne.sender);
    const two = createAuthInterceptor(ACCOUNT_TWO, handshakeTwo.sender);

    await call(one);
    handshakeOne.release();
    await flush();

    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);
    expect(isGrpcConnectionInited(ACCOUNT_TWO)).toBe(false);
    expect((await call(one)).header.has(HEADER)).toBe(false);
    expect(decoded((await call(two)).header).deviceModel).toBe('Two');
    expect(handshakeTwo.sent).toHaveLength(0);

    setConnectionDeclaration(ACCOUNT_TWO, values('Two renamed'));
    expect(isGrpcConnectionInited(ACCOUNT_ONE)).toBe(true);
  });
});
