import {createHash, randomBytes} from 'crypto';

import {afterAll, beforeAll, expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveMultiAccountStack, MultiAccountLiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {RealtimeWireObserver} from './realtimeWire';
import {waitUntil} from './wait';


/*
 * B1 LiveKit contract: the coordinates the backend hands out are exactly what the client's media layer
 * reads, end to end through the real manager stack.
 *
 *   group call   phone.joinGroupCall {ssrc} -> updateGroupCallConnection.params is a LiveKit document for
 *                room g.{callId}, its token is issued for the participant identity the client derives from
 *                the same peer and source, and the presentation join gets the `.p` identity of its own source.
 *   1:1 call     requestCall -> acceptCall -> confirmCall: the caller's confirm answer and the callee's
 *                updatePhoneCall push both carry coordinates for room p.{callId} issued to u{userId}.
 *
 * Nothing is mocked: the parse and identity codecs under test are the ones the call code runs, the
 * token's `sub` is read off the real JWT.
 */
const bootTimeoutMs = 120_000;
const pushTimeoutMs = 60_000;
const SIGNED_SOURCE_BIT = 0x80000000;


type TokenClaims = {sub?: string, video?: {room?: string, canPublish?: boolean, canPublishSources?: string[]}, exp?: number};


// The crypto worker that answers generate-dh / compute-dh-key in the browser does not exist in this
// headless graph, so the Diffie-Hellman the call needs is done here, by the book: the same arithmetic
// (g^a mod p, a 256-byte left-padded key, the SHA-1 fingerprint) the client's worker runs.
const KEY_BYTES = 256;

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex'));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = BigInt(1);
  let current = base % modulus;
  let remaining = exponent;
  while(remaining > BigInt(0)) {
    if(remaining & BigInt(1)) {
      result = result * current % modulus;
    }

    current = current * current % modulus;
    remaining >>= BigInt(1);
  }

  return result;
}

type DhHalf = {secret: bigint, publicValue: Uint8Array, publicHash: Uint8Array};

async function makeDhHalf(managers: any): Promise<DhHalf & {p: bigint}> {
  const config: any = await managers.apiManager.invokeApi('messages.getDhConfig', {version: 0, random_length: KEY_BYTES});
  const p: bigint = bytesToBigInt(config.p);
  const secret: bigint = bytesToBigInt(randomBytes(KEY_BYTES)) % (p - BigInt(4)) + BigInt(2);
  const publicValue: Uint8Array = bigIntToBytes(modPow(BigInt(config.g), secret, p), KEY_BYTES);
  return {secret, publicValue, publicHash: Uint8Array.from(createHash('sha256').update(publicValue).digest()), p};
}

function keyFingerprint(peerPublic: Uint8Array, secret: bigint, p: bigint): string {
  const key: Uint8Array = bigIntToBytes(modPow(bytesToBigInt(peerPublic), secret, p), KEY_BYTES);
  const tail: Uint8Array = Uint8Array.from(createHash('sha1').update(key).digest()).slice(-8).reverse();
  const unsigned: bigint = bytesToBigInt(tail);
  return (unsigned >= BigInt(1) << BigInt(63) ? unsigned - (BigInt(1) << BigInt(64)) : unsigned).toString(10);
}


function decodeToken(token: string): TokenClaims {
  const payload: string = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as TokenClaims;
}

function tapPhoneCallUpdates(updatesManager: any, captured: any[]): void {
  const original = updatesManager.processUpdateMessage;
  updatesManager.processUpdateMessage = (updateMessage: any, options?: any) => {
    const updates: any[] = updateMessage?._ === 'updateShort' ?
      [updateMessage.update] :
      (Array.isArray(updateMessage?.updates) ? updateMessage.updates : []);
    for(const update of updates) {
      if(update?._ === 'updatePhoneCall') {
        captured.push(update.phone_call);
      }
    }

    return original(updateMessage, options);
  };
}


describeLive('B1 LiveKit contract: group and 1:1 call coordinates parse and name the right identity', () => {
  const rejections = new UnhandledRejectionGuard();
  const wire = new RealtimeWireObserver();
  const personaA = ephemeralPersona('LiveKitContractA');
  const personaB = ephemeralPersona('LiveKitContractB');
  let stack: MultiAccountLiveStack | undefined;
  let userIdA: UserId;
  let userIdB: UserId;
  const callerUpdates: any[] = [];
  const calleeUpdates: any[] = [];

  beforeAll(async() => {
    rejections.install();
    stack = await bootLiveMultiAccountStack(liveLane.gatewayOrigin, [1, 2], {
      environment: {IS_CALL_SUPPORTED: true, IS_GROUP_CALL_SUPPORTED: true},
      afterEnvInstalled: () => wire.install()
    });
    userIdA = (await signInHeadless(stack.slot(1), personaA)).userId;
    userIdB = (await signInHeadless(stack.slot(2), personaB)).userId;

    tapPhoneCallUpdates(stack.slot(1).managers.apiUpdatesManager, callerUpdates);
    tapPhoneCallUpdates(stack.slot(2).managers.apiUpdatesManager, calleeUpdates);
    stack.slot(1).managers.apiUpdatesManager.attach();
    stack.slot(2).managers.apiUpdatesManager.attach();

    // A one-shot push only reaches a socket whose subscription is already acked: wait for both inboxes.
    for(const userId of [userIdA, userIdB]) {
      await waitUntil(
        () => wire.hasSubscribeAck(`user:${userId}`) ? true : undefined,
        pushTimeoutMs,
        `the realtime lane of user ${userId} to subscribe to its inbox`
      );
    }
  }, bootTimeoutMs);

  afterAll(async() => {
    wire.uninstall();
    await stack?.dispose();
    rejections.uninstall();
    rejections.assertNone('LiveKit contract');
  });

  it('group call: the join answer is a LiveKit document for g.{id} whose token names the main identity, and the presentation join names the `.p` one', async() => {
    const {parseLiveKitJoinParams, groupCallRoomName} = await import('@lib/calls/livekit/liveKitJoinParams');
    const {formatGroupCallIdentity} = await import('@lib/calls/livekit/liveKitIdentity');
    const {toImpulseMSource} = await import('@lib/calls/utils');
    const managers = stack!.slot(1).managers;

    const {chatId} = await managers.appChatsManager.createChat(`LiveKitContract-${Date.now()}`, []);
    const groupCall = await managers.appGroupCallsManager.createGroupCall(chatId);
    const callId = groupCall.id;
    const input = {_: 'inputGroupCall', id: callId, access_hash: groupCall.access_hash};
    const mainSsrc: number = 0x9E3779B1; // above 2^31 on purpose: the unsigned/signed boundary is the contract
    const presentationSsrc: number = 123456789;
    expect(mainSsrc & SIGNED_SOURCE_BIT).not.toBe(0);

    let mainSource: number | undefined;
    try {
      const joined = await managers.appGroupCallsManager.joinGroupCall(
        callId,
        {_: 'dataJSON', data: JSON.stringify({ssrc: mainSsrc})},
        {type: 'main', isMuted: true, joinVideo: false}
      );
      mainSource = toImpulseMSource(mainSsrc);

      const room: string = groupCallRoomName(callId);
      const coordinates = parseLiveKitJoinParams({params: joined.params, expectedRoom: room});
      expect(coordinates.room).toBe(room);
      expect(coordinates.url).toMatch(/^wss?:\/\//);
      const claims = decodeToken(coordinates.token);
      // a person joins a group call as themself: the identity is the user's, not the chat's
      expect(claims.sub).toBe(formatGroupCallIdentity({
        kind: 'user',
        peerId: userIdA as unknown as PeerId,
        source: mainSource,
        isPresentation: false
      }));
      expect(claims.video?.room).toBe(room);
      expect(typeof claims.exp).toBe('number');

      const participants = await managers.appGroupCallsManager.getCachedParticipants(callId);
      const selfRow: any = [...participants.values()].find((participant: any) => participant.pFlags.self);
      expect(selfRow?.source).toBe(mainSource);

      const presentation = await managers.appGroupCallsManager.joinGroupCall(
        callId,
        {_: 'dataJSON', data: JSON.stringify({ssrc: presentationSsrc})},
        {type: 'presentation'}
      );
      expect(presentation.pFlags.presentation).toBe(true);
      const presentationCoordinates = parseLiveKitJoinParams({params: presentation.params, expectedRoom: room});
      expect(decodeToken(presentationCoordinates.token).sub).toBe(formatGroupCallIdentity({
        kind: 'user',
        peerId: userIdA as unknown as PeerId,
        source: toImpulseMSource(presentationSsrc),
        isPresentation: true
      }));
    } finally {
      try {
        await managers.appGroupCallsManager.leaveGroupCallPresentation(input);
      } catch{
        // the presentation may never have been accepted
      }

      await managers.appGroupCallsManager.leaveGroupCall(input, mainSource ?? 0).catch((): undefined => undefined);
      await managers.appGroupCallsManager.discardGroupCall(input).catch((): undefined => undefined);
    }
  }, pushTimeoutMs);

  it('1:1 call: confirmCall answers the caller, and the callee push carries coordinates for p.{id} issued to each side', async() => {
    const {parseLiveKitJoinParams, phoneCallRoomName} = await import('@lib/calls/livekit/liveKitJoinParams');
    const {formatPhoneCallIdentity} = await import('@lib/calls/livekit/liveKitIdentity');
    const getCallProtocol = (await import('@lib/calls/livekit/getCallProtocol')).default;
    const caller = stack!.slot(1).managers;
    const callee = stack!.slot(2).managers;
    await caller.appUsersManager.resolvePhone(personaB.phone);
    const protocol = getCallProtocol();
    const callerHalf = await makeDhHalf(caller);
    const waiting = await caller.appCallsManager.requestCall(userIdB, protocol, callerHalf.publicHash, false);
    const callId = waiting.id;

    try {
      await waitUntil(() => calleeUpdates.find((call) => call._ === 'phoneCallRequested' && String(call.id) === String(callId)), pushTimeoutMs, 'the callee to be rung');
      const calleeHalf = await makeDhHalf(callee);
      await callee.appCallsManager.acceptCall(callId, protocol, calleeHalf.publicValue, false);

      const accepted: any = await waitUntil(
        () => callerUpdates.find((call) => call._ === 'phoneCallAccepted' && String(call.id) === String(callId)),
        pushTimeoutMs,
        'phoneCallAccepted on the caller'
      );
      const fingerprint: string = keyFingerprint(accepted.g_b, callerHalf.secret, callerHalf.p);
      const confirmed: any = await caller.appCallsManager.confirmCall(callId, protocol, callerHalf.publicValue, fingerprint, false);
      expect(confirmed._).toBe('phoneCall');

      const room: string = phoneCallRoomName(callId);
      const callerCoordinates = parseLiveKitJoinParams({params: confirmed.custom_parameters, expectedRoom: room});
      expect(decodeToken(callerCoordinates.token).sub).toBe(formatPhoneCallIdentity(userIdA));
      expect(decodeToken(callerCoordinates.token).video?.room).toBe(room);

      const calleePush: any = await waitUntil(
        () => calleeUpdates.find((call) => call._ === 'phoneCall' && String(call.id) === String(callId)),
        pushTimeoutMs,
        'the callee updatePhoneCall carrying the coordinates'
      );
      const calleeCoordinates = parseLiveKitJoinParams({params: calleePush.custom_parameters, expectedRoom: room});
      expect(decodeToken(calleeCoordinates.token).sub).toBe(formatPhoneCallIdentity(userIdB));
      expect(calleeCoordinates.url).toBe(callerCoordinates.url);
      expect(calleeCoordinates.token).not.toBe(callerCoordinates.token);
    } finally {
      await caller.appCallsManager.discardCall(callId, 0, {_: 'phoneCallDiscardReasonHangup'}, false).catch((): undefined => undefined);
    }
  }, pushTimeoutMs * 2);
});
