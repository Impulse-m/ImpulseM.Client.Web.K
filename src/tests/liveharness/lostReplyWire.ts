import {protobufWireCodec, type WireCodec} from './realtimeWire';


/* Loses the reply of one armed rpc on the sockets the SDK opens through the global WebSocket (see ./realtimeWire.ts). */

type TrackedSocket = {
  dropReplyId: number | undefined,
  close: () => void
};

export class LostReplyWire {
  private readonly codec: WireCodec = protobufWireCodec();
  private readonly sockets: TrackedSocket[] = [];
  private armedMethod: string | undefined = undefined;
  private droppedSocket: TrackedSocket | undefined = undefined;
  private wrappedWebSocket: unknown = undefined;


  public install(): void {
    const wire: LostReplyWire = this;
    const RealWebSocket: any = (globalThis as any).WebSocket;
    if(typeof RealWebSocket !== 'function') {
      throw new Error('LostReplyWire.install: no WebSocket on globalThis to wrap, install after installNodeEnv()');
    }

    class LostReplyWebSocket extends RealWebSocket {
      public dropReplyId: number | undefined = undefined;
      private handler: ((event: any) => void) | undefined = undefined;

      constructor(...args: any[]) {
        super(...args);
        wire.sockets.push(this);
        this.addEventListener('message', (event: any): void => {
          const data: unknown = wire.repliesToDeliver(this, event?.data);
          if(data !== undefined) {
            this.handler?.({data});
          }
        });
      }

      public get onmessage(): ((event: any) => void) | undefined {
        return this.handler;
      }

      public set onmessage(handler: ((event: any) => void) | undefined) {
        this.handler = handler;
      }

      public send(data: any): void {
        wire.noteOutgoing(this, data);
        super.send(data);
      }

      public close(code?: number, reason?: string): void {
        super.close(code, reason);
      }
    }

    this.wrappedWebSocket = RealWebSocket;
    Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: LostReplyWebSocket});
  }


  public uninstall(): void {
    if(this.wrappedWebSocket) {
      Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: this.wrappedWebSocket});
      this.wrappedWebSocket = undefined;
    }
  }


  /** Arms the next rpc of the method: the reply of that call is the one the socket loses. */
  public dropNextReplyOf(method: string): void {
    this.armedMethod = method;
    this.droppedSocket = undefined;
  }


  public replyDropped(): boolean {
    return this.droppedSocket !== undefined;
  }


  /** Closes the socket that lost a reply; the SDK then reconnects. */
  public closeDroppedSocket(): void {
    if(!this.droppedSocket) {
      throw new Error('LostReplyWire.closeDroppedSocket: no reply was dropped');
    }

    this.droppedSocket.close();
  }


  private noteOutgoing(socket: TrackedSocket, data: unknown): void {
    for(const command of this.codec.decodeCommands(data)) {
      const method: string | undefined = command.rpc?.method;
      if(method !== undefined && method === this.armedMethod) {
        socket.dropReplyId = command.id;
        this.armedMethod = undefined;
      }
    }
  }


  private repliesToDeliver(socket: TrackedSocket, data: unknown): unknown {
    if(socket.dropReplyId === undefined) {
      return data;
    }

    const replies: any[] = this.codec.decodeReplies(data);
    const kept: any[] = replies.filter((reply: any): boolean => {
      return !!reply.push || reply.id !== socket.dropReplyId;
    });
    if(kept.length === replies.length) {
      return data;
    }

    socket.dropReplyId = undefined;
    this.droppedSocket = socket;
    return kept.length === 0 ? undefined : this.codec.encodeReplies(kept);
  }
}
