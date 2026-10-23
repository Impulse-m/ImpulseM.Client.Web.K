import * as centrifugeProtobuf from '@impulsem/centrifuge/build/protobuf';

/*
 * One SDK RpcPool (protobuf) on one endpoint, for one identity: the connections of a lane present the same token.
 * A lane is retired when its endpoint or its identity changes; it closes once the calls it carries have settled.
 */

// @impulsem/centrifuge 1.6.0's protobuf entry declares no RpcPool (build/protobuf/index.d.ts exports the codes and
// the protobuf client only), though its runtime exports it. This is the subset of the pool the fleet uses.
type FleetPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken?: () => Promise<string>, timeout: number},
  maxConnectionsPerEndpoint: number,
  maxInflightPerConnection: number
};

export type FleetPoolReply = {data?: Uint8Array};

type FleetPool = {
  rpc(method: string, data: Uint8Array, options: {signal?: AbortSignal}): Promise<FleetPoolReply>,
  close(): void
};

type FleetPoolConstructor = new (options: FleetPoolOptions) => FleetPool;

const RpcPool: FleetPoolConstructor = (centrifugeProtobuf as unknown as {
  RpcPool: FleetPoolConstructor
}).RpcPool;

const LIMIT_EXCEEDED_CODE: number = centrifugeProtobuf.errorCodes.limitExceeded;

export type FleetKind = 'media' | 'rpc';

export type FleetLaneOptions = {
  key: string,
  kind: FleetKind,
  endpoint: string,
  timeoutMs: number,
  connectionsPerEndpoint: number,
  inflightPerConnection: number,
  getToken: (() => Promise<string>) | undefined
};

/** Thrown to a call that waited for a slot of a lane which was retired meanwhile: the call goes to the lane that replaces it. */
export class FleetLaneRetiredError extends Error {
  public constructor() {
    super('fleet lane retired');
    this.name = 'FleetLaneRetiredError';
  }
}

export class FleetLane {
  public readonly key: string;
  public readonly kind: FleetKind;
  public readonly endpoint: string;

  private readonly pool: FleetPool;
  private readonly slotWaiters: Array<() => void> = [];
  private inflight: number = 0;
  private retired: boolean = false;
  private closed: boolean = false;

  public constructor(options: FleetLaneOptions) {
    this.key = options.key;
    this.kind = options.kind;
    this.endpoint = options.endpoint;
    this.pool = new RpcPool({
      endpoints: (): string[] => [options.endpoint],
      connection: options.getToken === undefined
        ? {timeout: options.timeoutMs}
        : {getToken: options.getToken, timeout: options.timeoutMs},
      maxConnectionsPerEndpoint: options.connectionsPerEndpoint,
      maxInflightPerConnection: options.inflightPerConnection
    });
  }

  /**
   * Sends one call on this lane. A full queue of the pool is a wait for a settled call of the lane, then a send
   * again: the call is never answered from anywhere else.
   */
  public async send(method: string, data: Uint8Array, signal?: AbortSignal): Promise<FleetPoolReply> {
    for(;;) {
      if(this.retired) {
        throw new FleetLaneRetiredError();
      }

      let refused: Promise<void> | undefined;
      this.inflight++;
      try {
        return await this.pool.rpc(method, data, {signal});
      } catch(err: unknown) {
        if((err as {code?: number} | undefined)?.code !== LIMIT_EXCEEDED_CODE) {
          throw err;
        }

        refused = this.nextSettledCall(signal);
      } finally {
        this.inflight--;
        this.closeIfDrained();
        // A refused call took no slot, so it has nothing to hand on to the calls waiting for one.
        if(refused === undefined) {
          this.wakeWaiters();
        }
      }

      await refused;
    }
  }

  /** Stops new calls on this lane. The lane closes now, or when its calls in flight have settled. */
  public retire(): void {
    if(this.retired) {
      return;
    }

    this.retired = true;
    this.wakeWaiters();
    this.closeIfDrained();
  }

  private wakeWaiters(): void {
    for(const wake of this.slotWaiters.splice(0)) {
      wake();
    }
  }

  private closeIfDrained(): void {
    if(this.retired && this.inflight === 0 && !this.closed) {
      this.closed = true;
      this.pool.close();
    }
  }

  // An abort wakes the waiter as well: the retry then carries the aborted signal and the pool settles it as cancelled.
  private nextSettledCall(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
      if(signal?.aborted === true) {
        resolve();
        return;
      }

      const wake = (): void => {
        signal?.removeEventListener('abort', wake);
        resolve();
      };

      this.slotWaiters.push(wake);
      signal?.addEventListener('abort', wake, {once: true});
    });
  }
}
