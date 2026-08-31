import {readFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import {expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {isServerShapedId, UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';


/*
 * B1 seed scenario (issue #92 step 1) — the reproduction of the live loss that passed green
 * through every existing lane: the sender records a round video note, the server acknowledges
 * it (finalize runs, the message gets its final mid), the client reloads — and the reloaded
 * client renders a hole where the note was, even though the note exists in Cassandra on both
 * partitions and in server search.
 *
 * This scenario drives the REAL manager stack end to end: the recorder's exact sendFile call
 * (src/components/chat/recording/chatRecording.ts:311-325) with a real VP8+Opus WebM, a real
 * upload through apiFileManager, a real messages.sendMedia ack, then a page-refresh-faithful
 * reload (fresh module graph over the same fake-indexeddb state) and the real
 * history/difference flow of the fresh stack.
 *
 * Expected RED at manager level while the loss is open. If it comes out GREEN headlessly,
 * that is a finding too: it localizes the loss ABOVE the managers (main-thread bubbles /
 * IDB-main mirror) — report exactly that, do not force a red.
 */
const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixtureBytes(name: string): ArrayBuffer {
  const buffer = readFileSync(join(fixturesDirectory, name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function waitUntil<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string
): Promise<T> {
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      const value = probe();
      if(value !== undefined) {
        resolve(value);
        return;
      }

      if(Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}


describeLive('B1 seed: a server-acked round video note must survive a client reload', () => {
  it('the reloaded manager stack finds every acked message — the round note above all — with its final mid and a server-shaped document id', async() => {
    const rejections = new UnhandledRejectionGuard();
    rejections.install();

    let stackA: LiveStack | undefined;
    let stackB: LiveStack | undefined;

    try {
      // ---- act 1: the sender's live session ----
      stackA = await bootLiveManagerStack(liveLane.gatewayOrigin);
      const persona = ephemeralPersona('RoundNoteReloadSender');
      const {userId} = await signInHeadless(stackA, persona);

      // Every message the server acknowledges to this sender lands here via the manager's own
      // finalize path (finalizePendingMessageCallbacks dispatches message_sent).
      const ackedMessages: any[] = [];
      stackA.managers.rootScope.addEventListener('message_sent', (payload: any) => {
        ackedMessages.push(payload);
      });

      // The running client is attached to the update lanes, exactly like the browser after boot.
      stackA.managers.apiUpdatesManager.attach();

      const {chatId} = await stackA.managers.appChatsManager.createChat(
        `b1-round-note-${Date.now()}`,
        [userId]
      );
      const peerId = stackA.managers.appPeersManager.getPeerId({chat_id: chatId});
      expect(
        isServerShapedId(chatId),
        'messages.createChat must hand back a server-shaped chat id; anything else poisons every ' +
        'request the scenario builds on top of it'
      ).toBe(true);

      // The recorder's blob: MediaRecorder output normalized to a bare video/webm
      // (nativeVideoRecorder.ts:260-261) — a real VP8+Opus capture, and the recorder's poster.
      const webmBlob = new Blob([fixtureBytes('round-note-vp8-opus.webm')], {type: 'video/webm'});
      const posterBlob = new Blob([fixtureBytes('round-note-poster-400.jpg')], {type: 'image/jpeg'});

      // EXACTLY the recorder's options — chatRecording.ts:311-325.
      await stackA.managers.appMessagesManager.sendFile({
        peerId,
        file: webmBlob,
        isRoundMessage: true,
        isMedia: true,
        duration: 2,
        width: 400,
        height: 400,
        objectURLBlob: webmBlob,
        thumb: {blob: posterBlob, size: stackA.helpers.makeMediaSize(400, 400)},
        clearDraft: true
      });

      // Wait on the sign of the ack itself: the finalize path dispatching message_sent for a
      // document-media message in this chat.
      const roundAck = await waitUntil(
        () => ackedMessages.find((payload) => {
          return payload?.message?.peerId === peerId && payload?.message?.media?.document;
        }),
        120_000,
        'the server ack of the round note (message_sent with document media in the seeded chat)'
      );

      const finalMid = roundAck.mid;
      const ackedDocumentId = roundAck.message?.media?.document?.id;
      expect(
        stackA.helpers.getServerMessageId(finalMid) > 0,
        'finalize ran, so the acked mid must map to a server message id — a temp mid here means ' +
        'the ack never rebound the pending message and everything after this line measures a ghost'
      ).toBe(true);
      expect(
        isServerShapedId(ackedDocumentId),
        `the acked round note's document id ("${String(ackedDocumentId)}") must already be the ` +
        'server document id; a fractional temp id surviving the ack is the exact spinner loss of ' +
        'commit 6750d8076'
      ).toBe(true);

      // Reload survival prerequisite: the session token must be persisted, or act 2 boots into
      // a logged-out client and the scenario measures the wrong loss.
      const persistedAccount = await stackA.helpers.accountController.get(1);
      expect(
        Boolean(persistedAccount?.impulse_session_token && persistedAccount?.userId),
        'the signed-in session (userId + impulse_session_token) must be persisted before the ' +
        'reload — without it a page refresh logs the user out, which is its own client-visible loss'
      ).toBe(true);

      // ---- act 2: the reload ----
      // A page refresh kills the old context; dispose approximates that (stops realtime), then
      // a fresh module graph boots over the SAME persisted client state.
      await stackA.dispose();
      stackB = await bootLiveManagerStack(liveLane.gatewayOrigin);

      expect(
        Boolean(stackB.userIdAtBoot),
        'the reloaded boot must find the persisted account (loadState reads what the previous ' +
        'session stored) — booting logged-out after a refresh is a session-persistence loss, not ' +
        'a history loss'
      ).toBe(true);

      // The real difference lane: attach() reads the persisted pts state and runs
      // updates.getState / updates.getDifference against the live backend.
      stackB.managers.apiUpdatesManager.attach();
      const updatesStateB = (stackB.managers.apiUpdatesManager as any).updatesState;
      await waitUntil(
        () => {
          const ranSync = stackB!.wire.records.some((record) => {
            return record.method === 'updates.getDifference' || record.method === 'updates.getState';
          });
          return ranSync && updatesStateB.syncLoading === null ? true : undefined;
        },
        60_000,
        'the reloaded stack finishing its updates sync (getState/getDifference settled)'
      );

      // The real dialog-open lane: history through the manager, live messages.getHistory.
      const history = await stackB.managers.appMessagesManager.getHistory({peerId, limit: 50});

      expect(
        stackB.wire.records.some((record) => record.method === 'messages.getHistory'),
        'the reloaded stack must have fetched this history over the live wire — the fresh module ' +
        'graph starts with empty message storages, so a green below without a real ' +
        'messages.getHistory would mean the harness leaked state between stacks and measured ' +
        'residue instead of the backend'
      ).toBe(true);

      // ---- the contract ----
      expect(
        history.history,
        `the fresh stack's history for the seeded chat must include the acked final mid ` +
        `${finalMid} — the server acknowledged this message to this sender (it exists in ` +
        'Cassandra on both partitions and in server search); a hole here is exactly what the ' +
        'CEO saw after reloading: the round note gone from the chat'
      ).toContain(finalMid);

      for(const acked of ackedMessages) {
        const restored = stackB.managers.appMessagesManager.getMessageByPeer(acked.message.peerId, acked.mid);
        expect(
          Boolean(restored && restored._ === 'message'),
          `server-acked mid ${acked.mid} (peer ${acked.message.peerId}) is missing from the ` +
          'reloaded history storage — every message the server acknowledged to this sender must ' +
          'survive a reload; each one lost here is a message the user watched send successfully ' +
          'and then watched vanish'
        ).toBe(true);
      }

      const restoredRound = stackB.managers.appMessagesManager.getMessageByPeer(peerId, finalMid);
      const restoredDocument = restoredRound?.media?.document;
      expect(
        Boolean(restoredDocument),
        'the restored round note must still be a document-media message; losing the media while ' +
        'keeping the row renders an empty bubble where the note was'
      ).toBe(true);
      expect(
        isServerShapedId(restoredDocument?.id),
        `the restored round note's document id ("${String(restoredDocument?.id)}") must be ` +
        'server-shaped (decimal-integer string or safe integer) — a temp-shaped id after reload ' +
        'means playback builds an upload.getFile the serializer refuses and the note spins forever'
      ).toBe(true);

      const videoAttribute = restoredDocument?.attributes?.find((attribute: any) => {
        return attribute._ === 'documentAttributeVideo';
      });
      expect(
        Boolean(videoAttribute?.pFlags?.round_message),
        'the restored document must keep documentAttributeVideo.round_message — without it the ' +
        'note re-renders as a plain video and the round-note UI is silently gone'
      ).toBe(true);

      console.log('[liveharness] round-note reload evidence:', JSON.stringify({
        peerId,
        finalMid,
        ackedDocumentId: String(ackedDocumentId),
        restoredDocumentId: String(restoredDocument?.id),
        restoredRoundFlag: Boolean(videoAttribute?.pFlags?.round_message),
        historyLength: history.history.length,
        ackedCount: ackedMessages.length
      }));

      // ---- standing invariants (every B1 scenario asserts these) ----
      // Deterministically close the known post-auth window first: user_auth arms a 5s
      // greeting-sticker preload (appStickersManager.ts:68-71) on EACH signed-in boot, and its
      // promise chain has no rejection handler. Whether its rejection lands inside or after the
      // scenario used to be a race; waiting for the preload's own wire action (and a drain for
      // the rejection to propagate) makes the zero-unhandled-rejections verdict the same on
      // every run.
      await waitUntil(
        () => {
          const aRan = stackA!.wire.records.some((record) => record.method === 'messages.getStickers');
          const bRan = stackB!.wire.records.some((record) => record.method === 'messages.getStickers');
          return aRan && bRan ? true : undefined;
        },
        30_000,
        'both boots\' greeting-sticker preload (messages.getStickers, armed 5s after user_auth) to reach the wire'
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 750);
      });

      stackA.wire.assertClean('sender session (auth, chat seed, round note send)');
      stackB.wire.assertClean('reloaded session (difference + history)');
      rejections.assertNone('the whole round-note send/reload scenario');
    } finally {
      rejections.uninstall();
      await stackA?.dispose();
      await stackB?.dispose();
    }
  }, 300_000);
});
