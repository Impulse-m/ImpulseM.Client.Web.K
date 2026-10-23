import {beforeEach, describe, expect, it, vi} from 'vitest';
import {UnauthorizedError, errorCodes} from '@impulsem/centrifuge/build/protobuf';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {callMediaFleet, mediaFleetAccessToken, setMediaFleetConfig, tearDownMediaFleet} from '@lib/impulse/media/mediaFleet';
import type {MediaFleetConfig} from '@lib/impulse/media/mediaFleetRoute';


type PoolOptions = {
  endpoints: (key: string) => string[],
  connection: {getToken: () => Promise<string>, token?: string, timeout?: number},
  tokenFrom?: unknown
};

type PoolRpcResult = {data?: Uint8Array};

type PoolStub = {
  options: PoolOptions,
  rpc: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>
};

const {pools, RpcPoolStub, warn, session, refreshImpulseSession} = vi.hoisted(() => {
  const pools: PoolStub[] = [];

  class RpcPoolStub {
    public readonly rpc = vi.fn(async(): Promise<PoolRpcResult> => ({data: new Uint8Array()}));
    public readonly close = vi.fn();

    constructor(public readonly options: PoolOptions) {
      pools.push(this as unknown as PoolStub);
    }
  }

  return {
    pools,
    RpcPoolStub,
    warn: vi.fn(),
    session: {token: undefined as string | undefined, refreshed: undefined as string | undefined},
    refreshImpulseSession: vi.fn()
  };
});

vi.mock('@impulsem/centrifuge/build/protobuf', async(importActual) => {
  const actual = await importActual<typeof import('@impulsem/centrifuge/build/protobuf')>();
  return {...actual, RpcPool: RpcPoolStub};
});

vi.mock('@lib/impulseLogger', () => ({
  getLogger: () => ({info: vi.fn(), warn, debug: vi.fn(), error: vi.fn()}),
  setLogAuthTokenProvider: vi.fn()
}));

vi.mock('@lib/impulse/session', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/session')>();
  return {
    ...actual,
    whenImpulseSessionReady: vi.fn(async(): Promise<void> => {}),
    refreshImpulseSession
  };
});

vi.mock('@lib/impulse/grpc/transport', async(importActual) => {
  const actual = await importActual<typeof import('@lib/impulse/grpc/transport')>();
  return {...actual, getGrpcSessionToken: vi.fn(() => session.token)};
});


const ACCOUNT: ActiveAccountNumber = 1;
const OTHER_ACCOUNT: ActiveAccountNumber = 2;
const FLEET_URL: string = 'wss://media.impulsem.io:443/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const OTHER_FLEET_URL: string = 'wss://media-2.impulsem.io:443/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';
const REQUEST_BYTES: Uint8Array = new Uint8Array([1, 2, 3]);
const REPLY_BYTES: Uint8Array = new Uint8Array([4, 5, 6]);
const CURRENT_DC: number = 2;
const FIRST_SESSION_TOKEN: string = 'session-token-first';
const SECOND_SESSION_TOKEN: string = 'session-token-second';

const WITHOUT_MEDIA_OPTION: MediaFleetConfig = {
  this_dc: CURRENT_DC,
  dc_options: [{id: CURRENT_DC, ip_address: '149.154.167.50', port: 443}]
};

function withMediaOption(host: string): MediaFleetConfig {
  return {
    this_dc: CURRENT_DC,
    dc_options: [
      {id: CURRENT_DC, ip_address: '149.154.167.50', port: 443},
      {id: CURRENT_DC, ip_address: host, port: 443, media_only: true}
    ]
  };
}

function latestPool(): PoolStub {
  const pool = pools[pools.length - 1];
  if(!pool) {
    throw new Error('no media fleet pool was created');
  }

  return pool;
}

function installRefreshStub(): void {
  refreshImpulseSession.mockReset();
  refreshImpulseSession.mockImplementation(async(): Promise<boolean> => {
    if(session.refreshed !== undefined) {
      session.token = session.refreshed;
      return true;
    }

    return false;
  });
}

describe('the media fleet pool follows the media option of the current DC', () => {
  beforeEach(() => {
    pools.length = 0;
    warn.mockClear();
    session.token = FIRST_SESSION_TOKEN;
    session.refreshed = undefined;
    installRefreshStub();
  });

  it('opens one pool on the endpoint of the option, with the session token and never tokenFrom', () => {
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));

    expect(pools, 'a published media option must open exactly one pool').toHaveLength(1);
    const options = latestPool().options;
    expect(options.endpoints('')).toEqual([FLEET_URL]);
    expect(options.tokenFrom, 'the pool must not borrow the Sync connection client').toBeUndefined();
    expect(options.connection.token).toBeUndefined();
    expect(typeof options.connection.getToken).toBe('function');
  });

  it('builds no pool while the server publishes no media option', async() => {
    setMediaFleetConfig(ACCOUNT, WITHOUT_MEDIA_OPTION);

    expect(pools, 'without a media option no pool may exist: the client keeps the gateway path').toHaveLength(0);
    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).resolves.toBeUndefined();
  });

  it('closes the pool when the option is withdrawn, and the file calls go back to the gateway', async() => {
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    const withdrawn = latestPool();

    setMediaFleetConfig(ACCOUNT, WITHOUT_MEDIA_OPTION);

    expect(withdrawn.close, 'a withdrawn option must close the pool it built').toHaveBeenCalledTimes(1);
    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).resolves.toBeUndefined();
    expect(withdrawn.rpc, 'a withdrawn pool must never carry another call').not.toHaveBeenCalled();
  });

  it('rebuilds the pool on every new generation of the option', () => {
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    const first = latestPool();

    setMediaFleetConfig(ACCOUNT, withMediaOption('media-2.impulsem.io'));

    expect(first.close, 'the previous generation must be closed when a new one arrives').toHaveBeenCalledTimes(1);
    expect(pools, 'a new generation builds its own pool').toHaveLength(2);
    expect(latestPool().options.endpoints('')).toEqual([OTHER_FLEET_URL]);
  });

  it('tears the pool down on logout', async() => {
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    const pool = latestPool();

    tearDownMediaFleet(ACCOUNT);

    expect(pool.close, 'logout must release the account\'s fleet connections').toHaveBeenCalledTimes(1);
    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).resolves.toBeUndefined();
  });

  it('keeps one account\'s pool apart from another account\'s switch', async() => {
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
    setMediaFleetConfig(OTHER_ACCOUNT, WITHOUT_MEDIA_OPTION);

    expect(pools, 'the other account has no option, so only the first account owns a pool').toHaveLength(1);
    expect(latestPool().close).not.toHaveBeenCalled();
  });
});

describe('a file-transfer query reaches the fleet as its registry call', () => {
  beforeEach(() => {
    pools.length = 0;
    warn.mockClear();
    session.token = FIRST_SESSION_TOKEN;
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('sends the request bytes under the canon method name and returns the reply bytes', async() => {
    latestPool().rpc.mockResolvedValueOnce({data: REPLY_BYTES});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).resolves.toBe(REPLY_BYTES);

    const [method, data] = latestPool().rpc.mock.calls[0];
    expect(method, 'the registry method is the canon name, not the gRPC path').toBe('upload.getFile');
    expect(data, 'the data is the protobuf request, passed through unchanged').toBe(REQUEST_BYTES);
  });

  it('an absent reply body is a typed transport error, never an empty answer', async() => {
    latestPool().rpc.mockResolvedValueOnce({data: undefined});

    await expect(
      callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES),
      'the four file-transfer methods always answer bytes, so a reply without them is a fault of the fleet'
    ).rejects.toMatchObject({type: 'NETWORK_BAD_RESPONSE', code: 500});
  });

  it('sends none of the other methods to the pool', async() => {
    await expect(callMediaFleet(ACCOUNT, 'help.getConfig', REQUEST_BYTES)).resolves.toBeUndefined();

    expect(latestPool().rpc, 'only the four file-transfer methods may travel the fleet').not.toHaveBeenCalled();
  });
});

describe('a fleet failure is a fallback for a transport fault and an answer for anything else', () => {
  beforeEach(() => {
    pools.length = 0;
    warn.mockClear();
    session.token = FIRST_SESSION_TOKEN;
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('a lost connection resolves to the gateway fallback', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: errorCodes.connectionClosed, message: 'connection closed'});

    await expect(callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES)).resolves.toBeUndefined();
  });

  it('a temporary internal error reaches the caller as INTERNAL_SERVER_ERROR and is not sent again over gRPC-web', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 100, message: 'INTERNAL_SERVER_ERROR', appCode: 500, appType: 'INTERNAL_SERVER_ERROR'});

    await expect(callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'INTERNAL_SERVER_ERROR',
      code: 500
    });
  });

  it('an overloaded fleet reaches the caller as INTERNAL_SERVER_ERROR, the typed temporary error of the registry', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 111, message: 'INTERNAL_SERVER_ERROR', appCode: 500, appType: 'INTERNAL_SERVER_ERROR'});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'INTERNAL_SERVER_ERROR',
      code: 500
    });
  });

  it('an expired token renews the session and reaches the caller, and is not resent over gRPC-web', async() => {
    session.refreshed = SECOND_SESSION_TOKEN;
    latestPool().rpc.mockRejectedValueOnce({code: 109, message: 'token expired'});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'NETWORK_BAD_RESPONSE',
      code: 500
    });
    expect(refreshImpulseSession, 'the expired token of the fleet is renewed through the session').toHaveBeenCalledTimes(1);
  });

  it('a call over the queue bound waits for a slot of the pool and is sent again, never to the gateway', async() => {
    const pool = latestPool();
    let finishFirst: ((reply: PoolRpcResult) => void) | undefined;
    pool.rpc
      .mockImplementationOnce((): Promise<PoolRpcResult> => new Promise<PoolRpcResult>((resolve: (reply: PoolRpcResult) => void): void => {
        finishFirst = resolve;
      }))
      .mockRejectedValueOnce({code: errorCodes.limitExceeded, message: 'too many rpc calls waiting for a connection'})
      .mockResolvedValueOnce({data: REPLY_BYTES});

    const first = callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES);
    const second = callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES);
    await vi.waitFor(() => expect(pool.rpc).toHaveBeenCalledTimes(2));

    finishFirst?.({data: REPLY_BYTES});

    await expect(first).resolves.toBe(REPLY_BYTES);
    await expect(
      second,
      'a full queue is a wait for a slot: the call must be sent to the fleet once one frees, not answered by the gateway'
    ).resolves.toBe(REPLY_BYTES);
    expect(pool.rpc).toHaveBeenCalledTimes(3);
  });

  it('AUTH_TOKEN_INVALID (103) is an error for the caller and is written to the remote trace', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 103, message: 'AUTH_TOKEN_INVALID', appCode: 400, appType: 'AUTH_TOKEN_INVALID'});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'AUTH_TOKEN_INVALID',
      code: 400
    });
    expect(
      warn.mock.calls.some(([, payload]) => payload?.code === 103),
      '103 must be logged through the remote trace, not silently retried over gRPC'
    ).toBe(true);
  });

  it('METHOD_INVALID (104) is an error for the caller and is written to the remote trace', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 104, message: 'METHOD_INVALID', appCode: 400, appType: 'METHOD_INVALID'});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'METHOD_INVALID'
    });
    expect(
      warn.mock.calls.some(([, payload]) => payload?.code === 104),
      '104 must be logged through the remote trace, not silently retried over gRPC'
    ).toBe(true);
  });

  it('an application error reaches the caller with its catalog type and code', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 107, message: 'FLOOD_WAIT_30', appCode: 420, appType: 'FLOOD_WAIT_30'});

    await expect(callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES)).rejects.toMatchObject({
      type: 'FLOOD_WAIT_30',
      code: 420
    });
  });

  it('a cancelled call rejects as cancelled and is not sent again over gRPC', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: errorCodes.cancelled, message: 'cancelled'});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).rejects.toMatchObject({type: 'CANCELED'});
  });
});

describe('the token of the fleet connections is the session access token', () => {
  beforeEach(() => {
    pools.length = 0;
    session.token = undefined;
    session.refreshed = undefined;
    installRefreshStub();
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('is refused with the SDK\'s UnauthorizedError when the session is signed out', async() => {
    await expect(mediaFleetAccessToken(ACCOUNT)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('is the current session token the first time the SDK asks for it, with no refresh', async() => {
    session.token = FIRST_SESSION_TOKEN;

    await expect(latestPool().options.connection.getToken()).resolves.toBe(FIRST_SESSION_TOKEN);
    expect(refreshImpulseSession, 'a token nobody has refused must not cost a session refresh').not.toHaveBeenCalled();
  });

  it('is the session token as it stands once the session has moved on since it was handed out', async() => {
    const getToken = latestPool().options.connection.getToken;
    session.token = FIRST_SESSION_TOKEN;
    await getToken();

    session.token = SECOND_SESSION_TOKEN;

    await expect(getToken()).resolves.toBe(SECOND_SESSION_TOKEN);
    expect(refreshImpulseSession).not.toHaveBeenCalled();
  });

  it('is renewed when the SDK asks again for the token it already holds, which the fleet refused or which is due', async() => {
    const getToken = latestPool().options.connection.getToken;
    session.token = FIRST_SESSION_TOKEN;
    session.refreshed = SECOND_SESSION_TOKEN;
    await getToken();

    await expect(
      getToken(),
      'the SDK asks again for the token it holds only after a refusal or before its expiry: that token must be renewed'
    ).resolves.toBe(SECOND_SESSION_TOKEN);
    expect(refreshImpulseSession).toHaveBeenCalledTimes(1);
  });

  it('a failed renewal is a retryable error, not a refusal that stops the connection', async() => {
    const getToken = latestPool().options.connection.getToken;
    session.token = FIRST_SESSION_TOKEN;
    session.refreshed = undefined;
    await getToken();

    const failure: unknown = await getToken().then(
      (): undefined => undefined,
      (error: unknown): unknown => error
    );

    expect(failure, 'the fleet must keep retrying a transient refresh failure').toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnauthorizedError);
  });
});
