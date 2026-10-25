import * as centrifugeProtobuf from '@impulsem/centrifuge/build/protobuf';
import {Drainable} from './drainable';

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
  maxInflightPerConnection: number,
  maxQueued: number
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

export type FleetKind = 'media' | 'pool';

type FleetLaneOptions = {
  key: string,
  identityKey: string,
  kind: FleetKind,
  endpoint: string,
  timeoutMs: number,
  connectionsPerEndpoint: number,
  inflightPerConnection: number,
  queuedCalls: number,
  getToken: (() => Promise<string>) | undefined
};

export class FleetLane {
  public readonly key: string;
  public readonly identityKey: string;
  public readonly kind: FleetKind;
  public readonly endpoint: string;

  private readonly pool: FleetPool;
  private readonly drain: Drainable;

  public constructor(options: FleetLaneOptions) {
    this.key = options.key;
    this.identityKey = options.identityKey;
    this.kind = options.kind;
    this.endpoint = options.endpoint;
    this.pool = new RpcPool({
      endpoints: (): string[] => [options.endpoint],
      connection: options.getToken === undefined
        ? {timeout: options.timeoutMs}
        : {getToken: options.getToken, timeout: options.timeoutMs},
      maxConnectionsPerEndpoint: options.connectionsPerEndpoint,
      maxInflightPerConnection: options.inflightPerConnection,
      maxQueued: options.queuedCalls
    });
    this.drain = new Drainable((): void => {
      this.pool.close();
    });
  }

  /** Sends one call on this lane. A call beyond the pool's slots waits in the pool's queue for a settled call of the pool. */
  public async send(method: string, data: Uint8Array, signal?: AbortSignal): Promise<FleetPoolReply> {
    this.drain.begin();
    try {
      return await this.pool.rpc(method, data, {signal});
    } finally {
      this.drain.end();
    }
  }

  /** Stops new calls on this lane. The lane closes now, or when its calls in flight have settled. */
  public retire(): void {
    this.drain.retire();
  }
}
