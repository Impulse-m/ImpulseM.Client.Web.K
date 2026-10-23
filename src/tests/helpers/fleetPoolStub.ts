import {vi} from 'vitest';

/*
 * A stand-in for the SDK's RpcPool (@impulsem/centrifuge 1.6.0). Each pool the fleet opens is recorded with the
 * endpoint it was built for and the token its connection presents. A call is answered by the responder registered for
 * its registry method: a responder returns the reply, or throws the server or transport error the pool would reject with.
 */

export type FleetPoolReply = {data?: Uint8Array};

export type FleetPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken?: () => Promise<string>, token?: string, timeout?: number},
  maxConnectionsPerEndpoint?: number,
  maxInflightPerConnection?: number
};

export type FleetPoolStub = {
  options: FleetPoolOptions,
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

export type FleetPoolHarness = {
  pools: FleetPoolStub[],
  calls: FleetCallRecord[],
  respond: (method: string, responder: FleetResponder) => void,
  respondOnce: (method: string, responder: FleetResponder) => void,
  reset: () => void,
  RpcPoolStub: new (options: FleetPoolOptions) => FleetPoolStub
};

export function createFleetPoolHarness(): FleetPoolHarness {
  const pools: FleetPoolStub[] = [];
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
    public readonly options: FleetPoolOptions;
    public readonly endpoint: string;
    public presentedToken: string | undefined = undefined;
    public readonly close = vi.fn();
    public readonly rpc = vi.fn(async(method: string, data: Uint8Array): Promise<FleetPoolReply> => {
      if(this.presentedToken === undefined && this.options.connection.getToken) {
        this.presentedToken = await this.options.connection.getToken();
      }

      calls.push({method, data, endpoint: this.endpoint, presentedToken: this.presentedToken});
      const responder = nextResponder(method);
      if(!responder) {
        throw new Error(`no fleet responder registered for ${method}`);
      }

      return responder(data);
    });

    constructor(options: FleetPoolOptions) {
      this.options = options;
      this.endpoint = options.endpoints('')[0];
      pools.push(this as unknown as FleetPoolStub);
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
    RpcPoolStub: RpcPoolStub as unknown as new (options: FleetPoolOptions) => FleetPoolStub
  };
}

const SHARED_HARNESS_KEY: symbol = Symbol.for('impulsem.test.fleetPoolHarness');

/**
 * The harness every test of a file shares with the RpcPool the mocked SDK hands out. It lives on the global object, so
 * a vi.resetModules() that re-evaluates the fleet modules still reaches the same pools and responders.
 */
export function sharedFleetPoolHarness(): FleetPoolHarness {
  const host = globalThis as unknown as Record<symbol, FleetPoolHarness | undefined>;
  let harness = host[SHARED_HARNESS_KEY];
  if(!harness) {
    harness = createFleetPoolHarness();
    host[SHARED_HARNESS_KEY] = harness;
  }

  return harness;
}
