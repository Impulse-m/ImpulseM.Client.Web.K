import {vi} from 'vitest';

/*
 * A stand-in for the protobuf Centrifuge client of @impulsem/centrifuge 1.6.0 (the update socket). Each socket the client
 * opens is recorded with the options it was built with. Like the SDK, the socket asks its getToken for a token on connect
 * when it holds none, and the token it presents is recorded. An rpc waits for the connect, then is answered by the
 * responder registered for its registry method: a responder returns the reply, or throws the error the SDK would reject with.
 */

export type UpdateSocketReply = {data: Uint8Array | undefined, cached?: boolean};

export type UpdateSocketResponder = (data: Uint8Array) => UpdateSocketReply | Promise<UpdateSocketReply>;

export type UpdateSocketOptions = {
  token: string,
  getToken: (() => Promise<string>) | null,
  stopOnRefusedToken?: boolean,
  timeout?: number,
  minReconnectDelay?: number,
  maxReconnectDelay?: number,
  instance?: string,
  maxPendingRpc?: number
};

export type UpdateSocketCallRecord = {
  method: string,
  data: Uint8Array,
  endpoint: string,
  presentedToken: string | undefined,
  headers: Record<string, string> | undefined
};

type UpdateSocketRpcOptions = {
  headers?: Record<string, string>,
  signal?: AbortSignal
};

export type SubscriptionStub = {
  channel: string,
  subscribed: boolean,
  unsubscribed: boolean,
  on: (event: string, handler: (ctx: unknown) => void) => SubscriptionStub,
  subscribe: () => void,
  unsubscribe: () => void,
  emit: (event: string, ctx: unknown) => void
};

export type UpdateSocketStub = {
  url: string,
  options: UpdateSocketOptions,
  presentedToken: string | undefined,
  connected: boolean,
  disconnected: boolean,
  subscriptions: SubscriptionStub[],
  rpc: ReturnType<typeof vi.fn>,
  connect: () => void,
  disconnect: () => void,
  on: (event: string, handler: (ctx: unknown) => void) => UpdateSocketStub,
  newSubscription: (channel: string) => SubscriptionStub,
  removeSubscription: (subscription: unknown) => void,
  emit: (event: string, ctx: unknown) => void
};

export type UpdateSocketHarness = {
  sockets: UpdateSocketStub[],
  calls: UpdateSocketCallRecord[],
  respond: (method: string, responder: UpdateSocketResponder) => void,
  respondOnce: (method: string, responder: UpdateSocketResponder) => void,
  reset: () => void,
  CentrifugeStub: new (url: string, options: UpdateSocketOptions) => UpdateSocketStub
};

export function createUpdateSocketHarness(): UpdateSocketHarness {
  const sockets: UpdateSocketStub[] = [];
  const calls: UpdateSocketCallRecord[] = [];
  const responders = new Map<string, UpdateSocketResponder[]>();
  const persistent = new Map<string, UpdateSocketResponder>();

  function nextResponder(method: string): UpdateSocketResponder | undefined {
    const queue = responders.get(method);
    if(queue && queue.length > 0) {
      return queue.shift();
    }

    return persistent.get(method);
  }

  class CentrifugeStub {
    public readonly url: string;
    public readonly options: UpdateSocketOptions;
    public presentedToken: string | undefined = undefined;
    public connected: boolean = false;
    public disconnected: boolean = false;
    public readonly subscriptions: SubscriptionStub[] = [];

    public readonly rpc = vi.fn(async(method: string, data: Uint8Array, options?: UpdateSocketRpcOptions): Promise<UpdateSocketReply> => {
      await this.waitForConnection();

      calls.push({method, data, endpoint: this.url, presentedToken: this.presentedToken, headers: options?.headers});
      const responder = nextResponder(method);
      if(!responder) {
        throw new Error(`no update socket responder registered for ${method}`);
      }

      return responder(data);
    });

    private readonly handlers = new Map<string, (ctx: unknown) => void>();
    private readyWaiters: Array<() => void> = [];

    constructor(url: string, options: UpdateSocketOptions) {
      this.url = url;
      this.options = options;
      sockets.push(this as unknown as UpdateSocketStub);
    }

    public on(event: string, handler: (ctx: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    public newSubscription(channel: string): SubscriptionStub {
      const handlers = new Map<string, (ctx: unknown) => void>();
      const subscription: SubscriptionStub = {
        channel,
        subscribed: false,
        unsubscribed: false,
        on(event: string, handler: (ctx: unknown) => void): SubscriptionStub {
          handlers.set(event, handler);
          return subscription;
        },
        subscribe(): void {
          subscription.subscribed = true;
        },
        unsubscribe(): void {
          subscription.unsubscribed = true;
        },
        emit(event: string, ctx: unknown): void {
          handlers.get(event)?.(ctx);
        }
      };
      this.subscriptions.push(subscription);
      return subscription;
    }

    public removeSubscription(): void {}

    public emit(event: string, ctx: unknown): void {
      this.handlers.get(event)?.(ctx);
    }

    public connect(): void {
      void this.openConnection();
    }

    public disconnect(): void {
      this.connected = false;
      this.disconnected = true;
    }

    private async openConnection(): Promise<void> {
      if(this.options.getToken) {
        this.presentedToken = await this.options.getToken();
      }

      this.connected = true;
      for(const wake of this.readyWaiters.splice(0)) {
        wake();
      }
    }

    private async waitForConnection(): Promise<void> {
      if(this.connected) {
        return;
      }

      await new Promise<void>((resolve: () => void): void => {
        this.readyWaiters.push(resolve);
      });
    }
  }

  return {
    sockets,
    calls,
    respond(method: string, responder: UpdateSocketResponder): void {
      persistent.set(method, responder);
    },
    respondOnce(method: string, responder: UpdateSocketResponder): void {
      const queue = responders.get(method) ?? [];
      queue.push(responder);
      responders.set(method, queue);
    },
    reset(): void {
      sockets.length = 0;
      calls.length = 0;
      responders.clear();
      persistent.clear();
    },
    CentrifugeStub: CentrifugeStub as unknown as new (url: string, options: UpdateSocketOptions) => UpdateSocketStub
  };
}

const SHARED_HARNESS_KEY: symbol = Symbol.for('impulsem.test.updateSocketHarness');

/**
 * The harness every test of a file shares with the Centrifuge client the mocked SDK hands out. It lives on the global
 * object, so a vi.resetModules() that re-evaluates the realtime modules still reaches the same sockets and responders.
 */
export function sharedUpdateSocketHarness(): UpdateSocketHarness {
  const host = globalThis as unknown as Record<symbol, UpdateSocketHarness | undefined>;
  let harness = host[SHARED_HARNESS_KEY];
  if(!harness) {
    harness = createUpdateSocketHarness();
    host[SHARED_HARNESS_KEY] = harness;
  }

  return harness;
}
