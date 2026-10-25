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
 * This observer wraps globalThis.WebSocket with a recording subclass. It decodes the frames of
 * the Centrifugo protobuf protocol, the transport every client socket speaks: outgoing subscribe commands are
 * remembered by command id, incoming replies to them become subscribe acks/errors, incoming
 * `push.pub` frames are captured with their channel and raw envelope. Nothing is mutated,
 * delayed or answered — the production module talks through the wrapper untouched.
 *
 * Install discipline: installNodeEnv() OVERWRITES globalThis.WebSocket on every boot
 * (nodeEnv.ts installWebSocketPolyfill), so the only race-free spot to install is the
 * bootLiveManagerStack afterEnvInstalled hook — after the polyfill, before any src module
 * can construct a socket.
 */

import {Centrifuge} from '@impulsem/centrifuge/build/protobuf';

export type WireCodec = {
  encodeCommands(commands: unknown[]): Uint8Array,
  encodeReplies(replies: unknown[]): Uint8Array,
  decodeCommands(data: unknown): WireCommand[],
  decodeReplies(data: unknown): any[]
};

export type SocketCorrelation = {
  pendingConnects: Set<number>,
  pendingSubscribes: Map<number, string>,
  socket: string
};

/** The protobuf codec of the SDK, which the build does not export: it is read off a client instance. */
export function protobufWireCodec(): WireCodec {
  const client: Centrifuge = new Centrifuge('ws://localhost');
  return Reflect.get(client, '_codec');
}

// The protobuf codec delivers a publication's data as the UTF-8 JSON the server published, as the client reads it.
function envelopeOf(raw: unknown): any {
  if(ArrayBuffer.isView(raw)) {
    return JSON.parse(new TextDecoder().decode(raw));
  }

  return raw;
}

// Command ids are per-connection in the Centrifugo protocol.
export function newSocketCorrelation(): SocketCorrelation {
  return {pendingConnects: new Set<number>(), pendingSubscribes: new Map<number, string>(), socket: 'unknown'};
}

// A socket is named by the subject of the token it connected with: an identity (i:...), an account's access
// subject, or an anonymous pool connection that presented no token.
function socketLabelOf(token: string): string {
  if(!token) {
    return 'anonymous';
  }

  const payload: {sub?: string} = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const subject: string = String(payload.sub);
  return subject.startsWith('i:') ? `identity:${subject}` : `access:${subject}`;
}

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
  reason?: string,
  socket: string
};

export type WireCommand = {
  id?: number,
  connect?: {token?: string},
  rpc?: {method?: string},
  subscribe?: {channel?: string, recover?: boolean, offset?: unknown, epoch?: unknown}
};


export class RealtimeWireObserver {
  public socketsOpened = 0;
  public connectAcks = 0;
  public subscribeAcks: SubscribeAck[] = [];
  public publications: PublicationRecord[] = [];
  public closes: SocketClose[] = [];
  public commands: Array<{endpoint: string, command: WireCommand}> = [];

  private wrappedWebSocket: any;
  private readonly codec: WireCodec = protobufWireCodec();


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

        const correlation: SocketCorrelation = newSocketCorrelation();
        const endpoint: string = String(args[0]);

        this.addEventListener('message', (event: any) => {
          observer.recordIncoming(event?.data, correlation);
        });
        this.addEventListener('close', (event: any) => {
          observer.recordClose({code: event?.code, reason: event?.reason}, correlation);
        });

        const originalSend = this.send;
        this.send = function(data: any) {
          observer.recordOutgoing(data, correlation, endpoint);
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


  public recordOutgoing(data: unknown, correlation: SocketCorrelation, endpoint: string): void {
    for(const command of this.codec.decodeCommands(data)) {
      this.commands.push({endpoint, command});
      if(command.connect) {
        correlation.pendingConnects.add(command.id);
        correlation.socket = socketLabelOf(command.connect.token ?? '');
      }

      if(command.subscribe?.channel) {
        correlation.pendingSubscribes.set(command.id, String(command.subscribe.channel));
      }
    }
  }


  public recordClose(event: {code?: number, reason?: string}, correlation: SocketCorrelation): void {
    this.closes.push({code: event.code, reason: event.reason, socket: correlation.socket});
  }


  public recordIncoming(data: unknown, correlation: SocketCorrelation): void {
    for(const reply of this.codec.decodeReplies(data)) {
      // A push carries id 0 in the protobuf envelope, so it is told apart from a reply by its payload.
      if(reply.push) {
        if(reply.push.pub && reply.push.channel) {
          this.publications.push({
            channel: String(reply.push.channel),
            envelope: envelopeOf(reply.push.pub.data),
            receivedAtMs: Date.now()
          });
        }

        continue;
      }

      if(correlation.pendingConnects.delete(reply.id) && !reply.error) {
        this.connectAcks++;
      }

      const channel: string | undefined = correlation.pendingSubscribes.get(reply.id);
      if(channel !== undefined) {
        correlation.pendingSubscribes.delete(reply.id);
        this.subscribeAcks.push({
          channel,
          error: reply.error ? `${reply.error.code} ${reply.error.message}` : undefined
        });
      }
    }
  }
}
