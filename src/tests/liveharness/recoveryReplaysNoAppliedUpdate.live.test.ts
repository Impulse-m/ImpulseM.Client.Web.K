import {afterAll, beforeAll, expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona, Persona} from './personas';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';
import {protobufWireCodec} from './realtimeWire';
import type {WireCodec} from './realtimeWire';


/*
 * #757 — a recovered resubscribe must not re-apply an update the client already applied.
 *
 * The user-inbox subscription moves its recovery position with each publication it handles
 * (SDK: Subscription._setPublicationPosition). A resubscribe after a transport drop asks the server
 * to recover from that position. A pts-less update has no pts, so apiUpdatesManager.processUpdate
 * has no duplicate check for it: every saveUpdate is an application, and a replayed copy is applied
 * again. Canon's duplicate rule covers pts-carrying updates only (api/updates.md:2115-2116).
 *
 * Fact 1: an update applied live, then replayed by a recovered resubscribe, is applied twice.
 * Fact 2: an update published while the socket is down must be applied exactly once after the resubscribe.
 */
const subscribeTimeoutMs = 60_000;
const reconnectTimeoutMs = 60_000;
const liveApplyTimeoutMs = 60_000;
const importDeadlineMs = 45_000;
const importRetryMs = 500;
const recoveryQuietWindowMs = 2_000;
const normalCloseCode = 1000;
const liveUpdateTypes = ['updateUser', 'updatePeerSettings'];
const profileUpdateTypes = ['updateUserName', 'updateUser'];

type SocketRecord = {
  index: number,
  ws: any,
  closedAtMs: number | undefined
};

type SubscribeReply = {
  atMs: number,
  socket: number,
  channel: string,
  error: string | undefined,
  recoverable: boolean,
  recovered: boolean,
  wasRecovering: boolean,
  offset: unknown,
  epoch: unknown,
  publications: {offset: unknown}[]
};

type DispatchRecord = {
  atMs: number,
  predicates: string[]
};

type ApplyRecord = {
  atMs: number,
  predicate: string,
  userId: string | undefined,
  firstName: string | undefined
};

type TimelineEvent = {
  atMs: number,
  text: string
};


function describeValue(value: unknown): string {
  return value === undefined || value === null ? 'absent' : JSON.stringify(value);
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Wraps the CURRENT globalThis.WebSocket (installed by the boot hook) and records every frame of the
 * Centrifugo JSON protocol that concerns a subscription: the subscribe command the SDK sends, the reply
 * it gets (which carries the recovered publications and the recovered/wasRecovering flags the SDK
 * hands to its 'subscribed' event), and each live push publication with its offset. Nothing is
 * mutated or delayed.
 */
class ResubscribeWireRecorder {
  public readonly sockets: SocketRecord[] = [];
  public readonly subscribeReplies: SubscribeReply[] = [];
  public readonly livePublications: {atMs: number, socket: number, channel: string, offset: unknown}[] = [];
  public readonly timeline: TimelineEvent[] = [];

  private wrappedWebSocket: any;
  private readonly codec: WireCodec = protobufWireCodec();


  public install(): void {
    const recorder = this;
    const RealWebSocket: any = (globalThis as any).WebSocket;
    if(typeof RealWebSocket !== 'function') {
      throw new Error('ResubscribeWireRecorder.install: no WebSocket on globalThis — install after installNodeEnv()');
    }

    class ObservedWebSocket extends RealWebSocket {
      constructor(...args: any[]) {
        super(...args);
        const socket: SocketRecord = {index: recorder.sockets.length, ws: this, closedAtMs: undefined};
        recorder.sockets.push(socket);
        recorder.note(Date.now(), `socket#${socket.index} OPENED`);

        // Command ids are per connection in the Centrifugo protocol.
        const pendingSubscribes = new Map<number, string>();

        this.addEventListener('message', (event: any) => {
          recorder.onIncoming(socket, event?.data, pendingSubscribes);
        });
        this.addEventListener('close', (event: any) => {
          socket.closedAtMs = Date.now();
          recorder.note(socket.closedAtMs, `socket#${socket.index} CLOSED code=${describeValue(event?.code)}`);
        });

        const originalSend = this.send;
        this.send = function(data: any) {
          recorder.onOutgoing(socket, data, pendingSubscribes);
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


  public note(atMs: number, text: string): void {
    this.timeline.push({atMs, text});
  }


  public openSockets(): SocketRecord[] {
    return this.sockets.filter((socket) => socket.closedAtMs === undefined);
  }


  public hasSubscribeAck(channel: string): boolean {
    return this.subscribeReplies.some((reply) => reply.channel === channel && reply.error === undefined);
  }


  public renderTimeline(startMs: number): string {
    return [...this.timeline]
      .sort((left, right) => left.atMs - right.atMs)
      .map((event) => `  t+${event.atMs - startMs}ms ${event.text}`)
      .join('\n');
  }


  private onOutgoing(socket: SocketRecord, frame: unknown, pendingSubscribes: Map<number, string>): void {
    for(const command of this.codec.decodeCommands(frame)) {
      const subscribe = command?.subscribe;
      if(typeof command?.id !== 'number' || !subscribe?.channel) {
        continue;
      }

      const channel = String(subscribe.channel);
      pendingSubscribes.set(command.id, channel);
      const atMs = Date.now();
      this.note(
        atMs,
        `socket#${socket.index} SUBSCRIBE ${channel} recover=${describeValue(subscribe.recover === true)} ` +
        `offset=${describeValue(subscribe.offset)} epoch=${describeValue(subscribe.epoch)}`
      );
    }
  }


  private onIncoming(socket: SocketRecord, frame: unknown, pendingSubscribes: Map<number, string>): void {
    for(const reply of this.codec.decodeReplies(frame)) {
      if(typeof reply?.id === 'number') {
        const channel = pendingSubscribes.get(reply.id);
        if(channel === undefined) {
          continue;
        }

        pendingSubscribes.delete(reply.id);
        const atMs = Date.now();
        const body = reply.subscribe ?? {};
        const record: SubscribeReply = {
          atMs,
          socket: socket.index,
          channel,
          error: reply.error ? `${reply.error.code} ${reply.error.message}` : undefined,
          recoverable: body.recoverable === true,
          recovered: body.recovered === true,
          wasRecovering: body.was_recovering === true,
          offset: body.offset,
          epoch: body.epoch,
          publications: (body.publications ?? []).map((publication: any) => ({offset: publication?.offset}))
        };
        this.subscribeReplies.push(record);

        if(record.error !== undefined) {
          this.note(atMs, `socket#${socket.index} SUBSCRIBE-ERROR ${channel} ${record.error}`);
        } else {
          const recoveredOffsets = record.publications.map((publication) => describeValue(publication.offset));
          this.note(
            atMs,
            `socket#${socket.index} SUBSCRIBED ${channel} recoverable=${record.recoverable} ` +
            `recovered=${record.recovered} was_recovering=${record.wasRecovering} ` +
            `offset=${describeValue(record.offset)} epoch=${describeValue(record.epoch)} ` +
            `recovered_publications=[${recoveredOffsets.join(', ')}]`
          );
        }

        continue;
      }

      const push = reply?.push;
      if(push?.pub && push.channel) {
        const atMs = Date.now();
        const channel = String(push.channel);
        this.livePublications.push({atMs, socket: socket.index, channel, offset: push.pub.offset});
        this.note(atMs, `socket#${socket.index} PUBLICATION ${channel} offset=${describeValue(push.pub.offset)}`);
      }
    }
  }
}


/**
 * Records every container the realtime sink hands the updates manager (dispatch), and every
 * saveUpdate (application). The sink calls this.apiUpdatesManager.processUpdateMessage at call time,
 * so an instance wrapper installed after boot sees the push lane.
 */
function tapUpdatesManager(
  updatesManager: any,
  recorder: ResubscribeWireRecorder,
  dispatches: DispatchRecord[],
  applies: ApplyRecord[]
): void {
  const originalProcess = updatesManager.processUpdateMessage;
  updatesManager.processUpdateMessage = (updateMessage: any, options?: any) => {
    const atMs = Date.now();
    const predicates = predicatesOf(updateMessage);
    dispatches.push({atMs, predicates});
    recorder.note(atMs, `DISPATCH ${String(updateMessage?._)} [${predicates.join(', ')}]`);
    return originalProcess(updateMessage, options);
  };

  const originalSave = updatesManager.saveUpdate;
  updatesManager.saveUpdate = function(update: any, options?: any) {
    const atMs = Date.now();
    // updatePeerSettings names its user through `peer`, every other user-scoped update through `user_id`.
    const rawUserId = update?.user_id ?? update?.peer?.user_id;
    const userId = rawUserId === undefined || rawUserId === null ? undefined : String(rawUserId);
    const firstName: string | undefined = update?.first_name;
    applies.push({atMs, predicate: String(update?._), userId, firstName});
    recorder.note(
      atMs,
      `APPLY ${String(update?._)} user=${userId ?? '-'}` + (firstName === undefined ? '' : ` first_name=${firstName}`)
    );
    return originalSave.call(this, update, options);
  };
}


function predicatesOf(container: any): string[] {
  if(container?._ === 'updateShort') {
    return [String(container.update?._)];
  }

  const updates: any[] = Array.isArray(container?.updates) ? container.updates : [];
  return updates.map((update) => String(update?._));
}


async function importPeerUntilDiscoverable(stack: LiveStack, persona: Persona, peerKey: string): Promise<void> {
  // A just-registered persona becomes phone-discoverable only after the Users service materialises
  // its profile, so an import can come back empty for a while. An empty answer creates no contact
  // and therefore produces no update, so retrying it cannot inflate the apply counts.
  const deadline = Date.now() + importDeadlineMs;
  let lastFailure: unknown;
  for(;;) {
    try {
      const importedIds: any[] = await stack.managers.appUsersManager.importContacts([{
        phones: [persona.phone],
        first_name: persona.firstName,
        last_name: persona.lastName
      }]);
      if(importedIds.some((id) => String(id) === peerKey)) {
        return;
      }

      lastFailure = new Error('contacts.importContacts imported no contact for the peer');
    } catch(error) {
      lastFailure = error;
    }

    if(Date.now() > deadline) {
      throw new Error(
        `A could not import B's phone ${persona.phone} within ${importDeadlineMs}ms. Last failure: ` +
        (lastFailure instanceof Error ? lastFailure.message : String(lastFailure))
      );
    }

    await sleep(importRetryMs);
  }
}


describeLive('#757 a recovered resubscribe must not re-apply an update the client already applied (web client, user inbox)', () => {
  const rejections = new UnhandledRejectionGuard();
  const recorder = new ResubscribeWireRecorder();

  const personaA = ephemeralPersona('RecoveryReplayViewer');
  const personaB = ephemeralPersona('RecoveryReplayPeer');

  const dispatches: DispatchRecord[] = [];
  const applies: ApplyRecord[] = [];

  let scenarioStartMs = 0;
  let stack: LiveStack | undefined;
  let peer: MinimalRpcSession | undefined;
  let keyA = '';
  let keyB = '';
  let inboxA = '';
  let subscribedBeforeImport = false;
  let liveAppliesBeforeDrop: Record<string, number> = {};
  let firstDrop: {atMs: number, openCount: number} | undefined;
  let firstReconnect: SubscribeReply | undefined;
  let dispatchesAfterFirstReconnect = -1;
  let appliesAtFirstReconnect: Record<string, number> = {};
  let secondDrop: {atMs: number, openCount: number} | undefined;
  let profileName = '';
  let heldDuringProfileRpc = false;
  let secondReconnect: SubscribeReply | undefined;
  let getDifferenceCalls = 0;

  function countApplies(userKey: string, predicate: string): number {
    return applies.filter((apply) => apply.userId === userKey && apply.predicate === predicate).length;
  }

  function wireRecord(): string {
    return [
      `keyA=${keyA} keyB=${keyB} inbox=${inboxA}`,
      `dispatches=${dispatches.length} applies(B)=${JSON.stringify(
        liveUpdateTypes.map((type) => [type, countApplies(keyB, type)])
      )} getDifference calls=${getDifferenceCalls}`,
      'timeline:',
      recorder.renderTimeline(scenarioStartMs)
    ].join('\n');
  }

  function dropInboxSocket(): {atMs: number, openCount: number} {
    const atMs = Date.now();
    const open = recorder.openSockets();
    recorder.note(atMs, `DROP closing ${open.length} live socket(s) with code ${normalCloseCode}`);
    for(const socket of open) {
      socket.ws.close(normalCloseCode, '');
    }

    return {atMs, openCount: open.length};
  }

  function firstSubscribeReplyAfter(dropAtMs: number): SubscribeReply | undefined {
    return recorder.subscribeReplies.find((reply) => {
      return reply.channel === inboxA && reply.error === undefined && reply.atMs >= dropAtMs;
    });
  }

  beforeAll(async() => {
    rejections.install();
    scenarioStartMs = Date.now();

    stack = await bootLiveManagerStack(liveLane.gatewayOrigin, {
      afterEnvInstalled: () => recorder.install()
    });
    expect(
      stack.userIdAtBoot,
      'pristine-storage precondition: this scenario is defined over a boot with no persisted account'
    ).toBeUndefined();

    const {userId: signedInA} = await signInHeadless(stack, personaA);
    keyA = String(signedInA);
    inboxA = `user:${keyA}`;

    tapUpdatesManager(stack.managers.apiUpdatesManager, recorder, dispatches, applies);
    stack.managers.apiUpdatesManager.attach();

    peer = await openMinimalRpcSession(liveLane.gatewayOrigin, personaB);
    keyB = peer.userId;

    // Readiness: a live publication only reaches a socket whose user-inbox subscription is acked.
    subscribedBeforeImport = await waitUntil(
      () => recorder.hasSubscribeAck(inboxA) ? true : undefined,
      subscribeTimeoutMs,
      `A's realtime lane to subscribe to ${inboxA}`
    ).then(() => true, () => false);

    await importPeerUntilDiscoverable(stack, personaB, keyB);

    // Control: the live push must apply updateUser and/or updatePeerSettings for B on A's manager.
    await waitUntil(
      () => liveUpdateTypes.every((type) => countApplies(keyB, type) > 0) ? true : undefined,
      liveApplyTimeoutMs,
      'A to apply updateUser and updatePeerSettings for B live'
    ).catch((): undefined => undefined);
    liveAppliesBeforeDrop = Object.fromEntries(liveUpdateTypes.map((type) => [type, countApplies(keyB, type)]));

    // Fact 1: the network drop, then the SDK's own reconnect and resubscribe.
    firstDrop = dropInboxSocket();
    firstReconnect = await waitUntil(
      () => firstSubscribeReplyAfter(firstDrop!.atMs),
      reconnectTimeoutMs,
      `A's user inbox to resubscribe after the first drop`
    ).catch((): undefined => undefined);

    await sleep(recoveryQuietWindowMs);
    appliesAtFirstReconnect = Object.fromEntries(liveUpdateTypes.map((type) => [type, countApplies(keyB, type)]));
    dispatchesAfterFirstReconnect = firstReconnect ?
      dispatches.filter((dispatch) => dispatch.atMs >= firstReconnect!.atMs).length :
      -1;

    // Fact 2: the socket is down when B's profile changes. The SDK reconnects after
    // ReconnectJitterMaxMs (250 ms in development), so the RPC must return before then.
    profileName = `${personaB.firstName} renamed ${Date.now()}`;
    secondDrop = dropInboxSocket();
    const socketsBeforeRpc = recorder.sockets.length;
    await peer.invoke('account.updateProfile', {first_name: profileName});
    heldDuringProfileRpc = recorder.sockets.length === socketsBeforeRpc && recorder.openSockets().length === 0;

    secondReconnect = await waitUntil(
      () => firstSubscribeReplyAfter(secondDrop!.atMs),
      reconnectTimeoutMs,
      `A's user inbox to resubscribe after the second drop`
    ).catch((): undefined => undefined);
    await sleep(recoveryQuietWindowMs);

    getDifferenceCalls = stack.wire.records.filter((record) => record.method === 'updates.getDifference').length;

    console.log('[liveharness] #757 recovery evidence:', wireRecord());
  }, 600_000);

  afterAll(async() => {
    rejections.uninstall();
    recorder.uninstall();
    await stack?.dispose();
  }, 60_000);

  it('control: A subscribed to its user inbox, B was imported, exactly one live socket was dropped, and A applied updateUser or updatePeerSettings for B live', () => {
    expect(
      subscribedBeforeImport,
      `A never subscribed to ${inboxA} before the import, so no live push could be measured. ${wireRecord()}`
    ).toBe(true);
    expect(
      Object.values(liveAppliesBeforeDrop).some((count) => count > 0),
      `A's updates manager applied neither updateUser nor updatePeerSettings for B live before the drop, ` +
      `so the lane is misconfigured. ${wireRecord()}`
    ).toBe(true);
    expect(
      firstDrop?.openCount,
      `exactly one live socket must carry A's user inbox at the first drop. ${wireRecord()}`
    ).toBe(1);
  }, 60_000);

  it('fact 1 (RED if #757 reproduces): after a live apply and a drop, the recovered resubscribe does not apply updateUser or updatePeerSettings for B a second time', () => {
    expect(
      firstReconnect,
      `A's user inbox never resubscribed after the drop, so the replay could not be observed. ${wireRecord()}`
    ).toBeDefined();

    const recoveredCount = firstReconnect!.publications.length;
    expect(
      dispatchesAfterFirstReconnect,
      `positive control: the sink must process every recovered publication. The resubscribe reply carried ` +
      `${recoveredCount} publication(s) and the updates manager received ${dispatchesAfterFirstReconnect} ` +
      `dispatch(es) after it. ${wireRecord()}`
    ).toBe(recoveredCount);

    const totals = appliesAtFirstReconnect;
    expect(
      totals,
      `#757: after one live apply and one recovered resubscribe, A's updates manager applied B's pts-less ` +
      `updates more than once. Expected exactly one application of each type in total. ` +
      `Recovered publication offsets: [${firstReconnect!.publications.map((p) => JSON.stringify(p.offset)).join(', ')}]. ` +
      `Subscribe reply: recoverable=${firstReconnect!.recoverable} recovered=${firstReconnect!.recovered} ` +
      `was_recovering=${firstReconnect!.wasRecovering} offset=${describeValue(firstReconnect!.offset)} ` +
      `epoch=${describeValue(firstReconnect!.epoch)}. Live applies before the drop: ` +
      `${JSON.stringify(liveAppliesBeforeDrop)}. ${wireRecord()}`
    ).toEqual(Object.fromEntries(liveUpdateTypes.map((type) => [type, 1])));
  }, 60_000);

  it('fact 2: an update published while A\'s socket was down is applied exactly once after the resubscribe (not zero, not twice)', () => {
    expect(
      heldDuringProfileRpc,
      `the reconnect happened before B\'s profile RPC returned, so the update was not published while A\'s ` +
      `socket was down and this fact did not measure the gap. ${wireRecord()}`
    ).toBe(true);
    expect(
      secondReconnect,
      `A's user inbox never resubscribed after the second drop. ${wireRecord()}`
    ).toBeDefined();

    // Canon: a first-name change is announced by updateUserName (api/profile.md:496-497). The wire
    // delivers whatever the server sends, so the count covers the pts-less profile types for B.
    const profileApplies = applies.filter((apply) => {
      return apply.userId === keyB &&
        apply.atMs >= secondDrop!.atMs &&
        profileUpdateTypes.includes(apply.predicate);
    }).length;
    expect(
      profileApplies,
      `A must apply B's profile change (first_name "${profileName}", types ${profileUpdateTypes.join('/')}) ` +
      `exactly once after the resubscribe. Applies after the drop: ${JSON.stringify(applies.filter((apply) => apply.userId === keyB && apply.atMs >= secondDrop!.atMs).map((apply) => apply.predicate))}. ` +
      `resubscribe. Recovered publications on the second resubscribe: ` +
      `[${secondReconnect!.publications.map((p) => JSON.stringify(p.offset)).join(', ')}]. ${wireRecord()}`
    ).toBe(1);
  }, 60_000);

  it('standing invariants: clean wire and zero unhandled rejections across the scenario', () => {
    stack!.wire.assertClean('recovered resubscribe scenario');
    rejections.assertNone('the recovered resubscribe scenario');
  }, 60_000);
});
