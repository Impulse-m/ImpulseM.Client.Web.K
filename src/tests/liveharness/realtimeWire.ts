/*
 * Wire-level observer for the client's OWN Centrifugo WebSocket.
 *
 * The realtime lane (src/lib/impulse/realtime.ts) exposes no state: no "am I subscribed",
 * no "what arrived". A live scenario that asserts push consumption therefore needs its own
 * eyes on the wire, for two reasons:
 *
 *   1. Readiness. A one-shot server push (account.updateStatus fans out ONCE) is only
 *      guaranteed to reach the viewer if the subscription was ACTIVE before the action.
 *      The subscribe ack on the wire is the sign of that — waiting on anything else is
 *      waiting on a race.
 *   2. Localization. When the manager seam never observes the update, the verdict must name
 *      the dying hop: envelope never arrived (server side) vs arrived-but-dropped (client
 *      side). Only the wire can testify that the envelope physically reached the socket.
 *
 * This observer wraps globalThis.WebSocket with a recording subclass. It records frames of
 * the Centrifugo JSON protocol (newline-delimited JSON): outgoing subscribe commands are
 * remembered by command id, incoming replies to them become subscribe acks/errors, incoming
 * `push.pub` frames are captured with their channel and raw envelope. Nothing is mutated,
 * delayed or answered — the production module talks through the wrapper untouched.
 *
 * Install discipline: installNodeEnv() OVERWRITES globalThis.WebSocket on every boot
 * (nodeEnv.ts installWebSocketPolyfill), so the only race-free spot to install is the
 * bootLiveManagerStack afterEnvInstalled hook — after the polyfill, before any src module
 * can construct a socket.
 */

export type SubscribeAck = {
  channel: string,
  error?: string
};

export type PublicationRecord = {
  channel: string,
  /** The publication's data — the realtime envelope object exactly as it rode the wire. */
  envelope: any,
  receivedAtMs: number
};

export type SocketClose = {
  code?: number,
  reason?: string
};

export type WireCommand = {
  id?: number,
  connect?: {token?: string},
  rpc?: {method?: string},
  subscribe?: {channel?: string}
};


export class RealtimeWireObserver {
  public socketsOpened = 0;
  public connectAcks = 0;
  public subscribeAcks: SubscribeAck[] = [];
  public publications: PublicationRecord[] = [];
  public closes: SocketClose[] = [];
  public commands: Array<{endpoint: string, command: WireCommand}> = [];

  private wrappedWebSocket: any;


  public constructor(private decodeCommands?: (data: unknown) => WireCommand[]) {}


  /**
   * Wraps the CURRENT globalThis.WebSocket (the one installNodeEnv just installed).
   * Call from bootLiveManagerStack's afterEnvInstalled hook — see the header.
   */
  public install(): void {
    const observer = this;
    const RealWebSocket: any = (globalThis as any).WebSocket;
    if(typeof RealWebSocket !== 'function') {
      throw new Error('RealtimeWireObserver.install: no WebSocket on globalThis to wrap — install after installNodeEnv()');
    }

    class ObservedWebSocket extends RealWebSocket {
      constructor(...args: any[]) {
        super(...args);
        observer.socketsOpened++;

        // Command ids are per-connection in the Centrifugo protocol.
        const pendingConnects = new Set<number>();
        const pendingSubscribes = new Map<number, string>();

        this.addEventListener('message', (event: any) => {
          observer.onIncoming(rawFrameToString(event?.data), pendingConnects, pendingSubscribes);
        });
        this.addEventListener('close', (event: any) => {
          observer.closes.push({code: event?.code, reason: event?.reason});
        });

        const originalSend = this.send;
        this.send = function(data: any) {
          const commands: WireCommand[] = observer.decodeCommands
            ? observer.decodeCommands(data)
            : parseFrameLines(rawFrameToString(data));
          for(const command of commands) {
            observer.commands.push({endpoint: String(args[0]), command});
          }
          observer.onOutgoing(rawFrameToString(data), pendingConnects, pendingSubscribes);
          return originalSend.call(this, data);
        };
      }
    }

    this.wrappedWebSocket = RealWebSocket;
    Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: ObservedWebSocket});
  }


  public uninstall(): void {
    if(this.wrappedWebSocket) {
      Object.defineProperty(globalThis, 'WebSocket', {configurable: true, value: this.wrappedWebSocket});
      this.wrappedWebSocket = undefined;
    }
  }


  public hasSubscribeAck(channel: string): boolean {
    return this.subscribeAcks.some((ack) => ack.channel === channel && !ack.error);
  }


  public publicationsOn(channel: string): PublicationRecord[] {
    return this.publications.filter((record) => record.channel === channel);
  }


  /** One line of wire evidence for assertion messages. */
  public describeWire(channel: string): string {
    const acks = this.subscribeAcks
      .map((ack) => `${ack.channel}${ack.error ? ` (ERROR: ${ack.error})` : ''}`)
      .join(', ') || 'none';
    const closes = this.closes.map((close) => `${close.code} ${close.reason ?? ''}`.trim()).join(', ') || 'none';
    return `sockets=${this.socketsOpened}, connectAcks=${this.connectAcks}, subscribeAcks=[${acks}], ` +
      `publicationsOn(${channel})=${this.publicationsOn(channel).length}, closes=[${closes}]`;
  }


  private onOutgoing(
    frame: string | undefined,
    pendingConnects: Set<number>,
    pendingSubscribes: Map<number, string>
  ): void {
    for(const command of parseFrameLines(frame)) {
      if(typeof command?.id !== 'number') {
        continue;
      }

      if(command.connect) {
        pendingConnects.add(command.id);
      }

      if(command.subscribe?.channel) {
        pendingSubscribes.set(command.id, String(command.subscribe.channel));
      }
    }
  }


  private onIncoming(
    frame: string | undefined,
    pendingConnects: Set<number>,
    pendingSubscribes: Map<number, string>
  ): void {
    for(const reply of parseFrameLines(frame)) {
      if(typeof reply?.id === 'number') {
        if(pendingConnects.delete(reply.id) && !reply.error) {
          this.connectAcks++;
        }

        const channel = pendingSubscribes.get(reply.id);
        if(channel !== undefined) {
          pendingSubscribes.delete(reply.id);
          this.subscribeAcks.push({
            channel,
            error: reply.error ? `${reply.error.code} ${reply.error.message}` : undefined
          });
        }

        continue;
      }

      const push = reply?.push;
      if(push?.pub && push.channel) {
        this.publications.push({
          channel: String(push.channel),
          envelope: push.pub.data,
          receivedAtMs: Date.now()
        });
      }
    }
  }
}


function rawFrameToString(data: unknown): string | undefined {
  if(typeof data === 'string') {
    return data;
  }

  if(data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if(Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  return undefined;
}


function parseFrameLines(frame: string | undefined): any[] {
  if(!frame) {
    return [];
  }

  const parsed: any[] = [];
  for(const line of frame.split('\n')) {
    const trimmed = line.trim();
    if(!trimmed) {
      continue;
    }

    try {
      parsed.push(JSON.parse(trimmed));
    } catch{
      // A non-JSON frame on the Centrifugo JSON transport is not this observer's business
      // to judge; the production client will surface it its own way.
    }
  }

  return parsed;
}
