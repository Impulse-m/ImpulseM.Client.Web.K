import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  appSettings: {callDevices: {speakerId: ''}},
  getStream: vi.fn(),
  getUserStream: vi.fn(),
  invokeCrypto: vi.fn()
}));

vi.mock('@helpers/dom/safePlay', () => ({default: vi.fn()}));
vi.mock('@environment/webpSupport', () => ({default: true}));
vi.mock('@lib/calls/helpers/getAudioConstraints', () => ({
  default: (deviceId?: string) => ({deviceId})
}));
vi.mock('@lib/calls/helpers/getStream', () => ({default: mocks.getStream}));
vi.mock('@lib/calls/helpers/getUserStream', async(importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/calls/helpers/getUserStream')>();
  return {...actual, getUserStream: mocks.getUserStream};
});
vi.mock('@lib/calls/helpers/getStreamCached', () => ({default: () => vi.fn()}));
vi.mock('@lib/calls/helpers/stopTrack', () => ({
  default: (track: {stop: () => void}) => track.stop()
}));
vi.mock('@lib/calls/localConferenceDescription', () => ({default: class LocalConferenceDescription {}}));
vi.mock('@lib/calls/streamManager', () => ({default: class StreamManager {}}));
vi.mock('@lib/calls/callsController', () => ({default: {}}));
vi.mock('@lib/apiManagerProxy', () => ({default: {invokeCrypto: mocks.invokeCrypto}}));
vi.mock('@stores/appSettings', () => ({appSettings: mocks.appSettings}));

import CallInstanceBase from '@lib/calls/callInstanceBase';
import CallInstance from '@lib/calls/callInstance';
import CALL_STATE from '@lib/calls/callState';
import deferred from './helpers/deferred';
import createSerializedQueue from '@helpers/createSerializedQueue';
import PhoneCallSession from '@lib/calls/livekit/phoneCallSession';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

type FakeTrack = MediaStreamTrack & {enabled: boolean, stop: ReturnType<typeof vi.fn>};

function makeTrack(kind: 'audio' | 'video' = 'audio'): FakeTrack {
  return {
    enabled: true,
    kind,
    stop: vi.fn()
  } as unknown as FakeTrack;
}

function makeSessionInstance(initialAudioTrack?: FakeTrack) {
  const transport = new FakePhoneCallTransport();
  const session = new PhoneCallSession({transport, remoteUserId: 7 as UserId, timeouts: {packetTimeoutMs: 20000, connectTimeoutMs: 45000}});
  transport.emitState('connected');
  if(initialAudioTrack) {
    transport.published.set('microphone', initialAudioTrack);
    transport.muted.set('microphone', !initialAudioTrack.enabled);
    session.adoptOwnStream({kind: 'audio', stream: initialAudioTrack.enabled ? makeStream(initialAudioTrack) : undefined});
  } else {
    transport.published.set('microphone', makeTrack());
    transport.muted.set('microphone', true);
  }

  const instance = Object.assign(Object.create(CallInstance.prototype), {
    dispatchEvent: vi.fn(),
    log: Object.assign(vi.fn(), {warn: vi.fn()}),
    mediaDeviceChangeGenerations: {audio: 0, output: 0, video: 0},
    mediaDeviceChangeQueues: {
      audio: createSerializedQueue(),
      output: createSerializedQueue(),
      video: createSerializedQueue()
    },
    pendingInputAudioTracks: new Set<MediaStreamTrack>(),
    session,
    sessionState: 'connected',
    updateStreams: vi.fn(),
    videoElements: new Map()
  }) as CallInstance;

  return {instance, session, transport};
}

function makeStream(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => track.kind === 'audio' ? [track] : [],
    getVideoTracks: () => track.kind === 'video' ? [track] : [],
    getTracks: () => [track]
  } as unknown as MediaStream;
}


class TestCallInstance extends CallInstanceBase<Record<never, never>> {
  public closing = false;
  public muted = false;
  public publishImpl: (stream: MediaStream) => Promise<void> = async() => {};

  constructor(
    private manager: {
      inputStream: {getAudioTracks: () => FakeTrack[]},
      hasInputTrackKind: (kind: string) => boolean,
      replaceInputAudio: ReturnType<typeof vi.fn>,
      stop: ReturnType<typeof vi.fn>
    },
    private replaceTrack: (
      kind: 'audio' | 'video',
      oldTrack: MediaStreamTrack,
      newTrack: MediaStreamTrack
    ) => Promise<void>
  ) {
    super();
  }

  public get streamManager() {
    return this.manager as any;
  }

  public get isMuted() {
    return this.muted;
  }

  public get isClosing() {
    return this.closing;
  }

  public toggleMuted(): Promise<void> {
    return Promise.resolve();
  }

  protected publishInputStream(stream: MediaStream): Promise<void> {
    return this.publishImpl(stream);
  }

  protected replaceSenderTrack(
    kind: 'audio' | 'video',
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ): Promise<void> {
    return this.replaceTrack(kind, oldTrack, newTrack);
  }
}

function createHarness() {
  const oldTrack = makeTrack();
  const newTrack = makeTrack();
  let currentTrack = oldTrack;
  const manager = {
    inputStream: {getAudioTracks: () => [currentTrack]},
    hasInputTrackKind: () => true,
    replaceInputAudio: vi.fn((stream: MediaStream) => {
      currentTrack = stream.getAudioTracks()[0] as FakeTrack;
    }),
    stop: vi.fn()
  };
  const replaceTrack = vi.fn().mockResolvedValue(undefined);
  const instance = new TestCallInstance(manager, replaceTrack);
  mocks.getStream.mockResolvedValue(makeStream(newTrack));

  return {getCurrentTrack: () => currentTrack, instance, manager, newTrack, oldTrack, replaceTrack};
}

function createVideoHarness() {
  const oldTrack = makeTrack('video');
  const newTrack = makeTrack('video');
  let currentTrack = oldTrack;
  const manager = {
    inputStream: {
      getAudioTracks: (): FakeTrack[] => [],
      getVideoTracks: () => [currentTrack]
    },
    hasInputTrackKind: (kind: string) => kind === 'video',
    replaceInputAudio: vi.fn(),
    removeTrack: vi.fn(),
    addTrack: vi.fn((_stream: MediaStream, track: FakeTrack) => {
      currentTrack = track;
    }),
    stop: vi.fn()
  };
  const replaceTrack = vi.fn().mockResolvedValue(undefined);
  const instance = new TestCallInstance(manager, replaceTrack);
  mocks.getStream.mockResolvedValue(makeStream(newTrack));

  return {getCurrentTrack: () => currentTrack, instance, manager, newTrack, oldTrack, replaceTrack};
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appSettings.callDevices.speakerId = '';
  mocks.getUserStream.mockReset();
  mocks.getUserStream.mockImplementation(() => mocks.getStream());
  mocks.invokeCrypto.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emoji fingerprint derivation', () => {
  it('clears a rejected in-flight derivation so a later popup can retry', async() => {
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      dh: {g_a: new Uint8Array([3])},
      encryptionKey: new Uint8Array([1, 2])
    }) as CallInstance;
    const transientError = new Error('crypto worker unavailable');
    mocks.invokeCrypto.mockRejectedValueOnce(transientError).mockResolvedValueOnce([
      '1f600',
      '1f603',
      '1f604',
      '1f601'
    ]);

    await expect(instance.getEmojisFingerprint()).rejects.toBe(transientError);
    await expect(instance.getEmojisFingerprint()).resolves.toHaveLength(4);

    expect(mocks.invokeCrypto).toHaveBeenCalledTimes(2);
  });
});

describe('mid-call microphone device swap', () => {
  it('rejects acquisition failure so settings can roll back', async() => {
    const {instance, manager, replaceTrack} = createHarness();
    const error = new Error('permission denied');
    mocks.getStream.mockRejectedValue(error);

    await expect(instance.setInputAudioDeviceId('new-mic')).rejects.toBe(error);
    expect(replaceTrack).not.toHaveBeenCalled();
    expect(manager.replaceInputAudio).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('rolls sender changes back and rejects when replacement fails', async() => {
    const {instance, manager, newTrack, oldTrack, replaceTrack} = createHarness();
    const error = new Error('replaceTrack failed');
    replaceTrack.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

    await expect(instance.setInputAudioDeviceId('new-mic')).rejects.toBe(error);
    expect(replaceTrack).toHaveBeenNthCalledWith(1, 'audio', oldTrack, newTrack);
    expect(replaceTrack).toHaveBeenNthCalledWith(2, 'audio', newTrack, oldTrack);
    expect(manager.replaceInputAudio).not.toHaveBeenCalled();
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
    expect(oldTrack.stop).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('commits the new input only after sender replacement succeeds', async() => {
    const {instance, manager, newTrack, oldTrack, replaceTrack} = createHarness();

    await instance.setInputAudioDeviceId('new-mic');

    expect(replaceTrack).toHaveBeenCalledWith('audio', oldTrack, newTrack);
    expect(manager.replaceInputAudio).toHaveBeenCalledWith(expect.anything(), oldTrack);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(newTrack.stop).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('keeps a replacement microphone disabled while the call is muted', async() => {
    const {instance, newTrack, oldTrack, replaceTrack} = createHarness();
    oldTrack.enabled = false;

    await instance.setInputAudioDeviceId('new-mic');

    expect(replaceTrack).toHaveBeenCalledWith('audio', oldTrack, newTrack);
    expect(newTrack.enabled).toBe(false);
    instance.cleanup();
  });

  it.each([
    ['mute', true, true, false],
    ['unmute', false, false, true]
  ] as const)('applies %s to a microphone replacement while sender replacement is pending', async(
    _title,
    oldTrackEnabled,
    muted,
    expectedEnabled
  ) => {
    const {instance, newTrack, oldTrack, replaceTrack} = createHarness();
    const replacement = deferred<void>();
    oldTrack.enabled = oldTrackEnabled;
    replaceTrack.mockReturnValueOnce(replacement.promise);

    const change = instance.setInputAudioDeviceId('new-mic');
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledWith('audio', oldTrack, newTrack));

    instance.setMuted(muted);

    expect(oldTrack.enabled).toBe(expectedEnabled);
    expect(newTrack.enabled).toBe(expectedEnabled);

    replacement.resolve();
    await expect(change).resolves.toBe(true);
    expect(newTrack.enabled).toBe(expectedEnabled);
    instance.cleanup();
  });

  it('drops an older acquisition that resolves after the newer device committed', async() => {
    const {getCurrentTrack, instance, manager, oldTrack, replaceTrack} = createHarness();
    const trackA = makeTrack();
    const trackB = makeTrack();
    const acquireA = deferred<MediaStream>();
    const acquireB = deferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(acquireA.promise).mockReturnValueOnce(acquireB.promise);

    const changeA = instance.setInputAudioDeviceId('mic-a');
    const changeB = instance.setInputAudioDeviceId('mic-b');
    acquireB.resolve(makeStream(trackB));
    await expect(changeB).resolves.toBe(true);
    acquireA.resolve(makeStream(trackA));
    await expect(changeA).resolves.toBe(false);

    expect(replaceTrack).toHaveBeenCalledTimes(1);
    expect(replaceTrack).toHaveBeenCalledWith('audio', oldTrack, trackB);
    expect(manager.replaceInputAudio).toHaveBeenCalledTimes(1);
    expect(getCurrentTrack()).toBe(trackB);
    expect(trackA.stop).toHaveBeenCalledTimes(1);
    expect(trackB.stop).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('rolls an in-flight stale sender replacement back before applying the newer device', async() => {
    const {getCurrentTrack, instance, manager, oldTrack, replaceTrack} = createHarness();
    const trackA = makeTrack();
    const trackB = makeTrack();
    const replacementA = deferred<void>();
    mocks.getStream.mockResolvedValueOnce(makeStream(trackA)).mockResolvedValueOnce(makeStream(trackB));
    replaceTrack.mockReset()
    .mockReturnValueOnce(replacementA.promise)
    .mockResolvedValue(undefined);

    const changeA = instance.setInputAudioDeviceId('mic-a');
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledTimes(1));
    const changeB = instance.setInputAudioDeviceId('mic-b');
    replacementA.resolve();

    await expect(changeA).resolves.toBe(false);
    await expect(changeB).resolves.toBe(true);
    expect(replaceTrack).toHaveBeenNthCalledWith(1, 'audio', oldTrack, trackA);
    expect(replaceTrack).toHaveBeenNthCalledWith(2, 'audio', trackA, oldTrack);
    expect(replaceTrack).toHaveBeenNthCalledWith(3, 'audio', oldTrack, trackB);
    expect(manager.replaceInputAudio).toHaveBeenCalledTimes(1);
    expect(getCurrentTrack()).toBe(trackB);
    expect(trackA.stop).toHaveBeenCalledTimes(1);
    expect(trackB.stop).not.toHaveBeenCalled();
    instance.cleanup();
  });

  it('releases a replacement that completes after hangup instead of committing it', async() => {
    const {instance, manager, newTrack, oldTrack, replaceTrack} = createHarness();
    const replacement = deferred<void>();
    replaceTrack.mockReturnValueOnce(replacement.promise);

    const change = instance.setInputAudioDeviceId('new-mic');
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledWith('audio', oldTrack, newTrack));
    instance.closing = true;
    instance.cleanup();

    expect(newTrack.stop).toHaveBeenCalledTimes(1);
    replacement.resolve();

    await expect(change).resolves.toBe(true);
    expect(manager.replaceInputAudio).not.toHaveBeenCalled();
    expect(newTrack.stop).toHaveBeenCalled();
    expect(oldTrack.stop).not.toHaveBeenCalled();
  });
});

describe('speaker device swap', () => {
  it('applies the persisted sink to the base group-call audio element', async() => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId');
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId
    });
    mocks.appSettings.callDevices.speakerId = 'speaker-saved';
    const {instance} = createHarness();

    try {
      await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledWith('speaker-saved'));
      expect((instance as any).outputDeviceId).toBe('speaker-saved');
    } finally {
      instance.cleanup();
      if(originalDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', originalDescriptor);
      } else {
        delete (HTMLMediaElement.prototype as any).setSinkId;
      }
    }
  });

  it('keeps the browser default as committed when the persisted sink is unavailable', async() => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'setSinkId');
    const error = new Error('saved speaker unavailable');
    const setSinkId = vi.fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true,
      value: setSinkId
    });
    mocks.appSettings.callDevices.speakerId = 'speaker-stale';
    const {instance} = createHarness();

    try {
      await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledTimes(2));
      expect(setSinkId.mock.calls).toEqual([['speaker-stale'], ['']]);
      expect((instance as any).outputDeviceId).toBe('');
    } finally {
      instance.cleanup();
      if(originalDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', originalDescriptor);
      } else {
        delete (HTMLMediaElement.prototype as any).setSinkId;
      }
    }
  });

  it('rolls every element back and rejects when one setSinkId fails', async() => {
    const {instance} = createHarness();
    const error = new Error('speaker unavailable');
    const setSinkA = vi.fn().mockResolvedValue(undefined);
    const setSinkB = vi.fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(undefined);
    (instance as any).elements = new Map([
      ['a', {setSinkId: setSinkA}],
      ['b', {setSinkId: setSinkB}]
    ]);

    await expect(instance.setOutputDeviceId('speaker-b')).rejects.toBe(error);

    expect(setSinkA).toHaveBeenNthCalledWith(1, 'speaker-b');
    expect(setSinkA).toHaveBeenNthCalledWith(2, '');
    expect(setSinkB).toHaveBeenNthCalledWith(1, 'speaker-b');
    expect(setSinkB).toHaveBeenNthCalledWith(2, '');
    instance.cleanup();
  });

  it('serializes rapid output selections and leaves the latest sink applied', async() => {
    const {instance} = createHarness();
    const firstSinkChange = deferred<void>();
    const setSinkId = vi.fn()
    .mockReturnValueOnce(firstSinkChange.promise)
    .mockResolvedValue(undefined);
    (instance as any).elements = new Map([['audio', {setSinkId}]]);

    const changeA = instance.setOutputDeviceId('speaker-a');
    await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledWith('speaker-a'));
    const changeB = instance.setOutputDeviceId('speaker-b');
    firstSinkChange.resolve();

    await expect(changeA).resolves.toBe(false);
    await expect(changeB).resolves.toBe(true);
    expect(setSinkId.mock.calls).toEqual([
      ['speaker-a'],
      [''],
      ['speaker-b']
    ]);
    instance.cleanup();
  });

  it('applies the sink to the session audio element exactly once', async() => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const audio = {setSinkId} as unknown as HTMLAudioElement;
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      elements: new Map([['same-audio', audio]]),
      mediaDeviceChangeGenerations: {audio: 0, output: 0, video: 0},
      mediaDeviceChangeQueues: {
        audio: createSerializedQueue(),
        output: createSerializedQueue(),
        video: createSerializedQueue()
      },
      outputDeviceId: 'speaker-old',
      session: {audioElement: audio}
    }) as CallInstance;

    await expect(instance.setOutputDeviceId('speaker-new')).resolves.toBe(true);

    expect(setSinkId).toHaveBeenCalledTimes(1);
    expect(setSinkId).toHaveBeenCalledWith('speaker-new');
    expect((instance as any).outputDeviceId).toBe('speaker-new');
  });

  it('rolls base and session audio sinks back together after a partial failure', async() => {
    const error = new Error('P2P sink unavailable');
    const setBaseSink = vi.fn().mockResolvedValue(undefined);
    const setP2pSink = vi.fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(undefined);
    const p2pAudio = {setSinkId: setP2pSink} as unknown as HTMLAudioElement;
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      elements: new Map([['base', {setSinkId: setBaseSink}]]),
      mediaDeviceChangeGenerations: {audio: 0, output: 0, video: 0},
      mediaDeviceChangeQueues: {
        audio: createSerializedQueue(),
        output: createSerializedQueue(),
        video: createSerializedQueue()
      },
      outputDeviceId: 'speaker-old',
      session: {audioElement: p2pAudio}
    }) as CallInstance;

    await expect(instance.setOutputDeviceId('speaker-new')).rejects.toBe(error);

    expect(setBaseSink.mock.calls).toEqual([['speaker-new'], ['speaker-old']]);
    expect(setP2pSink.mock.calls).toEqual([['speaker-new'], ['speaker-old']]);
    expect((instance as any).outputDeviceId).toBe('speaker-old');
  });

  it('applies the committed sink when the session audio element is created', async() => {
    const setBaseSink = vi.fn().mockResolvedValue(undefined);
    const setP2pSink = vi.fn().mockResolvedValue(undefined);
    const p2pAudio = {setSinkId: setP2pSink} as unknown as HTMLAudioElement;
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      elements: new Map([['base', {setSinkId: setBaseSink}]]),
      log: {warn: vi.fn()},
      mediaDeviceChangeGenerations: {audio: 0, output: 0, video: 0},
      mediaDeviceChangeQueues: {
        audio: createSerializedQueue(),
        output: createSerializedQueue(),
        video: createSerializedQueue()
      },
      outputDeviceId: 'speaker-saved',
      session: {audioElement: p2pAudio}
    }) as CallInstance;

    (instance as any).applyCurrentOutputDeviceToElement(p2pAudio);
    await (instance as any).mediaDeviceChangeQueues.output.enqueue(async() => {});

    expect(setBaseSink).not.toHaveBeenCalled();
    expect(setP2pSink).toHaveBeenCalledWith('speaker-saved');
  });
});

describe('mid-call camera device swap', () => {
  it('drops an older camera acquisition that resolves after the latest selection', async() => {
    const {getCurrentTrack, instance, manager, oldTrack, replaceTrack} = createVideoHarness();
    const trackA = makeTrack('video');
    const trackB = makeTrack('video');
    const acquireA = deferred<MediaStream>();
    const acquireB = deferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(acquireA.promise).mockReturnValueOnce(acquireB.promise);

    const changeA = instance.setInputVideoDeviceId('camera-a');
    const changeB = instance.setInputVideoDeviceId('camera-b');
    acquireB.resolve(makeStream(trackB));
    await expect(changeB).resolves.toBe(true);
    acquireA.resolve(makeStream(trackA));
    await expect(changeA).resolves.toBe(false);

    expect(replaceTrack).toHaveBeenCalledTimes(1);
    expect(replaceTrack).toHaveBeenCalledWith('video', oldTrack, trackB);
    expect(manager.addTrack).toHaveBeenCalledTimes(1);
    expect(getCurrentTrack()).toBe(trackB);
    expect(trackA.stop).toHaveBeenCalledTimes(1);
    instance.cleanup();
  });
});

describe('input stream publishing', () => {
  it('releases a stream when hangup wins while the publish is pending', async() => {
    const {instance, manager} = createHarness();
    const track = makeTrack();
    const publication = deferred<void>();
    Object.assign(manager, {
      addStream: vi.fn(),
      removeTrack: vi.fn()
    });
    const publish = vi.fn(() => publication.promise);
    instance.publishImpl = publish;

    const attachment = (instance as any).onInputStream(makeStream(track));
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    instance.closing = true;
    publication.resolve();
    await attachment;

    expect(track.stop).toHaveBeenCalledTimes(1);
    instance.cleanup();
  });

  it('removes and stops a newly added stream when the publish rejects', async() => {
    const {instance, manager} = createHarness();
    const track = makeTrack();
    const publishError = new Error('initial publish rejected');
    Object.assign(manager, {
      addStream: vi.fn(),
      removeTrack: vi.fn()
    });
    instance.publishImpl = vi.fn().mockRejectedValue(publishError);

    await expect((instance as any).onInputStream(makeStream(track))).rejects.toBe(publishError);

    expect((manager as any).removeTrack).toHaveBeenCalledWith(track);
    expect(track.stop).toHaveBeenCalledTimes(1);
    instance.cleanup();
  });
});

describe('session microphone device swap', () => {
  it('keeps the latest device when acquisitions resolve B before A', async() => {
    const oldTrack = makeTrack();
    const trackA = makeTrack();
    const trackB = makeTrack();
    const {instance, session, transport} = makeSessionInstance(oldTrack);
    const acquireA = deferred<MediaStream>();
    const acquireB = deferred<MediaStream>();
    mocks.getStream.mockReturnValueOnce(acquireA.promise).mockReturnValueOnce(acquireB.promise);

    const changeA = instance.setInputAudioDeviceId('mic-a');
    const changeB = instance.setInputAudioDeviceId('mic-b');
    acquireB.resolve(makeStream(trackB));
    await expect(changeB).resolves.toBe(true);
    acquireA.resolve(makeStream(trackA));
    await expect(changeA).resolves.toBe(false);

    expect(transport.calls.filter((call) => call === 'replace:microphone')).toHaveLength(1);
    expect(transport.published.get('microphone')).toBe(trackB);
    expect(session.getStreams().ownAudio?.getAudioTracks()[0]).toBe(trackB);
    expect(trackA.stop).toHaveBeenCalledTimes(1);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a microphone acquired while the track replacement outlives hangup', async() => {
    const oldTrack = makeTrack();
    const newTrack = makeTrack();
    const {instance, session, transport} = makeSessionInstance(oldTrack);
    const replacement = deferred<void>();
    transport.hold('replace', replacement.promise);
    mocks.getStream.mockResolvedValue(makeStream(newTrack));

    const change = instance.setInputAudioDeviceId('new-mic');
    await vi.waitFor(() => expect(transport.calls).toContain('replace:microphone'));
    (instance as any).session = undefined;
    replacement.resolve();

    await expect(change).resolves.toBe(true);
    expect(session.getStreams().ownAudio?.getAudioTracks()[0]).toBe(oldTrack);
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('does not publish a microphone acquired after the call was muted', async() => {
    const oldTrack = makeTrack();
    const newTrack = makeTrack();
    const {instance, session, transport} = makeSessionInstance(oldTrack);
    const acquisition = deferred<MediaStream>();
    mocks.getStream.mockReturnValue(acquisition.promise);

    const change = instance.setInputAudioDeviceId('new-mic');
    await vi.waitFor(() => expect(mocks.getStream).toHaveBeenCalledTimes(1));
    await (instance as any).toggleStream('audio', false);
    expect(transport.muted.get('microphone')).toBe(true);

    acquisition.resolve(makeStream(newTrack));
    await expect(change).resolves.toBe(false);

    expect(transport.calls).not.toContain('replace:microphone');
    expect(session.getStreams().ownAudio).toBeUndefined();
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('does not commit a microphone replacement after a concurrent mute', async() => {
    const oldTrack = makeTrack();
    const newTrack = makeTrack();
    const {instance, session, transport} = makeSessionInstance(oldTrack);
    const replacement = deferred<void>();
    transport.hold('replace', replacement.promise);
    mocks.getStream.mockResolvedValue(makeStream(newTrack));

    const change = instance.setInputAudioDeviceId('new-mic');
    await vi.waitFor(() => expect(transport.calls).toContain('replace:microphone'));

    await (instance as any).toggleStream('audio', false);
    expect(transport.muted.get('microphone')).toBe(true);

    replacement.resolve();
    await expect(change).resolves.toBe(false);

    expect(session.getStreams().ownAudio).toBeUndefined();
    expect(transport.muted.get('microphone')).toBe(true);
    expect(transport.calls.filter((call) => call === 'replace:microphone')).toHaveLength(1);
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('propagates an enable failure to the microphone UI action and releases the capture', async() => {
    const newTrack = makeTrack();
    const {instance, transport} = makeSessionInstance();
    const replacementError = new Error('publish rejected');
    transport.failNext('replace', replacementError);
    mocks.getStream.mockResolvedValue(makeStream(newTrack));

    await expect((instance as any).toggleStream('audio', true)).rejects.toBe(replacementError);

    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a newly enabled microphone when hangup wins during publishing', async() => {
    const newTrack = makeTrack();
    const {instance, transport} = makeSessionInstance();
    const replacement = deferred<void>();
    transport.hold('replace', replacement.promise);
    mocks.getStream.mockResolvedValue(makeStream(newTrack));

    const enable = (instance as any).toggleStream('audio', true);
    await vi.waitFor(() => expect(transport.calls).toContain('replace:microphone'));
    (instance as any).session = undefined;
    replacement.resolve();

    await expect(enable).rejects.toThrow(/closed during publishing/);
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('publishes an unmute through the same publication and clears the mute flag', async() => {
    const newTrack = makeTrack();
    const {instance, transport} = makeSessionInstance();
    mocks.getStream.mockResolvedValue(makeStream(newTrack));

    await (instance as any).toggleStream('audio', true);

    expect(transport.calls.slice(-2)).toEqual(['replace:microphone', 'setMuted:microphone:false']);
    expect(transport.published.get('microphone')).toBe(newTrack);
    expect(transport.muted.get('microphone')).toBe(false);
    expect(instance.isMuted).toBe(false);
  });

  it('propagates a mute failure instead of reporting success and keeps the capture closed locally', async() => {
    const oldTrack = makeTrack();
    const {instance, transport} = makeSessionInstance(oldTrack);
    const muteError = new Error('mute rejected');
    transport.failNext('setMuted', muteError);

    await expect(instance.toggleMuted()).rejects.toBe(muteError);

    expect(oldTrack.stop).not.toHaveBeenCalled();
    expect(oldTrack.enabled).toBe(false);
    expect(instance.dispatchEvent).toHaveBeenCalledWith('muted', true);
    expect(instance.dispatchEvent).toHaveBeenCalledWith('mediaState', expect.objectContaining({muted: true}));
  });

  it('mutes by muting the publication and releasing the microphone', async() => {
    const oldTrack = makeTrack();
    const {instance, session, transport} = makeSessionInstance(oldTrack);

    await instance.toggleMuted();

    expect(transport.calls.slice(-1)).toEqual(['setMuted:microphone:true']);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.getStreams().ownAudio).toBeUndefined();
    expect(instance.isMuted).toBe(true);
  });
});

describe('media session failure cleanup', () => {
  it('uses a monotonic clock for call ordering and connected duration', () => {
    let monotonicNow = 1000;
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(5000000);
    const instance = new CallInstance({
      isOutgoing: true,
      interlocutorUserId: 123 as UserId,
      managers: {} as any
    });
    (instance.streamManager as any).stop = vi.fn();

    expect(instance.createdAt).toBe(1000);
    monotonicNow = 4000;
    (instance as any).onUpdate({
      '@type': 'updatePhoneCallConnectionState',
      connectionState: 'connected'
    });
    expect(instance.connectedAt).toBe(4000);

    wallClock.mockReturnValue(-5000000);
    monotonicNow = 6500;
    expect(instance.duration).toBe(2);

    instance.cleanup();
    performanceNow.mockRestore();
    wallClock.mockRestore();
  });

  it('publishes the server discard after the derived state becomes closed', async() => {
    vi.stubGlobal('MediaStream', class {});
    const ownAudioTrack = makeTrack();
    const ownVideoTrack = makeTrack('video');
    const {session, transport} = makeSessionInstance(ownAudioTrack);
    session.adoptOwnStream({kind: 'video', stream: makeStream(ownVideoTrack)});
    // what the world looked like when the discard went out: capture already stopped, room still up
    const atDiscard: {audioStops: number, videoStops: number, disconnects: number}[] = [];
    const discardCall = vi.fn(async() => {
      atDiscard.push({
        audioStops: ownAudioTrack.stop.mock.calls.length,
        videoStops: ownVideoTrack.stop.mock.calls.length,
        disconnects: transport.disconnectCount
      });
    });
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      connectedAt: Date.now() - 1000,
      id: 'failed-call',
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      managers: {appCallsManager: {discardCall}},
      overrideConnectionState: vi.fn(),
      session,
      sessionState: 'connected'
    }) as CallInstance;

    (instance as any).onUpdate({
      '@type': 'updatePhoneCallConnectionState',
      connectionState: 'failed'
    });

    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledTimes(1));
    expect(discardCall).toHaveBeenCalledWith(
      'failed-call',
      expect.any(Number),
      {_: 'phoneCallDiscardReasonDisconnect'},
      true
    );
    expect(atDiscard).toEqual([{audioStops: 1, videoStops: 1, disconnects: 0}]);
    await vi.waitFor(() => expect(transport.disconnectCount).toBe(1));
    expect(ownAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(ownVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect((instance as any).session).toBeUndefined();
  });

  it('tears down locally without a discard RPC when the room was deleted', async() => {
    vi.stubGlobal('MediaStream', class {});
    const ownAudioTrack = makeTrack();
    const discardCall = vi.fn().mockResolvedValue(undefined);
    const {session, transport} = makeSessionInstance(ownAudioTrack);
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      id: 'deleted-room-call',
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      managers: {appCallsManager: {discardCall}},
      overrideConnectionState: vi.fn(),
      session,
      sessionState: 'connected'
    }) as CallInstance;

    (instance as any).onUpdate({
      '@type': 'updatePhoneCallConnectionState',
      connectionState: 'roomDeleted'
    });

    await vi.waitFor(() => expect(transport.disconnectCount).toBe(1));
    expect(discardCall).not.toHaveBeenCalled();
    expect(ownAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect((instance as any).session).toBeUndefined();
  });
});

describe('accept transaction', () => {
  function createAcceptHarness() {
    let closing = false;
    const generateDh = vi.fn().mockResolvedValue({
      a: new Uint8Array([1]),
      g_a: new Uint8Array([2]),
      g_a_hash: new Uint8Array([3]),
      p: new Uint8Array([4])
    });
    const acceptCall = vi.fn();
    const discardCall = vi.fn().mockResolvedValue(undefined);
    const hangUp = vi.fn(async() => {
      closing = true;
    });
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      _connectionState: CALL_STATE.PENDING,
      call: {
        _: 'phoneCallRequested',
        id: 'incoming-call',
        g_a_hash: new Uint8Array([9]),
        pFlags: {video: true}
      },
      dispatchResultableEvent: vi.fn(),
      hangUp,
      id: 'incoming-call',
      log: Object.assign(vi.fn(), {error: vi.fn(), warn: vi.fn()}),
      managers: {
        appCallsManager: {acceptCall, discardCall, generateDh}
      },
      overrideConnectionState: vi.fn((state: CALL_STATE) => {
        (instance as any)._connectionState = state;
      }),
      protocol: {_: 'phoneCallProtocol'}
    }) as CallInstance;
    Object.defineProperty(instance, 'isClosing', {
      configurable: true,
      get: () => closing
    });

    return {
      acceptCall,
      close: () => closing = true,
      discardCall,
      generateDh,
      hangUp,
      instance
    };
  }

  it('lets the override own and await the complete DH plus accept RPC transaction', async() => {
    const harness = createAcceptHarness();
    const accepted = deferred<any>();
    harness.acceptCall.mockReturnValue(accepted.promise);
    (harness.instance as any).dispatchResultableEvent.mockImplementation((_name: string, accept: () => Promise<void>) => {
      return [(async() => {
        await accept();
      })()];
    });

    let settled = false;
    const transaction = harness.instance.acceptCall().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(harness.acceptCall).toHaveBeenCalledWith(
      'incoming-call',
      {_: 'phoneCallProtocol'},
      new Uint8Array([2]),
      true
    ));
    expect(settled).toBe(false);

    accepted.resolve({_: 'phoneCall', id: 'incoming-call', access_hash: 'hash'});
    await transaction;
    expect(settled).toBe(true);
    expect(harness.hangUp).not.toHaveBeenCalled();
  });

  it('compensates the exact accepted call and stays pending when close wins the RPC race', async() => {
    const harness = createAcceptHarness();
    const accepted = deferred<any>();
    const compensation = deferred<void>();
    harness.acceptCall.mockReturnValue(accepted.promise);
    harness.discardCall.mockReturnValue(compensation.promise);
    (harness.instance as any).dispatchResultableEvent.mockImplementation((_name: string, accept: () => Promise<void>) => {
      return [accept()];
    });

    let settled = false;
    const transaction = harness.instance.acceptCall().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(harness.acceptCall).toHaveBeenCalledTimes(1));
    harness.close();
    accepted.resolve({_: 'phoneCall', id: 'accepted-call', access_hash: 'accepted-hash'});
    await vi.waitFor(() => expect(harness.discardCall).toHaveBeenCalledWith(
      'accepted-call',
      0,
      {_: 'phoneCallDiscardReasonHangup'},
      true
    ));
    expect(settled).toBe(false);

    compensation.resolve();
    await transaction;
    expect(harness.hangUp).not.toHaveBeenCalled();
  });

  it('does not fall through to an unlocked accept when an override cancels', async() => {
    const harness = createAcceptHarness();
    (harness.instance as any).dispatchResultableEvent.mockReturnValue([Promise.resolve()]);

    await harness.instance.acceptCall();

    expect(harness.generateDh).not.toHaveBeenCalled();
    expect(harness.acceptCall).not.toHaveBeenCalled();
  });

  it('does not join and compensates when close wins an outgoing confirm RPC race', async() => {
    let closing = false;
    const confirmed = deferred<any>();
    const compensation = deferred<void>();
    const computeKey = vi.fn().mockResolvedValue({
      key: new Uint8Array([7]),
      key_fingerprint: 'fingerprint'
    });
    const confirmCall = vi.fn().mockReturnValue(confirmed.promise);
    const discardCall = vi.fn().mockReturnValue(compensation.promise);
    const joinCall = vi.fn();
    const instance = Object.assign(Object.create(CallInstance.prototype), {
      _connectionState: CALL_STATE.PENDING,
      call: {
        _: 'phoneCallAccepted',
        g_b: new Uint8Array([5]),
        pFlags: {video: true}
      },
      dh: {
        a: new Uint8Array([1]),
        g_a: new Uint8Array([2]),
        p: new Uint8Array([3])
      },
      hangUp: vi.fn(),
      id: 'outgoing-call',
      joinCall,
      log: Object.assign(vi.fn(), {error: vi.fn(), warn: vi.fn()}),
      managers: {
        appCallsManager: {computeKey, confirmCall, discardCall}
      },
      overrideConnectionState: vi.fn(),
      protocol: {_: 'phoneCallProtocol'}
    }) as CallInstance;
    Object.defineProperty(instance, 'isClosing', {
      configurable: true,
      get: () => closing
    });

    let settled = false;
    const transaction = instance.confirmCall().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(confirmCall).toHaveBeenCalledWith(
      'outgoing-call',
      {_: 'phoneCallProtocol'},
      new Uint8Array([2]),
      'fingerprint',
      true
    ));
    closing = true;
    confirmed.resolve({_: 'phoneCall', id: 'confirmed-call', access_hash: 'confirmed-hash'});
    await vi.waitFor(() => expect(discardCall).toHaveBeenCalledWith(
      'confirmed-call',
      0,
      {_: 'phoneCallDiscardReasonHangup'},
      true
    ));
    expect(joinCall).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    compensation.resolve();
    await transaction;
    expect(joinCall).not.toHaveBeenCalled();
  });
});

describe('exclusive camera and screen transactions', () => {
  function makeHarness() {
    const {instance, session, transport} = makeSessionInstance();
    (instance as any).facingMode = 'user';
    return {instance, session, transport};
  }

  it('unpublishes the screen when the camera is enabled', async() => {
    const harness = makeHarness();
    const activePresentationTrack = makeTrack('video');
    harness.transport.published.set('screen', activePresentationTrack);
    harness.session.adoptOwnStream({kind: 'presentation', stream: makeStream(activePresentationTrack)});
    const newVideoTrack = makeTrack('video');
    mocks.getUserStream.mockResolvedValueOnce(makeStream(newVideoTrack));

    await (harness.instance as any).toggleStream('video', true);

    expect(harness.transport.published.get('camera')).toBe(newVideoTrack);
    expect(harness.transport.published.has('screen')).toBe(false);
    expect(activePresentationTrack.stop).toHaveBeenCalledTimes(1);
    expect(newVideoTrack.stop).not.toHaveBeenCalled();
    expect(harness.session.getStreams().ownPresentation).toBeUndefined();
  });

  it('rolls camera enable back when unpublishing the screen fails', async() => {
    const harness = makeHarness();
    const activePresentationTrack = makeTrack('video');
    const activePresentation = makeStream(activePresentationTrack);
    harness.transport.published.set('screen', activePresentationTrack);
    harness.session.adoptOwnStream({kind: 'presentation', stream: activePresentation});
    const newVideoTrack = makeTrack('video');
    const error = new Error('screen unpublish rejected');
    harness.transport.failNext('unpublish', error);
    mocks.getUserStream.mockResolvedValueOnce(makeStream(newVideoTrack));

    await expect((harness.instance as any).toggleStream('video', true)).rejects.toBe(error);

    expect(harness.transport.calls).toEqual(expect.arrayContaining(['publish:camera', 'unpublish:screen', 'unpublish:camera']));
    expect(harness.transport.published.has('camera')).toBe(false);
    expect(harness.session.getStreams().ownVideo).toBeUndefined();
    expect(harness.session.getStreams().ownPresentation).toBe(activePresentation);
    expect(newVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(activePresentationTrack.stop).not.toHaveBeenCalled();
  });

  it('rolls screen enable back when unpublishing the camera fails', async() => {
    const harness = makeHarness();
    const activeVideoTrack = makeTrack('video');
    const activeVideo = makeStream(activeVideoTrack);
    harness.transport.published.set('camera', activeVideoTrack);
    harness.session.adoptOwnStream({kind: 'video', stream: activeVideo});
    const newPresentationTrack = makeTrack('video');
    const error = new Error('camera unpublish rejected');
    harness.transport.failNext('unpublish', error);
    mocks.getUserStream.mockResolvedValueOnce(makeStream(newPresentationTrack));

    await expect((harness.instance as any).toggleStream('presentation', true)).rejects.toBe(error);

    expect(harness.transport.published.has('screen')).toBe(false);
    expect(harness.session.getStreams().ownPresentation).toBeUndefined();
    expect(harness.session.getStreams().ownVideo).toBe(activeVideo);
    expect(newPresentationTrack.stop).toHaveBeenCalledTimes(1);
    expect(activeVideoTrack.stop).not.toHaveBeenCalled();
  });

  it.each(['video', 'presentation'] as const)(
    'releases a newly enabled %s stream when hangup wins during publishing',
    async(streamType) => {
      const harness = makeHarness();
      const newTrack = makeTrack('video');
      const publication = deferred<void>();
      harness.transport.hold('publish', publication.promise);
      mocks.getUserStream.mockResolvedValue(makeStream(newTrack));

      const enable = (harness.instance as any).toggleStream(streamType, true);
      await vi.waitFor(() => expect(harness.transport.calls).toContain(`publish:${streamType === 'video' ? 'camera' : 'screen'}`));
      (harness.instance as any).session = undefined;
      publication.resolve();

      await expect(enable).rejects.toThrow(/closed during publishing/);
      expect(newTrack.stop).toHaveBeenCalledTimes(1);
    }
  );
});
