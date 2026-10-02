import {Page} from '@playwright/test';

import {liveLane} from './lane';
import {expect, test} from './pair';


/*
 * B2 calls lane: LiveKit media between two real browsers on the live dev stack.
 *
 * Needs a real LiveKit project behind the stack (LiveKit__url/apiKey/apiSecret on the backend), so it
 * carries its own gate on top of the live-gateway one:
 *
 *   IMPULSE_LIVE_GATEWAY=http://localhost:5200 IMPULSE_LIVE_LIVEKIT=1 \
 *     pnpm exec playwright test -c playwright.live.config.ts --project=chromium-calls
 *
 * Chromium feeds a synthetic microphone (a beep), so inbound audio is never silent.
 *
 * WHAT IS ASSERTED. Not an intermediate flag: the observable end state of the media path. The transport of the
 * call is read through the debug mounts the dev build exposes (window.callsController /
 * window.groupCallController), its own diagnostics: connected, the other party in the room under its
 * identity, a remote audio track subscribed, and its inbound byte counter growing across two samples. The
 * assertions never depend on LiveKit webhooks, which cannot reach a NAT'd dev stack.
 */
const enabled = liveLane.enabled && process.env.IMPULSE_LIVE_LIVEKIT === '1';
const gateReason = 'IMPULSE_LIVE_LIVEKIT=1 (and IMPULSE_LIVE_GATEWAY) are required: this lane needs a real LiveKit project behind the dev stack';
const connectTimeoutMs = 90_000;
const sampleGapMs = 2_000;

type TransportDiagnostics = {
  state: string,
  localIdentity?: string,
  e2ee: boolean,
  remoteParticipants: string[],
  remoteTracks: Array<{identity: string, source: string, kind: string, muted: boolean, bytesReceived?: number}>
};


/** The transport diagnostics of the 1:1 call or the group call currently running in `page`. */
async function readDiagnostics(page: Page, kind: 'phone' | 'group'): Promise<TransportDiagnostics | undefined> {
  return page.evaluate(async(callKind) => {
    const w = window as any;
    const transport = callKind === 'phone' ?
      w.callsController?.currentCall?.session?.transport :
      w.groupCallController?.groupCall?.connections?.main?.transport;
    if(!transport) {
      return undefined;
    }

    return transport.getDiagnostics();
  }, kind);
}

function audioBytes(diagnostics: TransportDiagnostics | undefined, identityPattern: RegExp): number {
  const track = diagnostics?.remoteTracks.find((candidate) => {
    return candidate.kind === 'audio' && candidate.source === 'microphone' && identityPattern.test(candidate.identity);
  });
  return track?.bytesReceived ?? -1;
}

/**
 * The call reaches `connected`, the other party is in the room, and its audio is flowing: the inbound byte
 * counter of its microphone track is above zero and grows between two samples.
 */
async function expectMediaFlowing(page: Page, kind: 'phone' | 'group', options: {
  remoteIdentity: RegExp,
  e2ee: boolean
}): Promise<void> {
  await expect.poll(async() => {
    const diagnostics = await readDiagnostics(page, kind);
    return diagnostics?.state === 'connected' &&
      diagnostics.remoteParticipants.some((identity) => options.remoteIdentity.test(identity)) &&
      audioBytes(diagnostics, options.remoteIdentity) > 0;
  }, {
    message: `the ${kind} call never reached connected with the other party's audio subscribed and bytes received`,
    timeout: connectTimeoutMs
  }).toBe(true);

  const first = audioBytes(await readDiagnostics(page, kind), options.remoteIdentity);
  await expect.poll(async() => {
    await page.waitForTimeout(sampleGapMs);
    return audioBytes(await readDiagnostics(page, kind), options.remoteIdentity);
  }, {
    message: 'the remote audio track stopped receiving bytes: it was not flowing between two samples',
    timeout: connectTimeoutMs
  }).toBeGreaterThan(first);

  const diagnostics = await readDiagnostics(page, kind);
  expect(diagnostics?.e2ee, 'media encryption of the call').toBe(options.e2ee);
}


test.describe('LiveKit calls', () => {
  test.skip(!enabled, gateReason);
  test.use({pairContextOptions: {permissions: ['microphone', 'camera']}});

  test('1:1 call: the sender calls, the recipient accepts in the popup, and audio flows end-to-end encrypted both ways', async({pair}) => {
    const {sender, recipient} = pair;
    const senderId = await sender.ownPeerId();
    const recipientId = await recipient.ownPeerId();

    // The topbar Call button is offered only when the server flags the user (userFull.phone_calls_available).
    await sender.page.locator('.chat-utils').getByRole('button', {name: 'Call', exact: true}).click({timeout: connectTimeoutMs});
    await recipient.page.locator('.popup-call').getByRole('button', {name: 'Accept'}).click({timeout: connectTimeoutMs});

    await Promise.all([
      expectMediaFlowing(sender.page, 'phone', {remoteIdentity: new RegExp(`^u${recipientId}$`), e2ee: true}),
      expectMediaFlowing(recipient.page, 'phone', {remoteIdentity: new RegExp(`^u${senderId}$`), e2ee: true})
    ]);

    await sender.page.evaluate(async() => {
      await (window as any).callsController.currentCall.hangUp('phoneCallDiscardReasonHangup');
    });
    // the end of the call reaches the other side without a click: nothing is left running there
    await expect.poll(
      () => recipient.page.evaluate(() => !(window as any).callsController?.currentCall),
      {message: 'the recipient still has a call after the sender hung up', timeout: connectTimeoutMs}
    ).toBe(true);
  });

  test('group call: both join unmuted, each hears the other, and the call ends cleanly', async({pair}) => {
    const {sender, recipient} = pair;
    const senderId = await sender.ownPeerId();
    const recipientId = await recipient.ownPeerId();

    const {chatId, callId} = await sender.page.evaluate(async(userId) => {
      const w = window as any;
      const {chatId: createdChatId} = await w.rootScope.managers.appChatsManager.createChat(`calls-${Date.now()}`, [Number(userId)]);
      const call = await w.rootScope.managers.appGroupCallsManager.createGroupCall(createdChatId);
      await w.groupCallController.joinGroupCall(createdChatId, call.id, false);
      return {chatId: createdChatId, callId: call.id};
    }, recipientId);

    await recipient.page.evaluate(async({joinChatId, joinCallId}) => {
      const w = window as any;
      // the group reaches the recipient through its updates; the join needs the call, not the dialog
      await w.groupCallController.joinGroupCall(joinChatId, joinCallId, false);
    }, {joinChatId: chatId, joinCallId: callId});

    await Promise.all([
      expectMediaFlowing(sender.page, 'group', {remoteIdentity: new RegExp(`^u${recipientId}\\.\\d+$`), e2ee: false}),
      expectMediaFlowing(recipient.page, 'group', {remoteIdentity: new RegExp(`^u${senderId}\\.\\d+$`), e2ee: false})
    ]);

    await Promise.all([sender.page, recipient.page].map((page) => page.evaluate(async() => {
      await (window as any).groupCallController.groupCall.hangUp();
    })));
  });
});
