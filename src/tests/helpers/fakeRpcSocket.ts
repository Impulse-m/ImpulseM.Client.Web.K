import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';

/*
 * An in-process Centrifugo socket for the SDK's real RpcPool. It answers the connect command at once, and each rpc command
 * with a successful reply after the delay the test gives for it, speaking the SDK's own protobuf codec. The fleet lane builds
 * its pool without a socket option, so the SDK reads the socket from globalThis.WebSocket: installFakeRpcSocket replaces it.
 */

const CODEC_HOST_URL: string = 'wss://codec.invalid/connection/websocket';
const FAKE_CLIENT_ID: string = 'fake-centrifugo-client';
const FAKE_CLIENT_VERSION: string = '1';
const REPLY_DATA: Uint8Array = new Uint8Array([7, 7, 7]);

export type RpcReplyDelay = (rpcNumber: number) => number;

export type ReceivedRpc = {
  method: string,
  arrivedAt: number
};

export type FakeRpcSocketServer = {
  replyDelayMs: RpcReplyDelay,
  received: ReceivedRpc[],
  restore: () => void
};

type WireCommand = {
  id: number,
  connect?: unknown,
  rpc?: {method: string, data: Uint8Array}
};

type WireReply = {
  id: number,
  connect?: {client: string, version: string},
  rpc?: {data: Uint8Array}
};

type ProtobufCodec = {
  decodeCommands(data: Uint8Array): WireCommand[],
  encodeReplies(replies: WireReply[]): Uint8Array
};

type ProtobufClientHost = {
  _codec: ProtobufCodec
};

const codec: ProtobufCodec = (new Centrifuge(CODEC_HOST_URL, {}) as unknown as ProtobufClientHost)._codec;

let activeServer: FakeRpcSocketServer | undefined;

// The SDK's decoder leaves the fields of the other commands null, not undefined.
function isSet(field: unknown): boolean {
  return field !== undefined && field !== null;
}

class FakeRpcSocket {
  public binaryType: string = 'arraybuffer';
  public onopen: ((event: unknown) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onmessage: ((event: {data: Uint8Array}) => void) | null = null;
  private closed: boolean = false;

  public constructor(url: string, protocol?: string) {
    setTimeout((): void => {
      if(!this.closed) {
        this.onopen?.({type: 'open', url, protocol});
      }
    }, 0);
  }

  public send(data: Uint8Array | ArrayBuffer): void {
    if(this.closed || activeServer === undefined) {
      return;
    }

    const bytes: Uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data);
    for(const command of codec.decodeCommands(bytes)) {
      this.answer(command, activeServer);
    }
  }

  public close(): void {
    this.closed = true;
  }

  private answer(command: WireCommand, server: FakeRpcSocketServer): void {
    if(isSet(command.connect)) {
      this.deliver(0, {id: command.id, connect: {client: FAKE_CLIENT_ID, version: FAKE_CLIENT_VERSION}});
      return;
    }

    if(isSet(command.rpc)) {
      server.received.push({method: command.rpc.method, arrivedAt: Date.now()});
      const rpcNumber: number = server.received.length;
      this.deliver(server.replyDelayMs(rpcNumber), {id: command.id, rpc: {data: REPLY_DATA}});
    }
  }

  private deliver(delayMs: number, reply: WireReply): void {
    setTimeout((): void => {
      if(!this.closed) {
        this.onmessage?.({data: codec.encodeReplies([reply])});
      }
    }, delayMs);
  }
}

export function installFakeRpcSocket(replyDelayMs: RpcReplyDelay): FakeRpcSocketServer {
  const originalDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const server: FakeRpcSocketServer = {
    replyDelayMs,
    received: [],
    restore: (): void => {
      activeServer = undefined;
      if(originalDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'WebSocket');
        return;
      }

      Object.defineProperty(globalThis, 'WebSocket', originalDescriptor);
    }
  };

  activeServer = server;
  Object.defineProperty(globalThis, 'WebSocket', {value: FakeRpcSocket, writable: true, configurable: true});
  return server;
}
