import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';

const callMocks = vi.hoisted(() => ({
  createMainStreamManager: vi.fn(),
  toastNew: vi.fn(),
  instances: [] as any[],
  joinError: undefined as unknown,
  joinAccepted: false,
  acceptedCallInput: undefined as any,
  nextSource: 777
}));

vi.mock('@lib/calls/helpers/createMainStreamManager', () => ({default: callMocks.createMainStreamManager}));
vi.mock('@components/toast', () => ({toastNew: callMocks.toastNew}));

vi.mock('@lib/calls/groupCallInstance', async() => {
  const {default: FakePhoneCallTransport} = await import('./helpers/fakePhoneCallTransport');

  class FakeGroupCallInstance {
    public id: string;
    public chatId: PeerId;
    public groupCall: any;
    public connections: Record<string, any> = {};
    public participant: any;
    public joined = false;
    public isClosing = false;
    public isMuted = true;
    public isSharingVideo = false;
    public state = 0;
    public fixSafariAudio = vi.fn();
    public cleanup = vi.fn();
    public resetRemoteMedia = vi.fn();
    public markHungUp = vi.fn();
    public hangUp = vi.fn(async() => {});
    public onParticipantUpdate = vi.fn();
    public participants: Promise<Map<PeerId, any>> = Promise.resolve(new Map());
    private listeners = new Map<string, Array<(...payload: any[]) => void>>();
    public addEventListener = vi.fn((event: string, listener: (...payload: any[]) => void) => {
      const listeners = this.listeners.get(event) || [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    });
    public dispatchEvent = vi.fn((event: string, ...payload: any[]) => {
      for(const listener of this.listeners.get(event) || []) listener(...payload);
    });

    public toInputGroupCall() {
      return this.groupCall?._ === 'groupCall' ? {
        _: 'inputGroupCall' as const,
        id: this.groupCall.id,
        access_hash: this.groupCall.access_hash
      } : undefined;
    }

    constructor(options: {id: string, chatId: PeerId}) {
      this.id = options.id;
      this.chatId = options.chatId;
      callMocks.instances.push(this);
    }

    public createConnectionInstance({streamManager, options}: {streamManager: {stop: () => void}, options: any}) {
      const transport = new FakePhoneCallTransport();
      const connection: any = {
        options,
        transport,
        streamManager,
        joinAccepted: callMocks.joinAccepted,
        acceptedCallInput: callMocks.acceptedCallInput,
        sources: {audio: {source: callMocks.nextSource}},
        join: vi.fn(async() => {
          if(callMocks.joinError !== undefined) throw callMocks.joinError;
        }),
        closeConnection: vi.fn(() => transport.disconnect()),
        closeConnectionAndStream: vi.fn((stopStream: boolean) => {
          transport.disconnect();
          if(stopStream) streamManager.stop();
        })
      };
      this.connections.main = connection;
      return connection;
    }
  }

  return {default: FakeGroupCallInstance};
});

import {GroupCallsController} from '@lib/calls/groupCallsController';
import ConferenceUnsupportedError from '@lib/calls/conferenceUnsupportedError';
import rootScope from '@lib/rootScope';
import type {InputGroupCall} from '@layer';
import FakePhoneCallTransport from './helpers/fakePhoneCallTransport';

const INPUT: Extract<InputGroupCall, {_: 'inputGroupCall'}> = {_: 'inputGroupCall', id: '700', access_hash: '701'};
const CHAT_ID = 99 as ChatId;

function makeController() {
  const audioAsset = {
    createAudio: vi.fn(),
    play: vi.fn(),
    stop: vi.fn(),
    playWithTimeout: vi.fn(),
    cancelDelayedPlay: vi.fn()
  };
  const appGroupCallsManager = {
    getGroupCallFull: vi.fn(async() => ({_: 'groupCall', pFlags: {}, id: INPUT.id, access_hash: INPUT.access_hash})),
    getGroupCallParticipants: vi.fn(async() => []),
    checkGroupCall: vi.fn(async(): Promise<number[]> => []),
    leaveGroupCall: vi.fn(async() => {}),
    setRealtimeCall: vi.fn(async(_chatId: ChatId, _groupCallId: unknown, _active: boolean) => {}),
    hangUp: vi.fn(async() => {})
  };
  const log = Object.assign(vi.fn(), {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    bindPrefix: () => log
  });
  const controller = new GroupCallsController();
  Object.assign(controller as any, {audioAsset, log, managers: {appGroupCallsManager}});
  return {audioAsset, appGroupCallsManager, controller, log};
}

function lastInstance(): any {
  return callMocks.instances[callMocks.instances.length - 1];
}

async function joinCall(controller: GroupCallsController, muted = true, joinVideo?: boolean) {
  await controller.joinGroupCall(CHAT_ID, INPUT.id as any, muted, false, joinVideo);
  const instance = lastInstance();
  return {instance, connection: instance.connections.main, transport: instance.connections.main.transport as FakePhoneCallTransport};
}

beforeEach(() => {
  callMocks.instances.length = 0;
  callMocks.joinError = undefined;
  callMocks.joinAccepted = false;
  callMocks.acceptedCallInput = undefined;
  callMocks.nextSource = 777;
  callMocks.createMainStreamManager.mockReset().mockResolvedValue({stop: vi.fn()});
  callMocks.toastNew.mockReset();
  FakePhoneCallTransport.instances = [];
  vi.spyOn(rootScope, 'dispatchEvent').mockImplementation((() => {}) as any);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GroupCallsController join', () => {
  it('joins the main connection with the options of the call and makes the instance current', async() => {
    const {controller, audioAsset} = makeController();
    callMocks.createMainStreamManager.mockResolvedValue({stop: vi.fn()});

    const {instance, connection} = await joinCall(controller, false, true);

    expect(callMocks.createMainStreamManager).toHaveBeenCalledWith(false, true);
    expect(connection.options).toEqual({type: 'main', isMuted: false, joinVideo: true, rejoin: false});
    expect(connection.join).toHaveBeenCalledTimes(1);
    expect(controller.groupCall).toBe(instance);
    expect(audioAsset.playWithTimeout).toHaveBeenCalledWith({name: 'connect', loop: true}, 2500);
  });

  it('reads the realtime lanes of the call while in it and leaves them when the call closes, not on a rejoin', async() => {
    const {controller, appGroupCallsManager} = makeController();
    const {instance} = await joinCall(controller);
    expect(appGroupCallsManager.setRealtimeCall).toHaveBeenCalledTimes(1);
    expect(appGroupCallsManager.setRealtimeCall).toHaveBeenLastCalledWith(CHAT_ID, INPUT.id, true);

    await controller.joinGroupCall(CHAT_ID, INPUT.id as any, true, true);
    expect(appGroupCallsManager.setRealtimeCall).toHaveBeenCalledTimes(1);

    const GROUP_CALL_STATE_CLOSED = (await import('@lib/calls/groupCallState')).default.CLOSED;
    instance.dispatchEvent('state', GROUP_CALL_STATE_CLOSED);
    expect(appGroupCallsManager.setRealtimeCall).toHaveBeenLastCalledWith(CHAT_ID, INPUT.id, false);
  });

  it('is joined, announced and fed the roster when the transport connects, and only once', async() => {
    const {controller, appGroupCallsManager, audioAsset} = makeController();
    const {instance, transport} = await joinCall(controller);

    transport.emitState('connecting');
    expect(instance.joined).toBe(false);
    transport.emitState('connected');
    transport.emitState('reconnecting');
    transport.emitState('connected');

    expect(instance.joined).toBe(true);
    expect(audioAsset.play).toHaveBeenCalledTimes(1);
    expect(audioAsset.play).toHaveBeenCalledWith({name: 'start'});
    expect(appGroupCallsManager.getGroupCallParticipants).toHaveBeenCalledTimes(1);
    expect(instance.dispatchEvent).toHaveBeenCalledWith('state', instance.state);
  });

  it('plays the connecting tone while connecting or reconnecting and stops it once connected', async() => {
    const {controller, audioAsset} = makeController();
    const {transport} = await joinCall(controller);
    audioAsset.playWithTimeout.mockClear();
    audioAsset.stop.mockClear();

    transport.emitState('reconnecting');
    expect(audioAsset.playWithTimeout).toHaveBeenCalledTimes(1);
    transport.emitState('connected');
    expect(audioAsset.stop).toHaveBeenCalled();
  });

  it('hydrates the roster after a join except for our own row', async() => {
    const {controller} = makeController();
    const {instance} = await joinCall(controller);
    const self = {pFlags: {self: true}};
    const peer = {pFlags: {}};
    instance.participants = Promise.resolve(new Map<PeerId, any>([[1 as PeerId, self], [2 as PeerId, peer]]));

    // a rejoin runs the same hydration after its own join
    await controller.joinGroupCall(CHAT_ID, INPUT.id as any, true, true);

    await vi.waitFor(() => expect(instance.onParticipantUpdate).toHaveBeenCalledWith(peer));
    expect(instance.onParticipantUpdate).not.toHaveBeenCalledWith(self);
  });

  it('observes an initial roster failure without rejecting an accepted join', async() => {
    const {controller, log} = makeController();
    const {instance} = await joinCall(controller);
    const rosterError = new Error('initial roster proxy failed');
    instance.participants = Promise.reject(rosterError);
    vi.spyOn(controller as any, 'joinGroupCallInternal').mockResolvedValue(undefined);

    await expect(controller.joinGroupCall(CHAT_ID, INPUT.id as any, true, true)).resolves.toBeUndefined();

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('initial group call participant hydration failed', rosterError));
  });

  it('refuses a rejoin when there is no call', async() => {
    const {controller} = makeController();

    await expect(controller.joinGroupCall(CHAT_ID, INPUT.id as any, true, true)).rejects.toThrow(/no active group call/);
  });
});

describe('GroupCallsController join rollback', () => {
  // The microphone is captured before the join starts. Until the instance is current there is no UI that
  // could release it, so a failed join must undo the capture itself.
  it('releases the captured microphone when the call cannot even be fetched', async() => {
    const {appGroupCallsManager, controller} = makeController();
    const streamManager = {stop: vi.fn()};
    callMocks.createMainStreamManager.mockResolvedValue(streamManager);
    const fetchError = new Error('GROUPCALL_INVALID');
    appGroupCallsManager.getGroupCallFull.mockRejectedValueOnce(fetchError);

    await expect(controller.joinGroupCall(CHAT_ID, INPUT.id as any, true)).rejects.toBe(fetchError);

    expect(streamManager.stop).toHaveBeenCalledTimes(1);
    expect(callMocks.instances[0].cleanup).toHaveBeenCalledTimes(1);
    expect(controller.groupCall).toBeFalsy();
    expect(appGroupCallsManager.leaveGroupCall).not.toHaveBeenCalled();
  });

  it('closes the connection and leaves once, by the accepted identity and source, when the connect fails after the server accepted the join', async() => {
    const {appGroupCallsManager, controller} = makeController();
    const streamManager = {stop: vi.fn()};
    callMocks.createMainStreamManager.mockResolvedValue(streamManager);
    const connectError = new Error('LIVEKIT_PARAMS_MISSING');
    callMocks.joinError = connectError;
    callMocks.joinAccepted = true;
    callMocks.acceptedCallInput = INPUT;

    await expect(controller.joinGroupCall(CHAT_ID, INPUT.id as any, true)).rejects.toBe(connectError);

    const instance = callMocks.instances[0];
    expect(instance.connections.main.closeConnectionAndStream).toHaveBeenCalledWith(true);
    expect(streamManager.stop).toHaveBeenCalledTimes(1);
    expect(instance.markHungUp).toHaveBeenCalled();
    expect(instance.cleanup).toHaveBeenCalledTimes(1);
    expect(appGroupCallsManager.leaveGroupCall).toHaveBeenCalledTimes(1);
    expect(appGroupCallsManager.leaveGroupCall).toHaveBeenCalledWith(INPUT, 777);
    expect(controller.groupCall).toBeFalsy();
  });

  it('does not leave a join the server never accepted', async() => {
    const {appGroupCallsManager, controller} = makeController();
    callMocks.joinError = new Error('GROUPCALL_FORBIDDEN');
    callMocks.joinAccepted = false;

    await expect(controller.joinGroupCall(CHAT_ID, INPUT.id as any, true)).rejects.toThrow('GROUPCALL_FORBIDDEN');

    expect(appGroupCallsManager.leaveGroupCall).not.toHaveBeenCalled();
    expect(callMocks.instances[0].cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('GroupCallsController lost connection policy', () => {
  async function connected(options: {muted?: boolean, video?: boolean} = {}) {
    const harness = makeController();
    const joined = await joinCall(harness.controller, options.muted ?? true);
    joined.instance.isMuted = options.muted ?? true;
    joined.instance.isSharingVideo = !!options.video;
    joined.transport.emitState('connected');
    return {...harness, ...joined};
  }

  async function settle() {
    for(let i = 0; i < 10; ++i) await Promise.resolve();
  }

  it('does nothing when the connection was closed by us', async() => {
    const {controller, transport, instance} = await connected();
    const join = vi.spyOn(controller, 'joinGroupCall');

    transport.emitState('disconnected', 'client');
    await settle();

    expect(join).not.toHaveBeenCalled();
    expect(instance.hangUp).not.toHaveBeenCalled();
  });

  it.each(['network', 'unknown', 'rejected'] as const)('rejoins once, keeping the capture and the mute and video state, when the connection is lost: %s', async(cause) => {
    const {controller, transport, instance, connection} = await connected({muted: false, video: true});
    const join = vi.spyOn(controller, 'joinGroupCall');

    transport.emitState('disconnected', cause);
    await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(1));

    expect(join).toHaveBeenCalledWith(CHAT_ID, INPUT.id, false, true, true);
    await vi.waitFor(() => expect(instance.connections.main).not.toBe(connection));
    expect(instance.resetRemoteMedia).toHaveBeenCalledTimes(1);
    expect(instance.connections.main.options).toEqual({type: 'main', isMuted: false, joinVideo: true, rejoin: true});
    expect(connection.closeConnection).toHaveBeenCalledTimes(1);
    expect(instance.hangUp).not.toHaveBeenCalled();
    expect(controller.groupCall).toBe(instance);
  });

  it('ignores a late state event of the connection that a rejoin replaced', async() => {
    const {controller, transport, instance} = await connected();
    const join = vi.spyOn(controller, 'joinGroupCall');
    transport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(instance.connections.main.transport).not.toBe(transport));
    join.mockClear();
    instance.dispatchEvent.mockClear();

    transport.emitState('disconnected', 'network');
    await settle();

    expect(join).not.toHaveBeenCalled();
    expect(instance.dispatchEvent).not.toHaveBeenCalled();
  });

  it('leaves when the rejoined connection is lost too', async() => {
    const {controller, transport, instance} = await connected();
    transport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(instance.connections.main.transport).not.toBe(transport));
    const secondTransport = instance.connections.main.transport as FakePhoneCallTransport;
    const join = vi.spyOn(controller, 'joinGroupCall');

    secondTransport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(instance.hangUp).toHaveBeenCalledTimes(1));

    expect(join).not.toHaveBeenCalled();
  });

  it('gives a connection that stayed up long enough its one rejoin again', async() => {
    const {controller, transport, instance} = await connected();
    transport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(instance.connections.main.transport).not.toBe(transport));
    const secondTransport = instance.connections.main.transport as FakePhoneCallTransport;
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    secondTransport.emitState('connected');
    now.mockReturnValue(1000 + 60000);
    const join = vi.spyOn(controller, 'joinGroupCall');

    secondTransport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(1));

    expect(instance.hangUp).not.toHaveBeenCalled();
  });

  it('ends the call locally, without a leave, when the same identity connected elsewhere', async() => {
    const {transport, instance} = await connected();

    transport.emitState('disconnected', 'duplicateIdentity');
    await settle();

    expect(instance.hangUp).toHaveBeenCalledWith(false, false, true);
  });

  it('ends the call at once when the room was deleted, with no connecting sound and no timer', async() => {
    const {transport, instance, controller} = await connected();
    const connecting = vi.spyOn(controller, 'startConnectingSound');

    transport.emitState('disconnected', 'roomDeleted');

    expect(instance.hangUp).toHaveBeenCalledTimes(1);
    expect(instance.hangUp).toHaveBeenCalledWith(false, false, true);
    expect(connecting).not.toHaveBeenCalled();
  });

  it('does not tear down twice when the discard got there first', async() => {
    const {transport, instance} = await connected();

    instance.isClosing = true;
    transport.emitState('disconnected', 'roomDeleted');

    expect(instance.hangUp).not.toHaveBeenCalled();
  });

  it('does not play the connecting sound when a participant leaves the room', async() => {
    const {transport, controller} = await connected();
    const connecting = vi.spyOn(controller, 'startConnectingSound');

    transport.dispatchEvent('remoteParticipant', {identity: 'u9.1', present: false} as any);

    expect(connecting).not.toHaveBeenCalled();
  });

  describe('removed from the room', () => {
    it('asks the server which source it still has, by the source we declared', async() => {
      const {appGroupCallsManager, transport, instance} = await connected();
      appGroupCallsManager.checkGroupCall.mockResolvedValue([777]);

      transport.emitState('disconnected', 'removed');
      await vi.waitFor(() => expect(appGroupCallsManager.checkGroupCall).toHaveBeenCalledWith(INPUT, [777]));
      await vi.waitFor(() => expect(instance.connections.main.transport).not.toBe(transport));
    });

    it('leaves when the source is gone and our own row says we left', async() => {
      const {appGroupCallsManager, controller, transport, instance} = await connected();
      appGroupCallsManager.checkGroupCall.mockResolvedValue([]);
      instance.participant = {pFlags: {self: true, left: true}};
      const join = vi.spyOn(controller, 'joinGroupCall');

      transport.emitState('disconnected', 'removed');
      await vi.waitFor(() => expect(instance.hangUp).toHaveBeenCalledTimes(1));

      expect(join).not.toHaveBeenCalled();
    });

    it('rejoins when the source is gone but we were not told we left', async() => {
      const {appGroupCallsManager, controller, transport, instance} = await connected();
      appGroupCallsManager.checkGroupCall.mockResolvedValue([]);
      instance.participant = {pFlags: {self: true}};
      const join = vi.spyOn(controller, 'joinGroupCall');

      transport.emitState('disconnected', 'removed');
      await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(1));

      expect(instance.hangUp).not.toHaveBeenCalled();
    });

    it('rejoins when the check itself fails', async() => {
      const {appGroupCallsManager, controller, transport, instance, log} = await connected();
      appGroupCallsManager.checkGroupCall.mockRejectedValue(new Error('check failed'));
      const join = vi.spyOn(controller, 'joinGroupCall');

      transport.emitState('disconnected', 'removed');
      await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(1));

      expect(log.warn).toHaveBeenCalledWith('checking the group call source failed', expect.any(Error));
      expect(instance.hangUp).not.toHaveBeenCalled();
    });
  });

  it('leaves when a rejoin itself fails', async() => {
    const {controller, transport, instance} = await connected();
    callMocks.joinError = new Error('GROUPCALL_FORBIDDEN');
    const rollback = vi.spyOn(controller as any, 'rollbackFailedJoin');

    transport.emitState('disconnected', 'network');
    await vi.waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));

    expect(instance.cleanup).toHaveBeenCalled();
    expect(controller.groupCall).toBeFalsy();
  });
});

describe('GroupCallsController conference gate', () => {
  it.each(['startConference', 'joinConference'] as const)('%s refuses before any capture or request and tells the user', async(method) => {
    const {controller, appGroupCallsManager} = makeController();

    await expect((controller as any)[method]({input: INPUT, selfUserId: BigInt(1)})).rejects.toBeInstanceOf(ConferenceUnsupportedError);

    expect(callMocks.toastNew).toHaveBeenCalledWith({langPackKey: 'ConferenceCall.Unsupported'});
    expect(callMocks.createMainStreamManager).not.toHaveBeenCalled();
    expect(appGroupCallsManager.getGroupCallFull).not.toHaveBeenCalled();
    expect(callMocks.instances).toHaveLength(0);
  });
});
