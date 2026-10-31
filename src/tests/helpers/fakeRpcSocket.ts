import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';

const CODEC_HOST_URL: string = 'wss://codec.invalid/connection/websocket';
const FAKE_CLIENT_ID: string = 'fake-centrifugo-client';
const FAKE_CLIENT_VERSION: string = '1';
const REPLY_DATA: Uint8Array = new Uint8Array([7, 7, 7]);

export type RpcReplyDelay = (rpcNumber: number) => number;

export type ReceivedRpc = {
  method: string,
  arrivedAt: number,
  socketIndex: number,
  repliedAt?: number
};

export type RpcError = {
  code: number,
  message: string,
  temporary: boolean
};

export type RpcErrorOf = (method: string) => RpcError | undefined;

export type FakeRpcSocketServer = {
  replyDelayMs: RpcReplyDelay,
  replyErrorOf: RpcErrorOf,
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
  rpc?: {data: Uint8Array},
  error?: RpcError
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
let socketsOpened: number = 0;

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
  private readonly index: number;

  public constructor(url: string, protocol?: string) {
    this.index = ++socketsOpened;
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
      const received: ReceivedRpc = {method: command.rpc.method, arrivedAt: Date.now(), socketIndex: this.index};
      server.received.push(received);
      const rpcNumber: number = server.received.length;
      const replyError: RpcError | undefined = server.replyErrorOf(command.rpc.method);
      const reply: WireReply = replyError === undefined
        ? {id: command.id, rpc: {data: REPLY_DATA}}
        : {id: command.id, error: replyError};
      this.deliver(server.replyDelayMs(rpcNumber), reply, received);
    }
  }

  private deliver(delayMs: number, reply: WireReply, rpc?: ReceivedRpc): void {
    setTimeout((): void => {
      if(!this.closed) {
        if(rpc !== undefined) {
          rpc.repliedAt = Date.now();
        }
        this.onmessage?.({data: codec.encodeReplies([reply])});
      }
    }, delayMs);
  }
}

const noReplyError: RpcErrorOf = (): undefined => undefined;

export function installFakeRpcSocket(replyDelayMs: RpcReplyDelay, replyErrorOf: RpcErrorOf = noReplyError): FakeRpcSocketServer {
  const originalDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const server: FakeRpcSocketServer = {
    replyDelayMs,
    replyErrorOf,
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
  socketsOpened = 0;
  Object.defineProperty(globalThis, 'WebSocket', {value: FakeRpcSocket, writable: true, configurable: true});
  return server;
}
