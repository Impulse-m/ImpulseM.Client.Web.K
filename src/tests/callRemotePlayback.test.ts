import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  appSettings: {callDevices: {speakerId: ''}},
  safePlay: vi.fn()
}));

vi.mock('@helpers/dom/safePlay', () => ({default: mocks.safePlay}));
vi.mock('@lib/calls/helpers/getStreamCached', () => ({default: () => vi.fn()}));
vi.mock('@lib/calls/localConferenceDescription', () => ({default: class LocalConferenceDescription {}}));
vi.mock('@lib/calls/streamManager', () => ({default: class StreamManager {}}));
vi.mock('@stores/appSettings', () => ({appSettings: mocks.appSettings}));

import CallInstanceBase from '@lib/calls/callInstanceBase';

class FakeMediaStream {
  public readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  public getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }
}

vi.stubGlobal('MediaStream', FakeMediaStream);

function fakeTrack(kind: 'audio' | 'video', muted = false): MediaStreamTrack {
  return {addEventListener: vi.fn(), kind, muted} as unknown as MediaStreamTrack;
}

class PlaybackCall extends CallInstanceBase<Record<never, never>> {
  public manager = {
    addTrack: vi.fn(),
    hasInputTrackKind: vi.fn(() => false),
    inputStream: {getAudioTracks: (): MediaStreamTrack[] => []},
    removeTrack: vi.fn(),
    stop: vi.fn()
  };

  constructor() {
    super();
    this.log = Object.assign(vi.fn(), {warn: vi.fn()}) as any;
  }

  public get streamManager() {
    return this.manager as any;
  }

  public get description(): undefined {
    return undefined;
  }

  public get isMuted() {
    return true;
  }

  public get isClosing() {
    return false;
  }

  public toggleMuted(): Promise<void> {
    return Promise.resolve();
  }

  public get audioElement() {
    return this.audio;
  }
}

describe('remote call media playback', () => {
  beforeEach(() => {
    mocks.safePlay.mockReset();
  });

  it('gives every remote audio track its own element keyed by source and installs the stream before playing', () => {
    const call = new PlaybackCall();
    const track = fakeTrack('audio');
    const sourcesSeenAtPlay: unknown[] = [];
    mocks.safePlay.mockImplementation((element: HTMLMediaElement) => {
      sourcesSeenAtPlay.push(element.srcObject);
    });

    call.tryAddTrack({stream: {id: 'remote'} as MediaStream, track, type: 'output', source: '123'});

    const element = call.getElement('audio:123');
    expect(element).toBeInstanceOf(HTMLAudioElement);
    expect(element).not.toBe(call.audioElement);
    expect((element.srcObject as unknown as FakeMediaStream).tracks).toEqual([track]);
    expect(sourcesSeenAtPlay).toEqual([element.srcObject]);
    expect(call.manager.addTrack).toHaveBeenCalledWith(expect.anything(), track, 'output', '123');
    expect(element.parentElement?.classList.contains('call-player')).toBe(true);

    call.cleanup();
  });

  it('retries playback when a track that arrived muted becomes live', () => {
    const call = new PlaybackCall();
    mocks.safePlay.mockClear();
    const unmuteListeners: Array<() => void> = [];
    const track = {
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if(type === 'unmute') unmuteListeners.push(listener);
      }),
      kind: 'audio',
      muted: true
    } as unknown as MediaStreamTrack;

    call.tryAddTrack({stream: {id: 'remote'} as MediaStream, track, type: 'output', source: '7'});
    expect(mocks.safePlay).toHaveBeenCalledTimes(1);
    expect(unmuteListeners).toHaveLength(1);

    unmuteListeners[0]();
    expect(mocks.safePlay).toHaveBeenCalledTimes(2);
    expect(mocks.safePlay.mock.calls[1][0]).toBe(call.getElement('audio:7'));

    call.cleanup();
  });

  it('keeps two remote participants on two separate elements', () => {
    const call = new PlaybackCall();
    call.tryAddTrack({stream: {id: 'a'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '1'});
    call.tryAddTrack({stream: {id: 'b'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '2'});

    expect(call.getElement('audio:1')).not.toBe(call.getElement('audio:2'));
    expect(call.getElement('audio:1').srcObject).not.toBe(call.getElement('audio:2').srcObject);

    call.cleanup();
  });

  it('keeps a remote camera on its own element beside the audio', () => {
    const call = new PlaybackCall();
    const videoStream = {id: 'remote-video'} as MediaStream;
    call.tryAddTrack({stream: videoStream, track: fakeTrack('video'), type: 'output', source: 'camera-endpoint'});
    call.tryAddTrack({stream: {id: 'a'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: 'camera-endpoint'});

    expect(call.getElement('camera-endpoint').srcObject).toBe(videoStream);
    expect(call.getElement('audio:camera-endpoint')).toBeInstanceOf(HTMLAudioElement);
    expect(call.manager.addTrack).toHaveBeenCalledTimes(2);

    call.cleanup();
  });

  it('never plays our own microphone back', () => {
    const call = new PlaybackCall();
    mocks.safePlay.mockClear();
    call.tryAddTrack({stream: {id: 'mic'} as MediaStream, track: fakeTrack('audio'), type: 'input', source: 'main'});
    expect(call.getElement('audio:main')).toBeUndefined();
    expect(mocks.safePlay).not.toHaveBeenCalled();

    call.cleanup();
  });

  it('applies per-participant volume capped at 1 and muted-by-me to that element only', () => {
    const call = new PlaybackCall();
    call.tryAddTrack({stream: {id: 'a'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '1'});
    call.tryAddTrack({stream: {id: 'b'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '2'});

    expect(call.setOutputAudioState({source: '1', volume: 0.4, muted: false})).toBe(true);
    expect(call.setOutputAudioState({source: '2', volume: 2.5, muted: true})).toBe(true);
    expect((call.getElement('audio:1') as HTMLAudioElement).volume).toBe(0.4);
    expect((call.getElement('audio:1') as HTMLAudioElement).muted).toBe(false);
    expect((call.getElement('audio:2') as HTMLAudioElement).volume).toBe(1);
    expect((call.getElement('audio:2') as HTMLAudioElement).muted).toBe(true);
    expect(call.setOutputAudioState({source: '404', volume: 1, muted: false})).toBe(false);

    call.cleanup();
  });

  it('removes the elements and stream-manager items of one source and nothing else', () => {
    const call = new PlaybackCall();
    const audio = fakeTrack('audio');
    call.tryAddTrack({stream: {id: 'a'} as MediaStream, track: audio, type: 'output', source: '1'});
    call.tryAddTrack({stream: {id: 'b'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '2'});
    const kept = call.getElement('audio:2');

    call.removeOutputTrack('1');

    expect(call.getElement('audio:1')).toBeUndefined();
    expect(call.getElement('audio:2')).toBe(kept);
    expect(call.manager.removeTrack).toHaveBeenCalledWith(audio);
    expect(call.manager.removeTrack).toHaveBeenCalledTimes(1);

    call.cleanup();
  });

  it('routes a speaker change to every per-participant element', async() => {
    const call = new PlaybackCall();
    call.tryAddTrack({stream: {id: 'a'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '1'});
    call.tryAddTrack({stream: {id: 'b'} as MediaStream, track: fakeTrack('audio'), type: 'output', source: '2'});
    const sinks: string[] = [];
    for(const key of ['audio:1', 'audio:2']) {
      (call.getElement(key) as any).setSinkId = vi.fn(async(id: string) => {
        sinks.push(`${key}=${id}`);
      });
    }

    expect(await call.setOutputDeviceId('speaker-9')).toBe(true);
    expect(sinks).toEqual(['audio:1=speaker-9', 'audio:2=speaker-9']);

    call.cleanup();
  });
});
