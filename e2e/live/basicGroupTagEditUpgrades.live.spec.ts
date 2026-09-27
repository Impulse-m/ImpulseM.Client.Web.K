import {liveLane} from './lane';
import type {PersonaSession} from './personaSession';
import {test} from './pair';

/*
 * B2 basic-group migration: the tag-edit upgrade path, in a REAL browser (issue #325).
 *
 * CEO, live: setting an admin tag ("Linsa") in a basic group left TWO broken chats — the old
 * group stayed in the list even though the server had already migrated it, and the new
 * supergroup never carried the tag or the group's own history.
 * `.claude-scratch/migration-synthesis.md` re-derived the causal chain (see the header of the
 * companion B1 scenario, src/tests/liveharness/basicGroupMigration.live.test.ts, for the full
 * file:line citations). The short version this spec exercises end to end, in the real client UI:
 *
 *   1. Setting a non-empty admin rank on a basic-group participant upgrades the group first
 *      (appChatsManager.ts:824 canStickToLegacy = !rank && ...), via messages.migrateChat.
 *   2. That answer never carries an `updateChannel` (MessagesPartialService.cs:1113-1167), so
 *      appChatsManager.migrateChat's `updates.find(u => u._ === 'updateChannel').channel_id`
 *      throws a bare TypeError (appChatsManager.ts:786-787) AFTER the migration has already
 *      committed server-side — so the tag is never actually sent.
 *   3. Every later snapshot read (getDialogs, getChats, a fresh boot) rebuilds the old chat
 *      through a mapping lane that sets `deactivated` but never `migrated_to`
 *      (ChatWireBuilder.cs:213-216, "MigratedTo is deliberately not built here"). Both
 *      `getPeerMigratedTo` (appPeersManager.ts:53-54) and the dialogs list filter
 *      (storages/dialogs.ts:1568/:514) require BOTH fields together, so a chat the server itself
 *      calls migrated keeps showing up as a live, separate dialog, and opening it never
 *      redirects to what it became (appImManager.ts:3029 `getPeerMigratedTo(peerId) || peerId`).
 *   4. Migrated members are never told in realtime either (no `updateChannel` fans out to them
 *      — ChatEventProjector.cs:186-205), so the new supergroup does not appear on their side
 *      without a manual refresh.
 *
 * FIDELITY BOUNDARY (documented, mirroring the round-note boundary in personaSession.ts): the
 * tag edit itself is driven as `window.rootScope.managers.appChatsManager.editAdmin(...)` from
 * the page context rather than by clicking through the participant-permissions screen
 * (chatUserPermissions.tsx:187 calls the exact same manager method on Save) — peer/participant
 * setup is test plumbing, not the surface under test, the same rule personaSession.ts documents
 * for contacts.resolvePhone. Every ASSERTION below reads the real rendered DOM the user sees:
 * the chat-list rows, the redirect on opening the old peer, the scrolled-back bubbles, and the
 * rank badge.
 *
 * Per the plan, supergroup send/edit legs stay OUT of this scenario (gated behind #382/#275):
 * every message read back here was sent in the BASIC GROUP before the upgrade; nothing is sent
 * into the supergroup itself.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);


async function resolveParticipantUserId(session: PersonaSession, phone: string): Promise<number> {
  const digits = phone.replace('+', '');
  const user: any = await session.page.evaluate(async(phoneDigits) => {
    const w = window as any;
    return w.rootScope.managers.appUsersManager.resolvePhone(phoneDigits);
  }, digits);

  if(!user?.id) {
    throw new Error(`contacts.resolvePhone("+${digits}") returned no user — cannot add the participant to the group`);
  }

  return user.id;
}


async function createBasicGroup(session: PersonaSession, title: string, participantUserId: number): Promise<number> {
  const created: any = await session.page.evaluate(async([groupTitle, userId]) => {
    const w = window as any;
    return w.rootScope.managers.appChatsManager.createChat(groupTitle, [userId]);
  }, [title, participantUserId] as [string, number]);

  return created.chatId;
}


async function peerIdOfChat(session: PersonaSession, chatId: number): Promise<number> {
  return session.page.evaluate((id) => (id as any).toPeerId(true), chatId);
}


async function openPeerById(session: PersonaSession, peerId: number): Promise<void> {
  await session.page.evaluate(async(id) => {
    const w = window as any;
    await w.appImManager.setInnerPeer({peerId: id});
  }, peerId);
}


async function waitForOpenPeer(session: PersonaSession, peerId: number, timeoutMs = 30_000): Promise<boolean> {
  return session.page.waitForFunction((id) => {
    return String((window as any).appImManager?.chat?.peerId) === String(id);
  }, peerId, {timeout: timeoutMs}).then(() => true).catch(() => false);
}


/**
 * The trigger action, and the ground truth for which channel the group became — independent of
 * editAdmin's own (possibly-thrown) return value, via the `chat_update` event saveApiChats fires
 * for every chat in an answer's chats[] (appChatsManager.ts:289). Mirrors the technique in the B1
 * live-harness scenario, driven here through the page's own real manager stack.
 */
async function triggerTagEditUpgrade(
  session: PersonaSession,
  oldChatId: number,
  participantUserId: number,
  rank: string
): Promise<{resultChatId: number | undefined, errorName: string | undefined, errorMessage: string | undefined, newChannelId: number | undefined}> {
  return session.page.evaluate(async([chatId, userId, tag]) => {
    const w = window as any;
    const touchedChatIds = new Set<number>();
    const listener = (id: number) => touchedChatIds.add(id);
    w.rootScope.addEventListener('chat_update', listener);

    let resultChatId: number | undefined;
    let errorName: string | undefined;
    let errorMessage: string | undefined;
    try {
      resultChatId = await w.rootScope.managers.appChatsManager.editAdmin(
        chatId,
        userId,
        {_: 'chatAdminRights', pFlags: {change_info: true, invite_users: true}},
        tag
      );
    } catch(error: any) {
      errorName = error?.name ?? typeof error;
      errorMessage = error?.message ?? JSON.stringify(error);
    } finally {
      w.rootScope.removeEventListener('chat_update', listener);
    }

    let newChannelId: number | undefined;
    for(const candidateId of touchedChatIds) {
      if(candidateId === chatId) {
        continue;
      }

      const candidate = await w.rootScope.managers.appChatsManager.getChat(candidateId);
      if(candidate?._ === 'channel') {
        newChannelId = candidateId;
        break;
      }
    }

    return {resultChatId, errorName, errorMessage, newChannelId};
  }, [oldChatId, participantUserId, rank] as [number, number, string]);
}


async function chatListPeerIds(session: PersonaSession): Promise<string[]> {
  return session.page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>('.chatlist-chat[data-peer-id]'))
      .map((element) => element.dataset.peerId ?? '');
  });
}


async function reloadAndReopenPeer(session: PersonaSession, peerId: number): Promise<void> {
  await session.page.reload({waitUntil: 'domcontentloaded'});
  await session.waitForImReady();
  await openPeerById(session, peerId);
}


/**
 * Nudges the infinite-scroll loader upward repeatedly (a real user drags the scrollbar to the
 * top, not one instant jump) and polls the bubbles container for every needle text, bounded and
 * caught — the caller renders its own verdict on the returned boolean.
 */
async function scrollUntilTextsVisible(session: PersonaSession, needles: string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for(;;) {
    const seen: boolean = await session.page.evaluate((texts) => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll'));

      const rendered = container.textContent || '';
      return (texts as string[]).every((needle) => rendered.includes(needle));
    }, needles);

    if(seen) {
      return true;
    }

    if(Date.now() > deadline) {
      return false;
    }

    await session.page.waitForTimeout(1_000);
  }
}


async function rankBadgeTextsVisible(session: PersonaSession, needle: string): Promise<string[]> {
  return session.page.evaluate((tagText) => {
    const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
    if(!container) {
      return [];
    }

    return Array.from(container.querySelectorAll<HTMLElement>('.bubble-name-rank'))
      .map((element) => element.textContent ?? '')
      .filter((text) => text.includes(tagText));
  }, needle);
}


test('setting an admin tag on a basic-group participant upgrades it: the group stays reachable as one row, redirects, keeps its history and shows the tag (issue #325)', async({pair}) => {
  const {sender, recipient} = pair;
  const nonce = Date.now().toString(36);
  const title = `MigrationTagEdit-${nonce}`;
  const tag = `mig-tag-${nonce}`;

  const participantUserId = await resolveParticipantUserId(sender, recipient.persona.phone);
  const oldChatId = await createBasicGroup(sender, title, participantUserId);
  const oldPeerId = await peerIdOfChat(sender, oldChatId);

  // ---- pre-migration history: both members post into the BASIC GROUP, before any upgrade ----
  await openPeerById(sender, oldPeerId);
  await sender.sendTextThroughUi(`owner-${nonce}`);

  await openPeerById(recipient, oldPeerId);
  const participantTextA = `pre-mig-B-${nonce}-1`;
  const participantTextB = `pre-mig-B-${nonce}-2`;
  await recipient.sendTextThroughUi(participantTextA);
  await recipient.sendTextThroughUi(participantTextB);
  await sender.waitForIncomingText(participantTextB);

  // ---- the trigger: a non-empty rank on a basic-group participant forces the upgrade path ----
  const outcome = await triggerTagEditUpgrade(sender, oldChatId, participantUserId, tag);

  if(outcome.newChannelId === undefined) {
    throw new Error(
      'no chat_update fired for a chat other than the old basic group during editAdmin — the ' +
      'server never migrated the group at all, so nothing below can be checked. Outcome: ' +
      JSON.stringify(outcome)
    );
  }

  const newChannelId = outcome.newChannelId;
  const newPeerId = await peerIdOfChat(sender, newChannelId);

  // ---- assertion: no TypeError ----
  if(outcome.errorName === 'TypeError') {
    throw new Error(
      'appChatsManager.editAdmin threw a bare TypeError instead of resolving to the new channel ' +
      'id — migrateChat (appChatsManager.ts:786-787) reads ' +
      'updates.updates.find(u => u._ === \'updateChannel\').channel_id and the ' +
      'messages.migrateChat answer never contains one (MessagesPartialService.cs:1113-1167), so ' +
      `.channel_id is read off undefined. Caught: ${outcome.errorName}: ${outcome.errorMessage}`
    );
  }

  // ---- assertion: exactly one row for the group, and it is the supergroup — BEFORE reload ----
  const rowsBeforeReload = await chatListPeerIds(sender);
  const matchingBeforeReload = rowsBeforeReload.filter((id) => id === String(oldPeerId) || id === String(newPeerId));
  if(matchingBeforeReload.length !== 1 || matchingBeforeReload[0] !== String(newPeerId)) {
    throw new Error(
      'the sender\'s chat list does not show exactly one row for the group, pointing at the ' +
      'supergroup, right after the migration — dialogsStorage only drops the old dialog when the ' +
      'chat carries BOTH migrated_to AND pFlags.deactivated (storages/dialogs.ts:1568/:514), and ' +
      `the snapshot lane never sets migrated_to. old peerId=${oldPeerId}, new peerId=${newPeerId}, ` +
      `matching rows: ${JSON.stringify(matchingBeforeReload)}, all rows: ${JSON.stringify(rowsBeforeReload)}`
    );
  }

  // ---- assertion: B sees the supergroup without a reload ----
  const recipientSawSupergroup = await recipient.page.waitForFunction((id) => {
    return !!document.querySelector(`.chatlist-chat[data-peer-id="${id}"]`);
  }, newPeerId, {timeout: 45_000}).then(() => true).catch(() => false);
  if(!recipientSawSupergroup) {
    const recipientRows = await chatListPeerIds(recipient);
    throw new Error(
      'the participant\'s chat list never showed the new supergroup without a reload — carried-' +
      'over members get no realtime updateChannel for the migration (the migration fan-out at ' +
      'ChatEventProjector.cs:186-205 sends no channel update; Web K only creates the dialog from ' +
      `onUpdateChannel). Expected peerId ${newPeerId} among: ${JSON.stringify(recipientRows)}`
    );
  }

  // ---- reload both sides ----
  await reloadAndReopenPeer(sender, newPeerId);
  await reloadAndReopenPeer(recipient, newPeerId);

  // ---- assertion: exactly one row for the group, and it is the supergroup — AFTER reload ----
  const rowsAfterReload = await chatListPeerIds(sender);
  const matchingAfterReload = rowsAfterReload.filter((id) => id === String(oldPeerId) || id === String(newPeerId));
  if(matchingAfterReload.length !== 1 || matchingAfterReload[0] !== String(newPeerId)) {
    throw new Error(
      'the sender\'s chat list does not show exactly one row for the group, pointing at the ' +
      'supergroup, after a reload — a fresh boot re-reads the chat through the same broken ' +
      'snapshot lane (getDialogs/getChats), which never sets migrated_to, so the old chat comes ' +
      `back. old peerId=${oldPeerId}, new peerId=${newPeerId}, matching rows: ` +
      `${JSON.stringify(matchingAfterReload)}, all rows: ${JSON.stringify(rowsAfterReload)}`
    );
  }

  // ---- assertion: opening the old peer redirects ----
  await openPeerById(sender, oldPeerId);
  const redirected = await waitForOpenPeer(sender, newPeerId, 30_000);
  if(!redirected) {
    const openedPeerId = await sender.page.evaluate(() => String((window as any).appImManager?.chat?.peerId ?? ''));
    throw new Error(
      'opening the old (deactivated) peer did not redirect to the supergroup it migrated into — ' +
      'appImManager.setPeer reads getPeerMigratedTo(peerId) || peerId at the top ' +
      '(src/lib/appImManager.ts:3029), and getPeerMigratedTo requires BOTH chat.migrated_to AND ' +
      'pFlags.deactivated (appPeersManager.ts:53-54), which the snapshot lane never sets together. ' +
      `Expected the app to land on peerId ${newPeerId}, it stayed on/landed on ${openedPeerId}`
    );
  }

  // ---- assertion: scrolling up reaches the pre-migration texts ----
  const historyVisible = await scrollUntilTextsVisible(
    sender,
    [`owner-${nonce}`, participantTextA, participantTextB],
    45_000
  );
  if(!historyVisible) {
    const rendered = await sender.page.evaluate(() => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      return container?.textContent ?? '<no bubbles container>';
    });
    throw new Error(
      'scrolling to the top of the supergroup never surfaced the messages sent in the basic ' +
      'group before the upgrade — the client only stitches the old chat\'s history into the new ' +
      'channel once it has learned the old chat\'s migrated_to (appMessagesManager.ts:7201-7213 ' +
      'migrateChecks, populated from a dialog carrying migrated_to+deactivated together), which ' +
      `the snapshot lane never provides. Rendered container text: ${rendered}`
    );
  }

  // ---- assertion: the tags are visible ----
  const rankBadges = await rankBadgeTextsVisible(sender, tag);
  if(rankBadges.length === 0) {
    throw new Error(
      `the admin tag "${tag}" set on the participant is not visible anywhere in the supergroup's ` +
      'rendered history (no .bubble-name-rank carries it) — editAdmin never reached ' +
      'channels.editAdmin for this participant (it threw before sending it, see the TypeError ' +
      'assertion above), so the server never persisted the rank in the first place'
    );
  }
});
