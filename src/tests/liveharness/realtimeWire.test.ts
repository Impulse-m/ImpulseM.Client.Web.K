import {describe, expect, it} from 'vitest';

import {newSocketCorrelation, protobufWireCodec, RealtimeWireObserver} from './realtimeWire';

const ENDPOINT: string = 'ws://localhost/connection/websocket';

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
