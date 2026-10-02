import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

const cue = vi.hoisted(() => ({notifyAllowedToSpeak: vi.fn()}));
vi.mock('@components/groupCall/allowedToSpeakCue', () => ({default: cue.notifyAllowedToSpeak}));
vi.mock('@lib/calls/livekit/liveKitTransport', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');
  return {default: FakePhoneCallTransport};
});

import GroupCallInstance from '@lib/calls/groupCallInstance';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

class FakeTrack extends EventTarget {
  public readonly kind = 'audio';
  public enabled = true;
  public muted = false;
  public readyState: MediaStreamTrackState = 'live';
}

function selfRow(pFlags: Record<string, true>) {
  return {
    _: 'groupCallParticipant',
    peer: {_: 'peerUser', user_id: '42'},
    pFlags: {self: true, ...pFlags},
    source: 1,
    date: 1
  } as any;
}

function makeInstance() {
  const audioTrack = new FakeTrack();
  const managers: any = {
    appGroupCallsManager: {
      hangUp: vi.fn(async() => {}),
      editParticipant: vi.fn(async() => {}),
      leaveGroupCallPresentation: vi.fn(async() => {}),
      saveApiParticipant: vi.fn()
    },
    appCallsManager: {},
    apiUpdatesManager: {processUpdateMessage: vi.fn()}
  };
  const instance = new GroupCallInstance({id: 'permission' as any, chatId: 0 as any, managers});
  const streamManager: any = {
    inputStream: {getAudioTracks: () => [audioTrack], getVideoTracks: (): unknown[] => []},
    hasInputTrackKind: vi.fn(() => false),
    removeTrack: vi.fn(),
    stop: vi.fn()
  };
  const main = instance.createConnectionInstance({
    streamManager,
    type: 'main',
    options: {type: 'main', isMuted: false}
  });
  const transport = main.transport as unknown as FakePhoneCallTransport;
  transport.emitState('connected');
  main.sources = {audio: {source: 1}};
  const syncMicrophone = vi.spyOn(main, 'syncMicrophone').mockResolvedValue(undefined);
  instance.joined = true;
  vi.spyOn(instance, 'hangUp').mockResolvedValue(undefined);
  return {instance, main, transport, audioTrack, syncMicrophone, managers};
}

describe('group call forced mute through the LiveKit publish permission', () => {
  const instances: GroupCallInstance[] = [];

  beforeEach(() => {
    FakePhoneCallTransport.instances = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    for(const instance of instances.splice(0)) instance.cleanup();
    cue.notifyAllowedToSpeak.mockClear();
    vi.restoreAllMocks();
  });

  it('cuts the capture and mirrors the mute to the transport when the permission is revoked', () => {
    const {instance, transport, audioTrack, syncMicrophone} = makeInstance();
    instances.push(instance);
    instance.onParticipantUpdate(selfRow({can_self_unmute: true}));
    expect(audioTrack.enabled).toBe(true);

    transport.dispatchEvent('publishPermission', {canPublish: false, sources: []});

    expect(audioTrack.enabled).toBe(false);
    expect(syncMicrophone).toHaveBeenCalledWith(true);
    expect(cue.notifyAllowedToSpeak).not.toHaveBeenCalled();
  });

  it('tears camera and screen down when the permission is revoked while sharing', async() => {
    const {instance} = makeInstance();
    instances.push(instance);
    const stopScreenSharing = vi.spyOn(instance, 'stopScreenSharing').mockResolvedValue(undefined);
    const stopVideoSharing = vi.spyOn(instance, 'stopVideoSharing').mockResolvedValue(undefined);
    (instance.connections as any).presentation = {};
    instance.participant = selfRow({can_self_unmute: true});
    instance.participant.video = {_: 'groupCallParticipantVideo', pFlags: {}, endpoint: '', source_groups: []};

    instance.onPublishPermission(false);
    await (instance as any).adminMediaTeardownPromise;

    expect(stopScreenSharing).toHaveBeenCalledTimes(1);
    expect(stopVideoSharing).toHaveBeenCalledTimes(1);
  });

  it('republishes the microphone silent and cues once when the permission comes back with the row allowing it', () => {
    const {instance, audioTrack, syncMicrophone} = makeInstance();
    instances.push(instance);
    instance.onParticipantUpdate(selfRow({can_self_unmute: true}));
    instance.onPublishPermission(false);
    syncMicrophone.mockClear();

    instance.onPublishPermission(true);

    expect(cue.notifyAllowedToSpeak).toHaveBeenCalledTimes(1);
    expect(syncMicrophone).toHaveBeenCalledWith(true, audioTrack);
    // still muted: the cue is the only signal
    expect(audioTrack.enabled).toBe(false);

    instance.onPublishPermission(true);
    expect(cue.notifyAllowedToSpeak).toHaveBeenCalledTimes(1);
  });

  it('stays blocked while the row still forbids unmuting, and lifts when the row allows it', () => {
    const {instance, audioTrack, syncMicrophone} = makeInstance();
    instances.push(instance);
    instance.onParticipantUpdate(selfRow({muted: true}));
    instance.onPublishPermission(false);
    syncMicrophone.mockClear();

    instance.onPublishPermission(true);
    expect(cue.notifyAllowedToSpeak).not.toHaveBeenCalled();
    expect(syncMicrophone).not.toHaveBeenCalled();

    instance.onParticipantUpdate(selfRow({muted: true, can_self_unmute: true}));
    expect(cue.notifyAllowedToSpeak).toHaveBeenCalledTimes(1);
    expect(syncMicrophone).toHaveBeenCalledWith(true, audioTrack);
  });

  it('stays blocked while the permission is revoked even if the row allows unmuting', () => {
    const {instance, syncMicrophone} = makeInstance();
    instances.push(instance);
    instance.onParticipantUpdate(selfRow({muted: true}));
    instance.onPublishPermission(false);
    syncMicrophone.mockClear();

    instance.onParticipantUpdate(selfRow({muted: true, can_self_unmute: true}));

    expect(cue.notifyAllowedToSpeak).not.toHaveBeenCalled();
    expect(syncMicrophone).not.toHaveBeenCalledWith(true, expect.anything());
    expect((instance as any).adminMediaBlocked).toBe(true);
  });

  it('does not run the block twice when the row and the permission say it together', () => {
    const {instance} = makeInstance();
    instances.push(instance);
    instance.onParticipantUpdate(selfRow({can_self_unmute: true}));
    const teardown = vi.spyOn(instance as any, 'scheduleAdminMediaTeardown');

    instance.onParticipantUpdate(selfRow({muted: true}));
    instance.onPublishPermission(false);

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('does not cue before the call has joined', () => {
    const {instance} = makeInstance();
    instances.push(instance);
    instance.joined = false;
    instance.onPublishPermission(false);

    instance.onPublishPermission(true);

    expect(cue.notifyAllowedToSpeak).not.toHaveBeenCalled();
  });

  it('ignores a permission change once the call is closing', () => {
    const {instance, audioTrack, transport} = makeInstance();
    instances.push(instance);
    instance.markHungUp();
    transport.emitState('disconnected', 'client');
    expect(instance.isClosing).toBe(true);

    instance.onPublishPermission(false);

    expect(audioTrack.enabled).toBe(true);
  });

  it('applies a token that already forbids publishing as soon as the connection is up', () => {
    const {instance, audioTrack, transport} = makeInstance();
    instances.push(instance);
    transport.getPublishPermission = () => ({canPublish: false, sources: []}) as any;

    transport.emitState('reconnecting');
    transport.emitState('connected');

    expect(audioTrack.enabled).toBe(false);
    expect((instance as any).adminMediaBlocked).toBe(true);
  });

  it('mirrors every local mute change to the transport', () => {
    const {instance, audioTrack, syncMicrophone} = makeInstance();
    instances.push(instance);

    instance.setMuted(true);
    expect(audioTrack.enabled).toBe(false);
    expect(syncMicrophone).toHaveBeenLastCalledWith(true);

    instance.setMuted(false);
    expect(audioTrack.enabled).toBe(true);
    expect(syncMicrophone).toHaveBeenLastCalledWith(false);
  });

  it('only reports a failed mute sync, leaving the local capture as decided', async() => {
    const {instance, audioTrack, syncMicrophone} = makeInstance();
    instances.push(instance);
    const warn = vi.spyOn((instance as any).log, 'warn');
    const syncError = new Error('transport down');
    syncMicrophone.mockRejectedValue(syncError);

    instance.setMuted(true);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('syncing the microphone mute to the server failed', syncError));
    expect(audioTrack.enabled).toBe(false);
  });

  it('ignores a permission event of a connection that is no longer the main one', () => {
    const {instance, transport, audioTrack} = makeInstance();
    instances.push(instance);
    instance.createConnectionInstance({
      streamManager: {inputStream: {getAudioTracks: () => [audioTrack], getVideoTracks: (): unknown[] => []}, stop: vi.fn()} as any,
      type: 'main',
      options: {type: 'main', isMuted: false, rejoin: true}
    });

    transport.dispatchEvent('publishPermission', {canPublish: false, sources: []});

    expect(audioTrack.enabled).toBe(true);
  });
});
