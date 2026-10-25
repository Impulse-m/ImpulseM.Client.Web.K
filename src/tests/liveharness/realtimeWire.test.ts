import {describe, expect, it} from 'vitest';

import {newSocketCorrelation, protobufWireCodec, RealtimeWireObserver} from './realtimeWire';

const ENDPOINT: string = 'ws://localhost/connection/websocket';

function jwtWithSubject(subject: string): string {
  const header: string = Buffer.from(JSON.stringify({alg: 'none'})).toString('base64url');
  const payload: string = Buffer.from(JSON.stringify({sub: subject})).toString('base64url');
  return `${header}.${payload}.`;
}

describe('RealtimeWireObserver on the protobuf transport', () => {
  it('registers a protobuf connect reply as a connect ack', () => {
    const codec = protobufWireCodec();
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const correlation = newSocketCorrelation();

    wire.recordOutgoing(codec.encodeCommands([{id: 1, connect: {token: ''}}]), correlation, ENDPOINT);
    wire.recordIncoming(codec.encodeReplies([{id: 1, connect: {client: 'client-1'}}]), correlation);

    expect(wire.connectAcks).toBe(1);
  });

  it('registers a protobuf subscribe reply as a subscribe ack on its channel', () => {
    const codec = protobufWireCodec();
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const correlation = newSocketCorrelation();

    wire.recordOutgoing(codec.encodeCommands([{id: 2, subscribe: {channel: 'user:42'}}]), correlation, ENDPOINT);
    wire.recordIncoming(codec.encodeReplies([{id: 2, subscribe: {}}]), correlation);

    expect(wire.subscribeAcks).toEqual([{channel: 'user:42', error: undefined}]);
    expect(wire.hasSubscribeAck('user:42')).toBe(true);
  });

  it('records a protobuf publication with its envelope decoded from the JSON bytes it carries', () => {
    const codec = protobufWireCodec();
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const correlation = newSocketCorrelation();
    const envelopeBytes: Uint8Array = new TextEncoder().encode(JSON.stringify({type: 3, data: 'presence'}));

    wire.recordIncoming(codec.encodeReplies([{push: {channel: 'user:42', pub: {data: envelopeBytes}}}]), correlation);

    expect(wire.publicationsOn('user:42').map((record) => record.envelope)).toEqual([{type: 3, data: 'presence'}]);
  });

  it('labels each close with the socket it closed: an identity, an access subject, or an anonymous pool connection', () => {
    const codec = protobufWireCodec();
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const accessCorrelation = newSocketCorrelation();
    const identityCorrelation = newSocketCorrelation();
    const anonymousCorrelation = newSocketCorrelation();

    wire.recordOutgoing(codec.encodeCommands([{id: 1, connect: {token: jwtWithSubject('42')}}]), accessCorrelation, ENDPOINT);
    wire.recordOutgoing(codec.encodeCommands([{id: 1, connect: {token: jwtWithSubject('i:abc')}}]), identityCorrelation, ENDPOINT);
    wire.recordOutgoing(codec.encodeCommands([{id: 1, connect: {token: ''}}]), anonymousCorrelation, ENDPOINT);
    wire.recordClose({code: 1005, reason: ''}, accessCorrelation);
    wire.recordClose({code: 1005, reason: ''}, identityCorrelation);
    wire.recordClose({code: 1005, reason: ''}, anonymousCorrelation);

    expect(wire.closes.map((close) => close.socket)).toEqual(['access:42', 'identity:i:abc', 'anonymous']);
    for(const close of wire.closes) {
      expect(close.connectedAtMs).toBeLessThanOrEqual(close.atMs);
    }
  });

  it('records a protobuf subscribe error with its code and message', () => {
    const codec = protobufWireCodec();
    const wire: RealtimeWireObserver = new RealtimeWireObserver();
    const correlation = newSocketCorrelation();

    wire.recordOutgoing(codec.encodeCommands([{id: 3, subscribe: {channel: 'user:42'}}]), correlation, ENDPOINT);
    wire.recordIncoming(codec.encodeReplies([{id: 3, error: {code: 103, message: 'permission denied'}}]), correlation);

    expect(wire.subscribeAcks).toEqual([{channel: 'user:42', error: '103 permission denied'}]);
    expect(wire.hasSubscribeAck('user:42')).toBe(false);
  });
});
