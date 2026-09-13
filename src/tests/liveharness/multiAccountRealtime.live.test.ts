import {randomInt} from 'crypto';

import {afterAll, beforeAll, expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveMultiAccountStack, MultiAccountLiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {RealtimeWireObserver} from './realtimeWire';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';


/*
 * B1 multi-account realtime — two accounts signed into ONE browser (one SharedWorker), both must
 * keep a live push socket.
 *
 * REPORTED BY THE CEO: two accounts open in one browser, realtime updates break for one of them.
 *
 * ROOT CAUSE. #436 moved every per-account credential off a module singleton and into a map keyed
 * by account number (grpc/transport.ts credentialsByAccount, session.ts gatesByAccount). The
 * realtime CONNECTION lifecycle was the one piece that stayed a SharedWorker-wide singleton: one
 * `connection`/`activeUserId`, and a `startImpulseRealtime` that, on seeing a different user, called
 * `stopImpulseRealtime()` and tore the existing socket down (realtime.ts, pre-fix :105-107). So
 * bringing up account B disconnected account A's `user:{id}` socket — only the account brought up
 * LAST held a live subscription, and the other went silent with no incoming messages.
 *
 * WHY ONE MANAGER STACK, TWO SLOTS. The real SharedWorker hosts all four account slots at once
 * (createManagers builds one manager set per slot). bootLiveMultiAccountStack is that: slot 1 and
 * slot 2 in ONE module graph, each signed in through the real client auth path
 * (signInHeadless -> apiManager.setUser -> setUserAuth -> startImpulseRealtime for THAT slot).
 *
 * WHY A THIRD PARTY DRIVES THE INBOUND. A self-send is processed locally off the sendMessage RPC
 * response, so it would reach the sender's own updates manager whether or not the push socket
 * lived — it cannot tell a live socket from a dead one. A message from a THIRD persona can only
 * reach account A through A's own `user:{id}` push socket, so it is the clean discriminator: on the
 * singleton, A's socket is gone the moment B comes up, and C's message to A is never seen.
 *
 * THE RED. Account A signs in FIRST (slot 1), account B SECOND (slot 2). On the current singleton,
 * B's bring-up tears A down, so:
 *   fact A (RED today):   A's socket never carries C's message, and A's updates manager never
 *                         receives it — the earlier account is the one that goes silent.
 *   fact B (GREEN today): B is the survivor, so its inbound arrives even on the singleton — the
 *                         localization control that says the red pattern is "A torn down", not
 *                         "nothing was ever wired".
 * Both facts are asserted on the wire observer PER ACCOUNT (publicationsOn(user:A) vs user:B) and
 * on each slot's OWN updates manager — never on a single global.
 */
const subscribeTimeoutMs = 60_000;
const deliveryTimeoutMs = 60_000;

type InboundCapture = {
  predicate: string,
  text: string | undefined,
  atMs: number
};


/**
 * Records every inbound message update at the ENTRY of a slot's updates manager — the same seam
 * presenceProbe taps. A capture here means "the push reached THIS account's manager", which is
 * exactly what the singleton breaks for the torn-down account.
 */
function tapInboundMessages(updatesManager: any, captures: InboundCapture[]): void {
  const original = updatesManager.processUpdateMessage;
  updatesManager.processUpdateMessage = (updateMessage: any, options?: any) => {
    const updates = updateMessage?._ === 'updateShort' ?
      [updateMessage.update] :
      (Array.isArray(updateMessage?.updates) ? updateMessage.updates : []);
    for(const update of updates) {
      if(update?._ === 'updateNewMessage' || update?._ === 'updateNewChannelMessage' || update?._ === 'updateShortMessage') {
        const text = typeof update.message === 'string' ? update.message : update.message?.message;
        captures.push({predicate: update._, text, atMs: Date.now()});
      }
    }

    return original(updateMessage, options);
  };
}


async function sendTextTo(
  session: MinimalRpcSession,
  target: {id: any, accessHash: any},
  text: string
): Promise<void> {
  await session.invoke('messages.sendMessage', {
    peer: {
      _: 'inputPeerUser',
      user_id: target.id,
      access_hash: target.accessHash
    },
    message: text,
    // int64; buildProtoInit converts via BigInt(), so a decimal string is enough.
    random_id: String(BigInt(Date.now()) * BigInt(100_000) + BigInt(randomInt(100_000)))
  });
}


async function resolveTarget(session: MinimalRpcSession, phone: string, userKey: string): Promise<{id: any, accessHash: any}> {
  // A just-signed-up persona becomes phone-discoverable only after the Users service materialises
  // its profile off the Kafka auth event — at-least-once, eventually consistent. Retry a bounded
  // while (the same propagation window personaSession.openDialogWithPhone allows), then surface the
  // last failure with context rather than a bare throw.
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  for(;;) {
    try {
      const resolved = await session.invoke('contacts.resolvePhone', {phone});
      const user = (resolved?.users ?? []).find((candidate: any) => String(candidate?.id) === userKey);
      if(user) {
        return {id: user.id, accessHash: user.access_hash};
      }

      lastError = new Error(`contacts.resolvePhone returned no user ${userKey}`);
    } catch(error) {
      lastError = error;
    }

    if(Date.now() > deadline) {
      throw new Error(
        `contacts.resolvePhone could not resolve ${userKey} (${phone}) within 45s — the sender ` +
        `cannot address the account. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}


describeLive('B1 multi-account realtime: two accounts in one browser both keep a live push socket — bringing up the second must NOT tear down the first (CEO multi-account report)', () => {
  const rejections = new UnhandledRejectionGuard();
  const wire = new RealtimeWireObserver();

  const personaA = ephemeralPersona('MultiAccountA');
  const personaB = ephemeralPersona('MultiAccountB');
  const personaC = ephemeralPersona('MultiAccountSender');

  let stack: MultiAccountLiveStack | undefined;
  let sender: MinimalRpcSession | undefined;
  let keyA = '';
  let keyB = '';
  let inboxA = '';
  let inboxB = '';
  let markerA = '';
  let markerB = '';
  let sendStartMs = 0;
  const inboundA: InboundCapture[] = [];
  const inboundB: InboundCapture[] = [];

  beforeAll(async() => {
    rejections.install();

    // ONE manager stack, slots 1 AND 2 — the harness form of one SharedWorker hosting two accounts.
    // The wire observer rides the boot hook so it wraps the single globalThis.WebSocket both slots
    // open their sockets through.
    stack = await bootLiveMultiAccountStack(liveLane.gatewayOrigin, [1, 2], {
      afterEnvInstalled: () => wire.install()
    });

    const slotA = stack.slot(1);
    const slotB = stack.slot(2);
    expect(
      slotA.userIdAtBoot,
      'pristine-storage precondition: slot 1 must boot with no persisted account (each vitest file ' +
      'runs in its own forked process). A userId here means state leaked in and the scenario would ' +
      'measure an already-signed-in account instead of a fresh two-account sign-in'
    ).toBeUndefined();
    expect(
      slotB.userIdAtBoot,
      'pristine-storage precondition: slot 2 must boot with no persisted account'
    ).toBeUndefined();

    // Account A into slot 1 FIRST, account B into slot 2 SECOND — order matters: the singleton
    // tears down whichever came first when the second arrives.
    const {userId: signedInA} = await signInHeadless(slotA, personaA);
    keyA = String(signedInA);
    inboxA = `user:${keyA}`;

    const {userId: signedInB} = await signInHeadless(slotB, personaB);
    keyB = String(signedInB);
    inboxB = `user:${keyB}`;

    expect(
      keyA,
      'the two accounts must be distinct identities — a shared identity would make "one socket per ' +
      'account" untestable'
    ).not.toBe(keyB);

    tapInboundMessages(slotA.managers.apiUpdatesManager, inboundA);
    tapInboundMessages(slotB.managers.apiUpdatesManager, inboundB);
    slotA.managers.apiUpdatesManager.attach();
    slotB.managers.apiUpdatesManager.attach();

    // The third party who will write to both accounts.
    sender = await openMinimalRpcSession(liveLane.gatewayOrigin, personaC);
    const targetA = await resolveTarget(sender, personaA.phone, keyA);
    const targetB = await resolveTarget(sender, personaB.phone, keyB);

    // Readiness: a one-shot fan-out only reaches a socket whose subscription is already acked.
    // BOTH acks are the readiness sign; on the singleton A's ack never comes (B tore it down), so
    // this wait is bounded and CAUGHT — the facts below pass the verdict on the collected evidence.
    await waitUntil(
      () => wire.hasSubscribeAck(inboxA) ? true : undefined,
      subscribeTimeoutMs,
      `account A's realtime lane to subscribe to its user-inbox channel (${inboxA})`
    ).catch((): undefined => undefined);
    await waitUntil(
      () => wire.hasSubscribeAck(inboxB) ? true : undefined,
      subscribeTimeoutMs,
      `account B's realtime lane to subscribe to its user-inbox channel (${inboxB})`
    ).catch((): undefined => undefined);

    markerA = `to-account-a-${Date.now()}`;
    markerB = `to-account-b-${Date.now()}`;
    sendStartMs = Date.now();
    await sendTextTo(sender, targetA, markerA);
    await sendTextTo(sender, targetB, markerB);

    // Bounded, caught: collect whatever arrives; each fact renders its own verdict.
    await waitUntil(
      () => {
        const gotA = wire.publicationsOn(inboxA).some((record) => record.receivedAtMs >= sendStartMs);
        const gotB = wire.publicationsOn(inboxB).some((record) => record.receivedAtMs >= sendStartMs);
        return gotA && gotB ? true : undefined;
      },
      deliveryTimeoutMs,
      'both accounts to receive their inbound publication on their own websocket'
    ).catch((): undefined => undefined);

    console.log('[liveharness] multi-account realtime evidence:', JSON.stringify({
      keyA,
      keyB,
      wireA: wire.describeWire(inboxA),
      wireB: wire.describeWire(inboxB),
      inboundA,
      inboundB,
      closes: wire.closes
    }));
  }, 300_000);

  afterAll(async() => {
    rejections.uninstall();
    wire.uninstall();
    await stack?.dispose();
  }, 60_000);

  it('control: BOTH accounts opened a socket and got a subscribe ack on their own user-inbox channel — neither bring-up left the other unsubscribed', () => {
    expect(
      wire.socketsOpened,
      'at least two realtime sockets must have opened — one per account; ' +
      `wireA: ${wire.describeWire(inboxA)}; wireB: ${wire.describeWire(inboxB)}`
    ).toBeGreaterThanOrEqual(2);
    expect(
      wire.hasSubscribeAck(inboxB),
      `account B (brought up SECOND) never subscribed to ${inboxB} — the survivor itself is dark, so ` +
      `the whole lane is misconfigured, not just the torn-down account. Wire: ${wire.describeWire(inboxB)}`
    ).toBe(true);
    expect(
      wire.hasSubscribeAck(inboxA),
      `account A (brought up FIRST) never got a live subscribe ack on ${inboxA}. On the singleton ` +
      'realtime lane, bringing up account B calls stopImpulseRealtime() and disconnects account A\'s ' +
      'socket before it can serve anything (realtime.ts pre-fix :105-107). Each account must keep its ' +
      `OWN socket. Wire: ${wire.describeWire(inboxA)}`
    ).toBe(true);
  }, 60_000);

  it('fact A (RED on the singleton): account A — signed in FIRST — receives the message a third party sent it, on its own socket AND in its own updates manager', () => {
    const publications = wire.publicationsOn(inboxA).filter((record) => record.receivedAtMs >= sendStartMs);
    expect(
      publications.length,
      `account A's own websocket carried NO publication on ${inboxA} after a third party wrote to it — ` +
      'in the real client this is the CEO\'s report: the first of two accounts in the browser stops ' +
      'receiving anything live, because bringing up the second account tore down the first account\'s ' +
      `socket (the singleton stopImpulseRealtime). Wire A: ${wire.describeWire(inboxA)}; ` +
      `closes: ${JSON.stringify(wire.closes)}`
    ).toBeGreaterThan(0);
    expect(
      inboundA.some((capture) => capture.text === markerA && capture.atMs >= sendStartMs),
      'account A\'s OWN updates manager never received the inbound message: even if a publication ' +
      'reached a socket, the singleton routes every publication through one shared sink (the last ' +
      'account to call setRealtimeSink), so account A\'s manager is never handed its own push. Each ' +
      `account\'s socket must route to that account\'s own updates manager. Captured on A: ` +
      `${JSON.stringify(inboundA)}`
    ).toBe(true);
  }, 60_000);

  it('fact B (control): account B — signed in SECOND, the survivor — receives its own inbound; proves the red on A is "first account torn down", not "nothing wired"', () => {
    const publications = wire.publicationsOn(inboxB).filter((record) => record.receivedAtMs >= sendStartMs);
    expect(
      publications.length,
      `account B's own websocket carried no publication on ${inboxB} after a third party wrote to it — ` +
      `if even the survivor is silent the backend fan-out is the suspect, not the client. Wire B: ${wire.describeWire(inboxB)}`
    ).toBeGreaterThan(0);
    expect(
      inboundB.some((capture) => capture.text === markerB && capture.atMs >= sendStartMs),
      `account B's own updates manager never received its inbound message. Captured on B: ${JSON.stringify(inboundB)}`
    ).toBe(true);
  }, 60_000);

  it('both sockets stay live: no account\'s realtime socket was closed by the other account\'s bring-up', () => {
    // On the singleton, bringing up B disconnects A — a close frame on A's socket is the direct
    // signature. A per-account lifecycle opens two independent sockets and closes neither.
    expect(
      wire.closes.length,
      'a realtime socket was closed during the two sign-ins — on the singleton lane this is account ' +
      'A\'s socket being torn down by account B\'s bring-up (stopImpulseRealtime disconnects the one ' +
      `shared connection). Closes: ${JSON.stringify(wire.closes)}; ` +
      `wireA: ${wire.describeWire(inboxA)}; wireB: ${wire.describeWire(inboxB)}`
    ).toBe(0);
  }, 60_000);

  it('standing invariant: no unhandled rejections across the two-account bring-up', () => {
    rejections.assertNone('the multi-account realtime scenario');
  }, 60_000);
});
