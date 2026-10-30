import {vi} from 'vitest';
import {errorCodes} from '@impulsem/centrifuge';

/*
 * A stand-in for the SDK's RpcPool (@impulsem/centrifuge 1.6.0): the SdkRpcPoolStub the fleet's lanes are built on. Each pool
 * the fleet opens is recorded with the endpoint it was built for and the token its connection presents. A call is answered
 * by the responder registered for its registry method: a responder returns the reply, or throws the server or transport
 * error the pool would reject with.
 */

export type FleetPoolReply = {data?: Uint8Array};

export type SdkRpcPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken?: () => Promise<string>, token?: string, timeout?: number},
  maxConnectionsPerEndpoint?: number,
  maxInflightPerConnection?: number,
  maxQueued?: number,
  retries?: number
};

// The SDK's defaults (rpc_pool.d.ts): 2 connections, 1 call in flight per connection, 64 calls waiting for a slot.
const SDK_CONNECTIONS_PER_ENDPOINT: number = 2;
const SDK_INFLIGHT_PER_CONNECTION: number = 1;
const SDK_MAX_QUEUED: number = 64;
const LIMIT_EXCEEDED_CODE: number = errorCodes.limitExceeded;

export type SdkRpcPoolStub = {
  options: SdkRpcPoolOptions,
  endpoint: string,
  presentedToken: string | undefined,
  rpc: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>
};

export type FleetCallRecord = {
  method: string,
  data: Uint8Array,
  endpoint: string,
  presentedToken: string | undefined
};

export type FleetResponder = (data: Uint8Array) => FleetPoolReply | Promise<FleetPoolReply>;

export type SdkRpcPoolHarness = {
  pools: SdkRpcPoolStub[],
  calls: FleetCallRecord[],
  respond: (method: string, responder: FleetResponder) => void,
  respondOnce: (method: string, responder: FleetResponder) => void,
  reset: () => void,
  RpcPoolStub: new (options: SdkRpcPoolOptions) => SdkRpcPoolStub
};

export function createFleetPoolHarness(): SdkRpcPoolHarness {
  const pools: SdkRpcPoolStub[] = [];
  const calls: FleetCallRecord[] = [];
  const responders = new Map<string, FleetResponder[]>();
  const persistent = new Map<string, FleetResponder>();

  function nextResponder(method: string): FleetResponder | undefined {
    const queue = responders.get(method);
    if(queue && queue.length > 0) {
      return queue.shift();
    }

    return persistent.get(method);
  }

  class RpcPoolStub {
    public readonly options: SdkRpcPoolOptions;
    public readonly endpoint: string;
    public presentedToken: string | undefined = undefined;
    public readonly close = vi.fn();
    private readonly slots: number;
    private readonly maxQueued: number;
    private inflight: number = 0;
    private readonly waiting: Array<() => void> = [];
    public readonly rpc = vi.fn(async(method: string, data: Uint8Array): Promise<FleetPoolReply> => {
      await this.acquireSlot();
      try {
        if(this.presentedToken === undefined && this.options.connection.getToken) {
          this.presentedToken = await this.options.connection.getToken();
        }

        calls.push({method, data, endpoint: this.endpoint, presentedToken: this.presentedToken});
        const responder = nextResponder(method);
        if(!responder) {
          throw new Error(`no fleet responder registered for ${method}`);
        }

        return await responder(data);
      } finally {
        this.releaseSlot();
      }
    });

    constructor(options: SdkRpcPoolOptions) {
      this.options = options;
      this.endpoint = options.endpoints('')[0];
      this.slots = (options.maxConnectionsPerEndpoint ?? SDK_CONNECTIONS_PER_ENDPOINT) *
        (options.maxInflightPerConnection ?? SDK_INFLIGHT_PER_CONNECTION);
      this.maxQueued = options.maxQueued ?? SDK_MAX_QUEUED;
      pools.push(this as unknown as SdkRpcPoolStub);
    }

    // As the SDK: a call takes a free slot, else waits in the queue for a call of the pool to settle; beyond the queue bound
    // it is refused with limitExceeded at once.
    private async acquireSlot(): Promise<void> {
      if(this.inflight < this.slots) {
        this.inflight++;
        return;
      }

      if(this.waiting.length >= this.maxQueued) {
        throw {code: LIMIT_EXCEEDED_CODE, message: 'too many rpc calls waiting for a connection'};
      }

      await new Promise<void>((resolve: () => void): void => {
        this.waiting.push(resolve);
      });
    }

    private releaseSlot(): void {
      const next = this.waiting.shift();
      if(next) {
        next();
        return;
      }

      this.inflight--;
    }
  }

  return {
    pools,
    calls,
    respond(method: string, responder: FleetResponder): void {
      persistent.set(method, responder);
    },
    respondOnce(method: string, responder: FleetResponder): void {
      const queue = responders.get(method) ?? [];
      queue.push(responder);
      responders.set(method, queue);
    },
    reset(): void {
      pools.length = 0;
      calls.length = 0;
      responders.clear();
      persistent.clear();
    },
    RpcPoolStub: RpcPoolStub as unknown as new (options: SdkRpcPoolOptions) => SdkRpcPoolStub
  };
}

const SHARED_HARNESS_KEY: symbol = Symbol.for('impulsem.test.fleetPoolHarness');

/**
 * The harness every test of a file shares with the RpcPool the mocked SDK hands out. It lives on the global object, so
 * a vi.resetModules() that re-evaluates the fleet modules still reaches the same pools and responders.
 */
export function sharedFleetPoolHarness(): SdkRpcPoolHarness {
  const host = globalThis as unknown as Record<symbol, SdkRpcPoolHarness | undefined>;
  let harness = host[SHARED_HARNESS_KEY];
  if(!harness) {
    harness = createFleetPoolHarness();
    host[SHARED_HARNESS_KEY] = harness;
  }

  return harness;
}
