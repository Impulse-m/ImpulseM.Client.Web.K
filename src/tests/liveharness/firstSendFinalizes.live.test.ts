import {expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';


/*
 * The first message of a conversation and its clock — issue #510, and what this scenario
 * ELIMINATED rather than proved.
 *
 * WHAT THE CEO SAW. "это было первое сообщение другому аккаунту, и к нему не пришло
 * подтверждение. Часики так и остались, хотя я продолжил писать и второй аккаунт получил
 * сообщение." The message WAS delivered. Only the sender's own bubble never advanced from the
 * clock to the check, and it never did: the state is terminal, not slow.
 *
 * THE MECHANISM IS KNOWN, read out of the client rather than inferred. Since #482 the server
 * answers messages.sendMessage to a user peer with updateShortSentMessage, which carries no
 * users vector. The client no longer receives an updateNewMessage for its own send — it
 * SYNTHESISES one (appMessagesManager.ts:2325-2356) and applies it locally. processUpdate then
 * refuses it before any pts logic runs (apiUpdatesManager.ts:549-555):
 *
 *     toPeerId.isUser() && !this.appUsersManager.hasUser(toPeerId) && (reason = 'toPeer User')
 *       -> log.warn('not enough data for message update', ...)
 *          forceGetDifference();
 *          return false;
 *
 * `return false` drops it, finalizePendingMessage is never reached, pFlags.is_outgoing is never
 * deleted. hasUser is called with no allowMin, so a MIN record does not satisfy it and neither
 * does an absent one. This is upstream tweb, byte for byte at d35c2f4a6.
 *
 * WHAT IS NOT KNOWN is how a real client arrives at that state, and this scenario was written
 * to prove one candidate and PASSED ON ITS FIRST RUN — so the candidate is eliminated, not
 * confirmed. The candidate was: an account that met its correspondent ONLY through the realtime
 * lane holds a reduced (min) record of them, because both the push lane and the getDifference
 * lane populate users[] with UserMapper.MapReduced (UpdateContainerPeerHydrator:70, :104, reached
 * from UpdateDispatcher.cs:990 and UpdatesService.cs:479). If that were the state at send time,
 * hasUser would be false and the send could never finalize.
 *
 * It finalizes. Whatever the realtime lane leaves this client holding, it is enough. The
 * scenario is therefore kept as the guard for that fact rather than deleted: it is the control
 * that stops the next investigation from re-walking this path, and it is a real regression guard
 * — if a future change to either lane DOES leave the record unusable, the first send of every
 * conversation starts keeping its clock and this goes red.
 *
 * The reproduction #510 still needs is a client that reaches a brand-new correspondent through
 * a lane this scenario does not exercise — a search hit, a contact import, a deep link — or a
 * pts gap whose repair does not repair. That is named on the issue.
 */
const signInTimeoutMs = 90_000;
const inboundTimeoutMs = 60_000;
const finalizeTimeoutMs = 45_000;


describeLive('#510 the first message of a conversation must finalize, not keep its clock for ever', () => {
  it('a reply to a correspondent known only from the realtime lane is acknowledged to its own sender', async() => {
    const rejections = new UnhandledRejectionGuard();
    rejections.install();

    let stack: LiveStack | undefined;

    try {
      const replierPersona = ephemeralPersona('FirstSendReplier');
      const openerPersona = ephemeralPersona('FirstSendOpener');

      stack = await bootLiveManagerStack(liveLane.gatewayOrigin);
      const {userId: replierId} = await signInHeadless(stack, replierPersona);
      const replierKey = String(replierId);

      // The running client is attached to the update lanes, exactly like the browser after boot.
      stack.managers.apiUpdatesManager.attach();

      const acked: any[] = [];
      stack.managers.rootScope.addEventListener('message_sent', (payload: any) => {
        acked.push(payload);
      });

      const opener: MinimalRpcSession = await openMinimalRpcSession(liveLane.gatewayOrigin, openerPersona);

      // The opener resolves the replier and writes FIRST. It is a raw RPC session, so nothing it
      // does can populate the replier's peer database — which is the point: after this send the
      // replier knows the opener only from what the realtime lane handed it.
      const resolved = await opener.invoke('contacts.resolvePhone', {phone: replierPersona.phone});
      const replierAsSeenByOpener = (resolved?.users ?? []).find((user: any) => String(user?.id) === replierKey);
      expect(
        Boolean(replierAsSeenByOpener),
        'the opener must be able to resolve the replier by phone, or there is no conversation to ' +
        'open and this scenario measures nothing'
      ).toBe(true);

      const openingText = `first-send-opening-${Date.now()}`;
      await opener.invoke('messages.sendMessage', {
        peer: {
          _: 'inputPeerUser',
          user_id: replierAsSeenByOpener.id,
          access_hash: replierAsSeenByOpener.access_hash
        },
        message: openingText,
        random_id: String(Date.now()) + String(Math.floor(Math.random() * 1e9))
      });

      // The replier's own record of the opener, as the realtime lane left it. NO PULL is performed
      // here: messages.getDialogs or users.getUsers at this point would hand over a full user and
      // make the send below succeed for a reason no real first message enjoys.
      const openerPeerId = await waitUntil(
        () => {
          const id = stack!.managers.appPeersManager.getPeerId({user_id: opener.userId});
          const user = stack!.managers.appUsersManager.getUser?.(id);
          return user ? id : undefined;
        },
        inboundTimeoutMs,
        'the replier learning the opener at all — the realtime lane is the only source it is ' +
        'allowed to learn from here, so a timeout means the inbound hop never reached the managers'
      );

      const replyText = `first-send-reply-${Date.now()}`;
      await stack.managers.appMessagesManager.sendText({
        peerId: openerPeerId,
        text: replyText
      });

      // THE DEFECT. message_sent is dispatched by finalizePendingMessage, so its absence IS the
      // clock that never becomes a check.
      const replyAck = await waitUntil(
        () => acked.find((payload) => payload?.message?.peerId === openerPeerId),
        finalizeTimeoutMs,
        'the replier\'s own acknowledgement of its first message (message_sent for that peer). ' +
        'Its absence is the reported defect exactly: the server has the message and the sender ' +
        'was never told, so the bubble keeps its clock for ever (#510)'
      );

      expect(
        stack.helpers.getServerMessageId(replyAck.mid) > 0,
        'finalize ran, so the acked mid must map to a server message id. A temp mid here means ' +
        'the pending message was never rebound and the bubble is still showing a clock over a ' +
        'message the server already stored'
      ).toBe(true);

      // The control, and it must stay green throughout: the message really was delivered. Without
      // it a red above reads as "the send failed", which is the one thing it is not.
      const openerHistory = await opener.invoke('messages.getHistory', {
        peer: {
          _: 'inputPeerUser',
          user_id: replierAsSeenByOpener.id,
          access_hash: replierAsSeenByOpener.access_hash
        },
        limit: 20
      });
      expect(
        (openerHistory?.messages ?? []).some((message: any) => message?.message === replyText),
        'the opener must hold the reply. This is what distinguishes the reported defect from a ' +
        'failed send: the recipient has it, and only the sender was left uninformed'
      ).toBe(true);
    } finally {
      await stack?.dispose();
      rejections.uninstall();
      rejections.assertNone('#510 first-send finalize scenario');
    }
  }, signInTimeoutMs + inboundTimeoutMs + finalizeTimeoutMs + 60_000);
});
