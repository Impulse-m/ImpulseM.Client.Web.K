import {beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

vi.mock('@lib/calls/livekit/liveKitTransport', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');
  return {default: FakePhoneCallTransport};
});

import GroupCallConnectionInstance, {GroupCallConnectionOptions} from '@lib/calls/groupCallConnectionInstance';
import {LiveKitParamsError} from '@lib/calls/livekit/liveKitJoinParams';
import {toImpulseMSource} from '@lib/calls/utils';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

const COORDINATES = {livekit: {url: 'wss://lk.example', token: 'jwt', room: 'g.700'}};

function track(kind: 'audio' | 'video', enabled = true): MediaStreamTrack {
  return {kind, enabled} as unknown as MediaStreamTrack;
}

function makeConnection(options: {
  type?: 'main' | 'presentation',
  isMuted?: boolean,
  joinVideo?: boolean,
  audio?: MediaStreamTrack,
  video?: MediaStreamTrack,
  answer?: Record<string, unknown>,
  mainSource?: number
} = {}) {
  const joinGroupCall = vi.fn(async() => ({
    _: 'updateGroupCallConnection',
    pFlags: {},
    params: {_: 'dataJSON', data: JSON.stringify(COORDINATES)},
    acceptedCallInput: {_: 'inputGroupCall', id: '700', access_hash: '701'},
    ...(options.answer ?? {})
  }));
  const groupCall: any = {
    id: '700',
    groupCall: {_: 'groupCall', id: '700', access_hash: 'stale'},
    connections: options.mainSource === undefined ? {} : {main: {sources: {audio: {source: options.mainSource}}}}
  };
  const streamManager: any = {
    inputStream: {
      getAudioTracks: () => options.audio ? [options.audio] : [],
      getVideoTracks: () => options.video ? [options.video] : []
    },
    stop: vi.fn()
  };
  const connectionOptions: GroupCallConnectionOptions = options.type === 'presentation' ?
    {type: 'presentation'} :
    {type: 'main', isMuted: options.isMuted, joinVideo: options.joinVideo};
  const connection = new GroupCallConnectionInstance({
    groupCall,
    type: options.type ?? 'main',
    options: connectionOptions,
    streamManager,
    managers: {appGroupCallsManager: {joinGroupCall}} as any
  });
  return {connection, groupCall, joinGroupCall, transport: connection.transport as unknown as FakePhoneCallTransport};
}

function declaredSsrc(joinGroupCall: ReturnType<typeof vi.fn>): number {
  const params = joinGroupCall.mock.calls[0][1] as {data: string};
  return JSON.parse(params.data).ssrc;
}

beforeEach(() => {
  FakePhoneCallTransport.instances = [];
});

describe('GroupCallConnectionInstance.join', () => {
  it('declares a non-zero unsigned source and keeps its signed form as the audio source', async() => {
    const {connection, joinGroupCall} = makeConnection({audio: track('audio')});

    await connection.join();

    const ssrc = declaredSsrc(joinGroupCall);
    expect(Number.isInteger(ssrc) && ssrc >= 1 && ssrc <= 0xFFFFFFFF).toBe(true);
    expect(connection.sources.audio.source).toBe(toImpulseMSource(ssrc));
    const [callId, params, options] = joinGroupCall.mock.calls[0] as unknown as [string, any, any];
    expect(callId).toBe('700');
    expect(params._).toBe('dataJSON');
    expect(Object.keys(JSON.parse(params.data))).toEqual(['ssrc', 'ssrc-groups']);
    expect(options).toMatchObject({type: 'main'});
  });

  it('declares camera source groups on the main connection, distinct from its own source', async() => {
    const {connection, joinGroupCall} = makeConnection({audio: track('audio')});

    await connection.join();

    const payload = JSON.parse(((joinGroupCall.mock.calls[0] as unknown[])[1] as any).data);
    const groups = payload['ssrc-groups'] as Array<{semantics: string, sources: number[]}>;
    expect(groups.map((group) => group.semantics)).toEqual(['SIM', 'FID', 'FID', 'FID']);
    expect(groups.length).toBeLessThanOrEqual(8);
    const sources = groups.flatMap((group) => group.sources);
    expect(sources.every((source) => Number.isInteger(source) && source >= 1 && source <= 0xFFFFFFFF)).toBe(true);
    expect(sources).not.toContain(payload.ssrc);
  });

  it('declares screen source groups on the presentation connection, apart from the main sources', async() => {
    const mainSource = toImpulseMSource(123456);
    const {connection, joinGroupCall} = makeConnection({type: 'presentation', mainSource});

    await connection.join();

    const payload = JSON.parse(((joinGroupCall.mock.calls[0] as unknown[])[1] as any).data);
    expect(payload['ssrc-groups']).toHaveLength(1);
    expect(payload['ssrc-groups'][0].semantics).toBe('FID');
    expect(payload['ssrc-groups'][0].sources).not.toContain(123456);
    expect(payload['ssrc-groups'][0].sources).not.toContain(payload.ssrc);
  });

  it('connects with the coordinates of the answer, subscribing on the main connection', async() => {
    const {connection, transport} = makeConnection();

    await connection.join();

    const [coordinates, options] = transport.connectArgs as [any, any];
    expect(coordinates).toMatchObject({url: 'wss://lk.example', token: 'jwt', room: 'g.700'});
    expect(options.autoSubscribe).toBe(true);
    expect(options.shouldSubscribe('u1.5')).toBe(true);
    expect(options.shouldSubscribe('u1.5.p')).toBe(false);
  });

  it('does not subscribe on the presentation connection and avoids the main source', async() => {
    const mainSource = toImpulseMSource(123456);
    const {connection, transport, joinGroupCall} = makeConnection({type: 'presentation', mainSource});

    await connection.join();

    expect((transport.connectArgs as any[])[1].autoSubscribe).toBe(false);
    expect(connection.sources.audio.source).not.toBe(mainSource);
    expect((joinGroupCall.mock.calls[0] as unknown[])[2]).toEqual({type: 'presentation'});
  });

  it('keeps what the server accepted when the answer carries no usable coordinates', async() => {
    const {connection, transport} = makeConnection({answer: {params: {_: 'dataJSON', data: '{"ssrc":5}'}}});

    await expect(connection.join()).rejects.toBeInstanceOf(LiveKitParamsError);

    // the controller leaves with exactly this identity and source
    expect(connection.joinAccepted).toBe(true);
    expect(connection.acceptedCallInput).toEqual({_: 'inputGroupCall', id: '700', access_hash: '701'});
    expect(connection.sources.audio.source).toBeDefined();
    expect(transport.connectArgs).toBeUndefined();
  });

  it('refuses coordinates of another room', async() => {
    const {connection} = makeConnection({answer: {
      params: {_: 'dataJSON', data: JSON.stringify({livekit: {url: 'wss://lk.example', token: 't', room: 'g.999'}})}
    }});

    await expect(connection.join()).rejects.toMatchObject({code: 'LIVEKIT_ROOM_MISMATCH'});
    expect(connection.joinAccepted).toBe(true);
  });

  it('takes the access hash the join returned', async() => {
    const {connection, groupCall} = makeConnection({answer: {
      resolvedAccessHash: 'fresh',
      resolvedGroupCall: {_: 'groupCall', id: '700', access_hash: 'old-resolved'}
    }});

    await connection.join();

    expect(groupCall.groupCall.access_hash).toBe('fresh');
  });

  it('publishes the microphone silent when it joined muted, open when it did not', async() => {
    const muted = makeConnection({isMuted: true, audio: track('audio', false)});
    await muted.connection.join();
    expect(muted.transport.calls).toEqual(['connect', 'publish:microphone', 'setMuted:microphone:true']);

    const open = makeConnection({isMuted: false, audio: track('audio', true)});
    await open.connection.join();
    expect(open.transport.calls).toEqual(['connect', 'publish:microphone']);
  });

  it('publishes the camera of a video join, after the microphone', async() => {
    const {connection, transport} = makeConnection({joinVideo: true, audio: track('audio'), video: track('video')});

    await connection.join();

    expect(transport.calls).toEqual(['connect', 'publish:microphone', 'publish:camera']);
  });

  it('does not publish what the token does not allow', async() => {
    const {connection, transport} = makeConnection({isMuted: true, audio: track('audio', false)});
    transport.getPublishPermission = () => ({canPublish: false, sources: []}) as any;

    await connection.join();

    expect(transport.calls).toEqual(['connect']);
    expect(transport.isPublished('microphone')).toBe(false);
  });

  it('publishes the microphone later, when permission arrives and it is unmuted', async() => {
    const mic = track('audio', true);
    const {connection, transport} = makeConnection({isMuted: true, audio: mic});
    let allowed = false;
    transport.getPublishPermission = () => ({canPublish: allowed, sources: allowed ? ['microphone'] : []}) as any;
    await connection.join();
    expect(transport.isPublished('microphone')).toBe(false);

    allowed = true;
    await connection.syncMicrophone(false);

    expect(transport.calls.slice(-1)).toEqual(['publish:microphone']);
    expect(transport.getPublishedTrack('microphone')).toBe(mic);
  });

  it('keeps the sent microphone in step with the mute state, replacing a new capture first', async() => {
    const first = track('audio');
    const second = track('audio');
    const {connection, transport} = makeConnection({isMuted: false, audio: first});
    await connection.join();

    await connection.syncMicrophone(true);
    await connection.syncMicrophone(false, second);

    expect(transport.calls.slice(-3)).toEqual(['setMuted:microphone:true', 'replace:microphone', 'setMuted:microphone:false']);
    expect(transport.getPublishedTrack('microphone')).toBe(second);
  });

  it('does nothing for the microphone while it is not connected', async() => {
    const {connection, transport} = makeConnection({audio: track('audio')});

    await connection.syncMicrophone(false);

    expect(transport.calls).toEqual([]);
  });

  it('replaces a track only while it is the one being sent', async() => {
    const mic = track('audio');
    const next = track('audio');
    const {connection, transport} = makeConnection({isMuted: false, audio: mic});
    await connection.join();

    expect(await connection.replaceTrack({source: 'microphone', oldTrack: track('audio'), newTrack: next})).toBe(false);
    expect(await connection.replaceTrack({source: 'microphone', oldTrack: mic, newTrack: next})).toBe(true);
    expect(transport.getPublishedTrack('microphone')).toBe(next);
  });

  it('sends the screen and its audio on the presentation connection, refusing a screen the token forbids', async() => {
    const video = track('video');
    const audio = track('audio');
    const stream = {getVideoTracks: () => [video], getAudioTracks: () => [audio]} as unknown as MediaStream;
    const allowed = makeConnection({type: 'presentation'});
    await allowed.connection.join();
    await allowed.connection.publishScreen(stream);
    expect(allowed.transport.calls.slice(-2)).toEqual(['publish:screen', 'publish:screenAudio']);

    const denied = makeConnection({type: 'presentation'});
    await denied.connection.join();
    denied.transport.getPublishPermission = () => ({canPublish: true, sources: ['microphone']}) as any;
    await expect(denied.connection.publishScreen(stream)).rejects.toThrow(/not permitted/);
  });

  it('closes the transport and, on request, the capture', () => {
    const {connection, transport} = makeConnection();

    connection.closeConnectionAndStream(true);

    expect(transport.disconnectCount).toBe(1);
    expect((connection.streamManager as any).stop).toHaveBeenCalledTimes(1);
    connection.closeConnectionAndStream(false);
    expect((connection.streamManager as any).stop).toHaveBeenCalledTimes(1);
  });

  it('stops the capture before it closes the transport, whose closed state is what plays the end tone', () => {
    const {connection, transport} = makeConnection();
    const order: string[] = [];
    (connection.streamManager as any).stop.mockImplementation(() => order.push('capture stopped'));
    const disconnect = transport.disconnect.bind(transport);
    transport.disconnect = () => {
      order.push('transport closed');
      disconnect();
    };

    connection.closeConnectionAndStream(true);

    expect(order).toEqual(['capture stopped', 'transport closed']);
  });
});
