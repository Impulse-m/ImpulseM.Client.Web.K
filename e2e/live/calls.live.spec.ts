import {Page} from '@playwright/test';

import {liveLane} from './lane';
import {expect, PersonaPair, test} from './pair';
import {PersonaSession} from './personaSession';


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
// Packets sent before the hang-up may still be in flight through the SFU; past this nothing of the sender's may arrive.
const hangUpDrainMs = 500;
// Kept below CALL_DISCARD_TEARDOWN_CAP_MS together with hangUpDrainMs: the sender's room is still up while it is measured.
const hangUpWindowMs = 2_000;
const hangUpSampleMs = 100;

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

type InboundAudio = {packetsReceived: number, totalAudioEnergy: number};

/**
 * Holds on to the RTCRtpReceiver of the 1:1 call's remote microphone named `identity`: its counters stay readable
 * after LiveKit dropped the track.
 */
async function watchInboundAudio(page: Page, identity: string): Promise<void> {
  const watched: boolean = await page.evaluate((remoteIdentity) => {
    const transport = (window as any).callsController?.currentCall?.session?.transport;
    const entries: any[] = transport ? [...transport.remoteTracks.values()] : [];
    const entry = entries.find((candidate) => candidate.identity === remoteIdentity && candidate.source === 'microphone');
    (window as any).__watchedReceiver = entry?.track?.receiver;
    return !!entry?.track?.receiver;
  }, identity);
  expect(watched, `the receiver of ${identity}'s microphone`).toBe(true);
}

/** The inbound-rtp counters of the receiver watchInboundAudio holds; undefined once the receiver reports none. */
async function readInboundAudio(page: Page): Promise<InboundAudio | undefined> {
  return page.evaluate(async() => {
    const report: RTCStatsReport = await ((window as any).__watchedReceiver as RTCRtpReceiver).getStats();
    let inbound: InboundAudio | undefined;
    report.forEach((stat: any) => {
      if(stat.type === 'inbound-rtp') {
        inbound = {packetsReceived: stat.packetsReceived, totalAudioEnergy: stat.totalAudioEnergy};
      }
    });
    return inbound;
  });
}

/** The sender calls from the topbar, the recipient accepts in the popup, and audio flows end-to-end encrypted both ways. */
async function startPhoneCall(pair: PersonaPair): Promise<{senderId: string, recipientId: string}> {
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

  return {senderId, recipientId};
}

async function expectRecipientCallEnded(recipient: PersonaSession): Promise<void> {
  await expect.poll(
    () => recipient.page.evaluate(() => !(window as any).callsController?.currentCall),
    {message: 'the recipient still has a call after the sender hung up', timeout: connectTimeoutMs}
  ).toBe(true);
}


test.describe('LiveKit calls', () => {
  test.skip(!enabled, gateReason);
  test.use({pairContextOptions: {permissions: ['microphone', 'camera']}});

  test('1:1 call: the sender calls, the recipient accepts in the popup, and audio flows end-to-end encrypted both ways', async({pair}) => {
    const {sender, recipient} = pair;
    await startPhoneCall(pair);

    // What the recipient hears from here on, and the call it will see end
    await recipient.page.evaluate(() => {
      const played: string[] = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function(this: HTMLMediaElement): Promise<void> {
        played.push(this.currentSrc || this.src);
        return play.call(this);
      };
      (window as any).__playedSounds = played;
      (window as any).__watchedCall = (window as any).callsController.currentCall;
    });

    await sender.page.evaluate(async() => {
      await (window as any).callsController.currentCall.hangUp('phoneCallDiscardReasonHangup');
    });
    // the end of the call reaches the other side without a click: nothing is left running there
    await expectRecipientCallEnded(recipient);

    // The peer hanging up is not our reconnect: the connecting loop never played, the call ended as a hang-up
    const ended = await recipient.page.evaluate(() => ({
      sounds: ((window as any).__playedSounds as string[]).map((src) => src.split('/').pop()),
      reason: (window as any).__watchedCall.discardReason?._
    }));
    expect(ended.sounds, 'sounds the recipient played while the sender hung up').not.toContain('voip_connecting.mp3');
    expect(ended.reason, 'how the call ended on the recipient').toBe('phoneCallDiscardReasonHangup');
  });

  test('1:1 call: once the sender starts hanging up, not one more packet of its microphone reaches the recipient, while its discard is still on the way', async({pair}) => {
    const {sender, recipient} = pair;
    const {senderId} = await startPhoneCall(pair);
    const senderIdentity = `u${senderId}`;

    await watchInboundAudio(recipient.page, senderIdentity);
    const flowing = await readInboundAudio(recipient.page);
    await recipient.page.waitForTimeout(hangUpWindowMs);
    const stillFlowing = await readInboundAudio(recipient.page);
    expect(flowing, 'the inbound-rtp of the sender\'s microphone at the recipient').toBeDefined();
    expect(
      stillFlowing?.packetsReceived,
      'the sender\'s microphone packets arrive at the recipient before the hang-up (the measure can see a flow)'
    ).toBeGreaterThan(flowing.packetsReceived);

    // phone.discardCall leaves the sender only when the test lets it, with the arguments the hang-up gave it: until
    // then the server keeps the room, and the recipient keeps listening to whatever the sender still sends.
    await sender.page.evaluate(() => {
      const w = window as any;
      const call = w.callsController.currentCall;
      const managers = call.managers;
      let release: () => void;
      const held: Promise<void> = new Promise<void>((resolve) => {
        release = resolve;
      });
      w.__discard = {sent: false, release: () => release()};
      call.managers = new Proxy(managers, {
        get: (target, key) => key !== 'appCallsManager' ? target[key] : new Proxy(target.appCallsManager, {
          get: (callsManager, method) => method !== 'discardCall' ? callsManager[method] : async(...args: unknown[]) => {
            await held;
            w.__discard.sent = true;
            return callsManager.discardCall(...args);
          }
        })
      });
      w.__hangUp = call.hangUp('phoneCallDiscardReasonHangup');
    });

    await recipient.page.waitForTimeout(hangUpDrainMs);
    // A receiver whose stream the SFU stopped forwarding reports no inbound-rtp at all: nothing arrives on it any more.
    const samples: Array<InboundAudio | undefined> = [await readInboundAudio(recipient.page)];
    const windowEndsAt: number = Date.now() + hangUpWindowMs;
    while(Date.now() < windowEndsAt) {
      await recipient.page.waitForTimeout(hangUpSampleMs);
      samples.push(await readInboundAudio(recipient.page));
    }
    const counted: InboundAudio[] = samples.filter((sample): sample is InboundAudio => !!sample);
    const arrived: number = counted.length ? counted[counted.length - 1].packetsReceived - counted[0].packetsReceived : 0;
    const during = {
      discardSent: await sender.page.evaluate(() => (window as any).__discard.sent),
      recipient: await readDiagnostics(recipient.page, 'phone')
    };

    expect(during.discardSent, 'the sender\'s phone.discardCall is still held: the window is before it settled').toBe(false);
    expect(during.recipient?.state, 'the recipient\'s room is still up through the window').toBe('connected');
    expect(during.recipient?.remoteParticipants, 'the sender is still in the recipient\'s room through the window').toContain(senderIdentity);
    expect(
      arrived,
      `microphone packets of the sender that reached the recipient between ${hangUpDrainMs} ms and ` +
      `${hangUpDrainMs + hangUpWindowMs} ms after the sender started hanging up, a local hang-up must stop sending ` +
      `at once (inbound-rtp samples, packets/energy, "gone" once the receiver has none: ${samples.map((sample) => {
        return sample ? `${sample.packetsReceived}/${sample.totalAudioEnergy.toFixed(6)}` : 'gone';
      }).join(' ')})`
    ).toBe(0);

    await sender.page.evaluate(async() => {
      const w = window as any;
      w.__discard.release();
      await w.__hangUp;
    });
    await expectRecipientCallEnded(recipient);
  });

  for(const kind of ['basic group', 'supergroup'] as const) {
    test(`${kind} call: both join unmuted, each hears the other, each sees the other's camera tile, and the call ends cleanly`, async({pair}) => {
      const {sender, recipient} = pair;
      const senderId = await sender.ownPeerId();
      const recipientId = await recipient.ownPeerId();

      const {chatId, callId} = await sender.page.evaluate(async({userId, groupKind}) => {
        const w = window as any;
        const chats = w.rootScope.managers.appChatsManager;
        const title = `calls-${Date.now()}`;
        let createdChatId: number;
        if(groupKind === 'supergroup') {
          createdChatId = await chats.createChannel({megagroup: true, title, about: ''});
          await chats.inviteToChannel(createdChatId, [Number(userId)]);
        } else {
          createdChatId = (await chats.createChat(title, [Number(userId)])).chatId;
        }
        const call = await w.rootScope.managers.appGroupCallsManager.createGroupCall(createdChatId);
        await w.groupCallController.joinGroupCall(createdChatId, call.id, false);
        return {chatId: createdChatId, callId: call.id};
      }, {userId: recipientId, groupKind: kind});

      await recipient.page.evaluate(async({joinChatId, joinCallId}) => {
        const w = window as any;
        // the group reaches the recipient through its updates; the join needs the call, not the dialog
        await w.groupCallController.joinGroupCall(joinChatId, joinCallId, false);
      }, {joinChatId: chatId, joinCallId: callId});

      await Promise.all([
        expectMediaFlowing(sender.page, 'group', {remoteIdentity: new RegExp(`^u${recipientId}\\.\\d+$`), e2ee: false}),
        expectMediaFlowing(recipient.page, 'group', {remoteIdentity: new RegExp(`^u${senderId}\\.\\d+$`), e2ee: false})
      ]);

      // Each side turns its camera on; the other must get a camera tile whose participant row names the publisher's
      // LiveKit identity as video.endpoint (the server emits video only because the join declared source groups).
      await Promise.all([sender.page, recipient.page].map((page) => page.evaluate(async() => {
        await (window as any).groupCallController.groupCall.startVideoSharing();
      })));
      for(const [watcher, publisherId] of [[sender, recipientId], [recipient, senderId]] as const) {
        const identity = new RegExp(`^u${publisherId}\\.\\d+$`);
        await expect.poll(async() => {
          return watcher.page.evaluate(async(id) => {
            const call = (window as any).groupCallController.groupCall;
            const rows = await call.participants;
            const row: any = [...rows.values()].find((candidate: any) => String(candidate.peer?.user_id) === id);
            const diagnostics = await call.connections.main.transport.getDiagnostics();
            const track = diagnostics.remoteTracks.find((candidate: any) => candidate.kind === 'video' && candidate.source === 'camera');
            const endpoint: string | undefined = row?.video?.endpoint;
            return {
              endpoint,
              trackIdentity: track?.identity,
              sourceGroups: row?.video?.source_groups?.length ?? 0,
              tile: !!endpoint && !!call.getElement(endpoint)
            };
          }, publisherId);
        }, {
          message: `the camera of user ${publisherId} never became a tile with video.endpoint equal to its identity`,
          timeout: connectTimeoutMs
        }).toMatchObject({
          endpoint: expect.stringMatching(identity),
          trackIdentity: expect.stringMatching(identity),
          tile: true
        });
        const final = await watcher.page.evaluate(async(id) => {
          const rows = await (window as any).groupCallController.groupCall.participants;
          const row: any = [...rows.values()].find((candidate: any) => String(candidate.peer?.user_id) === id);
          const track = (await (window as any).groupCallController.groupCall.connections.main.transport.getDiagnostics())
          .remoteTracks.find((candidate: any) => candidate.kind === 'video');
          return {endpoint: row.video.endpoint, trackIdentity: track.identity, groups: row.video.source_groups.length};
        }, publisherId);
        expect(final.endpoint, 'video.endpoint is exactly the publisher identity of the subscribed camera track').toBe(final.trackIdentity);
        expect(final.groups, 'the row carries the declared source groups').toBeGreaterThan(0);
      }

      await Promise.all([sender.page, recipient.page].map((page) => page.evaluate(async() => {
        await (window as any).groupCallController.groupCall.hangUp();
      })));
    });
  }

  test('basic group call: both leave without ending it, the bar under the header counts each leave and never flashes for the last one', async({pair}) => {
    const {sender, recipient} = pair;
    const senderId = await sender.ownPeerId();
    const recipientId = await recipient.ownPeerId();

    const {chatId, callId} = await sender.page.evaluate(async(userId) => {
      const w = window as any;
      const createdChatId = (await w.rootScope.managers.appChatsManager.createChat(`calls-bar-${Date.now()}`, [Number(userId)])).chatId;
      const call = await w.rootScope.managers.appGroupCallsManager.createGroupCall(createdChatId);
      await w.groupCallController.joinGroupCall(createdChatId, call.id, false);
      return {chatId: createdChatId, callId: call.id};
    }, recipientId);
    await recipient.page.evaluate(async({joinChatId, joinCallId}) => {
      await (window as any).groupCallController.joinGroupCall(joinChatId, joinCallId, false);
    }, {joinChatId: chatId, joinCallId: callId});
    await Promise.all([
      expectMediaFlowing(sender.page, 'group', {remoteIdentity: new RegExp(`^u${recipientId}\\.\\d+$`), e2ee: false}),
      expectMediaFlowing(recipient.page, 'group', {remoteIdentity: new RegExp(`^u${senderId}\\.\\d+$`), e2ee: false})
    ]);
    for(const page of [sender.page, recipient.page]) {
      await page.evaluate((id) => (window as any).appImManager.setInnerPeer({peerId: id.toPeerId(true)}), chatId);
    }

    const readBar = (page: Page) => page.evaluate(async(id) => {
      const w = window as any;
      const call = await w.rootScope.managers.appGroupCallsManager.getGroupCall(id);
      const rows = await w.rootScope.managers.appGroupCallsManager.getCachedParticipants(id);
      return {
        count: call?.participants_count,
        listed: [...rows.keys()].map(String),
        shown: [...document.querySelectorAll('.pinned-group-call')].some((plate) => !plate.classList.contains('hide'))
      };
    }, callId);

    // The admin leaves first: the call goes on with the other participant in it.
    await sender.page.evaluate(() => (window as any).groupCallController.groupCall.hangUp());
    await expect.poll(() => readBar(sender.page), {
      message: 'the admin that left is shown the call it left, with the one participant still in it',
      timeout: connectTimeoutMs
    }).toEqual({count: 1, listed: [recipientId], shown: true});

    // The last participant leaves: on its own page the bar must never appear for the call it is leaving.
    await recipient.page.evaluate(() => {
      const w = window as any;
      const startedAt = performance.now();
      const shown: string[] = w.__barShownAfterLeave = [];
      const check = () => {
        for(const plate of document.querySelectorAll('.pinned-group-call')) {
          if(!plate.classList.contains('hide')) {
            shown.push(`${Math.round(performance.now() - startedAt)} ms: "${plate.textContent}"`);
          }
        }
      };
      new MutationObserver(check).observe(document.body, {subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true});
      check();
    });
    await recipient.page.evaluate(() => (window as any).groupCallController.groupCall.hangUp());
    // Watched until the chat stops saying anybody is in its call (constructor/chat.md:63-67), which is when
    // the bar used to hide.
    await expect.poll(() => recipient.page.evaluate(async(id) => {
      const chat = await (window as any).rootScope.managers.appChatsManager.getChat(id);
      return !!chat?.pFlags?.call_not_empty;
    }, chatId), {
      message: 'the last participant\'s chat never stopped saying there is somebody in its call',
      timeout: connectTimeoutMs
    }).toBe(false);
    for(const page of [sender.page, recipient.page]) {
      await expect.poll(() => readBar(page), {
        message: 'the call is still active and nobody is in it',
        timeout: connectTimeoutMs
      }).toEqual({count: 0, listed: [], shown: false});
    }
    expect(
      await recipient.page.evaluate(() => (window as any).__barShownAfterLeave),
      'the bar of the call the last participant was leaving appeared on its own page, at these times after the observer started'
    ).toEqual([]);
  });
});
