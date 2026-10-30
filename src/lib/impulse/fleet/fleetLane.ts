import * as centrifugeProtobuf from '@impulsem/centrifuge/build/protobuf';
import {ConcurrentTaskQueue} from '@lib/impulse/realtimeDiscipline';
import {Drainable} from './drainable';

/*
 * One SDK RpcPool (protobuf) on one endpoint, for one identity: the connections of a lane present the same token.
 * A lane is retired when its endpoint or its identity changes; it closes once the calls it carries have settled.
 */

type FleetPoolOptions = {
  endpoints: (endpointKey: string) => string[],
  connection: {getToken?: () => Promise<string>, timeout: number},
  maxConnectionsPerEndpoint: number,
  maxInflightPerConnection: number,
  maxQueued: number,
  retries?: number
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
  localWindow: number | undefined,
  resends: number | undefined,
  getToken: (() => Promise<string>) | undefined
};

export class FleetLane {
  public readonly key: string;
  public readonly identityKey: string;
  public readonly kind: FleetKind;
  public readonly endpoint: string;

  private readonly pool: FleetPool;
  private readonly drain: Drainable;
  private readonly localQueue: ConcurrentTaskQueue | undefined;

  public constructor(options: FleetLaneOptions) {
    this.key = options.key;
    this.identityKey = options.identityKey;
    this.kind = options.kind;
    this.endpoint = options.endpoint;
    this.localQueue = options.localWindow === undefined ? undefined : new ConcurrentTaskQueue(options.localWindow);
    const poolOptions: FleetPoolOptions = {
      endpoints: (): string[] => [options.endpoint],
      connection: options.getToken === undefined
        ? {timeout: options.timeoutMs}
        : {getToken: options.getToken, timeout: options.timeoutMs},
      maxConnectionsPerEndpoint: options.connectionsPerEndpoint,
      maxInflightPerConnection: options.inflightPerConnection,
      maxQueued: options.queuedCalls
    };
    if(options.resends !== undefined) {
      poolOptions.retries = options.resends;
    }
    this.pool = new RpcPool(poolOptions);
    this.drain = new Drainable((): void => {
      this.pool.close();
    });
  }

  public async send(method: string, data: Uint8Array, signal?: AbortSignal): Promise<FleetPoolReply> {
    this.drain.begin();
    try {
      return await this.admit(method, data, signal);
    } finally {
      this.drain.end();
    }
  }

  public retire(): void {
    this.drain.retire();
  }

  private admit(method: string, data: Uint8Array, signal?: AbortSignal): Promise<FleetPoolReply> {
    const rpc = (): Promise<FleetPoolReply> => this.pool.rpc(method, data, {signal});
    if(this.localQueue === undefined) {
      return rpc();
    }

    return this.localQueue.run(rpc, signal).catch((err: unknown): never => {
      if(signal?.aborted === true && err === signal.reason) {
        throw {code: centrifugeProtobuf.errorCodes.cancelled, message: 'cancelled'};
      }

      throw err;
    });
  }
}
