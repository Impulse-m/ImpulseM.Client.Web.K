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

type PoolRpcResult = {data: Uint8Array, cached?: boolean};

type PoolStub = {
  options: PoolOptions,
  rpc: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>
};

const {pools, RpcPoolStub, warn, session, refreshImpulseSession} = vi.hoisted(() => {
  const pools: PoolStub[] = [];

  class RpcPoolStub {
    public readonly rpc = vi.fn(async(): Promise<PoolRpcResult> => ({data: new Uint8Array(), cached: false}));
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
const ONE_HOUR_SECONDS: number = 3600;
const REFRESH_LEAD_SECONDS: number = 30;

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

function jwtExpiringIn(seconds: number): string {
  const encode = (value: object): string => btoa(JSON.stringify(value))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  return `${encode({alg: 'HS256'})}.${encode({exp: expiresAt})}.signature`;
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
    session.token = jwtExpiringIn(ONE_HOUR_SECONDS);
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
    session.token = jwtExpiringIn(ONE_HOUR_SECONDS);
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('sends the request bytes under the canon method name and returns the reply bytes', async() => {
    latestPool().rpc.mockResolvedValueOnce({data: REPLY_BYTES, cached: false});

    await expect(callMediaFleet(ACCOUNT, 'upload.getFile', REQUEST_BYTES)).resolves.toBe(REPLY_BYTES);

    const [method, data] = latestPool().rpc.mock.calls[0];
    expect(method, 'the registry method is the canon name, not the gRPC path').toBe('upload.getFile');
    expect(data, 'the data is the protobuf request, passed through unchanged').toBe(REQUEST_BYTES);
  });

  it('an empty reply is an empty answer, never a fallback that sends the call twice', async() => {
    latestPool().rpc.mockResolvedValueOnce({data: undefined, cached: false});

    await expect(
      callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES),
      'an empty response message has no data bytes, and that is its answer, not a transport fault'
    ).resolves.toEqual(new Uint8Array(0));
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
    session.token = jwtExpiringIn(ONE_HOUR_SECONDS);
    setMediaFleetConfig(ACCOUNT, withMediaOption('media.impulsem.io'));
  });

  it('a lost connection resolves to the gateway fallback', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: errorCodes.connectionClosed, message: 'connection closed'});

    await expect(callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES)).resolves.toBeUndefined();
  });

  it('a temporary internal error resolves to the gateway fallback', async() => {
    latestPool().rpc.mockRejectedValueOnce({code: 100, message: 'INTERNAL_SERVER_ERROR', temporary: true});

    await expect(callMediaFleet(ACCOUNT, 'upload.saveFilePart', REQUEST_BYTES)).resolves.toBeUndefined();
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

  it('is the current session token while it is valid, with no refresh', async() => {
    session.token = jwtExpiringIn(ONE_HOUR_SECONDS);

    await expect(latestPool().options.connection.getToken()).resolves.toBe(session.token);
    expect(refreshImpulseSession, 'a valid token must not cost a session refresh').not.toHaveBeenCalled();
  });

  it('is refreshed when it is about to expire', async() => {
    session.token = jwtExpiringIn(REFRESH_LEAD_SECONDS);
    session.refreshed = jwtExpiringIn(ONE_HOUR_SECONDS);

    await expect(latestPool().options.connection.getToken()).resolves.toBe(session.refreshed);
    expect(refreshImpulseSession).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh is a retryable error, not a refusal that stops the connection', async() => {
    session.token = jwtExpiringIn(REFRESH_LEAD_SECONDS);
    session.refreshed = undefined;

    const failure: unknown = await latestPool().options.connection.getToken().then(
      (): undefined => undefined,
      (error: unknown): unknown => error
    );

    expect(failure, 'the fleet must keep retrying a transient refresh failure').toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnauthorizedError);
  });
});
