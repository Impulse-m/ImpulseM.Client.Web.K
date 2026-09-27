import {afterAll, beforeAll, expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {openMinimalRpcSession} from './rpcDriver';


/*
 * B1 basic-group migration: the tag-edit upgrade path (issue #325).
 *
 * CEO, live: setting an admin tag ("Linsa") in a basic group left TWO broken chats — the old
 * group came back in the list even though it had already migrated, and the new supergroup never
 * carried the tag. `.claude-scratch/migration-synthesis.md` re-derived the causal chain:
 *
 *   1. Upstream Web K upgrades a basic group to a supergroup whenever an admin tag is non-empty
 *      (appChatsManager.ts:824 `canStickToLegacy = !rank && ...`), THEN sends the tag through
 *      channels.editAdmin — migrateChat runs first (appChatsManager.ts:859).
 *   2. migrateChat (appChatsManager.ts:772-789) reads the new channel id off an `updateChannel`
 *      in the `messages.migrateChat` answer (:786-787 `updates.find(u => u._ === 'updateChannel')`,
 *      then `:787 update.channel_id`). The server's migrateChat handler
 *      (MessagesPartialService.cs:1113-1167) never emits `updateChannel`, so `update` is
 *      `undefined` and `.channel_id` throws a bare TypeError — AFTER the migration has already
 *      committed server-side and `onChatUpdated` has already saved both chats
 *      (appChatsManager.ts:785). editAdmin's own `channels.editAdmin` call (:860) is never
 *      reached, so the tag is lost even though the group is now a channel.
 *   3. Every later snapshot read (getDialogs, getChats, getDifference, pushes) rebuilds the old
 *      chat through the server's OTHER mapping lane (ChatMapper.MapToV1 -> ChatWireBuilder),
 *      which sets `deactivated` but deliberately never sets `migrated_to`
 *      (ChatWireBuilder.cs:213-216 "MigratedTo is deliberately not built here"). Both client
 *      reads that matter require BOTH fields together:
 *        - storages/dialogs.ts:1568 `if(chat && chat.migrated_to && chat.pFlags.deactivated)`
 *          gates `dialog.migratedTo` (:1572), which storages/dialogs.ts:514's `skipMigrated`
 *          filter keys off.
 *        - appPeersManager.ts:53-54 `getPeerMigratedTo` requires the same pair before it will
 *          return the new peer at all.
 *      So a chat the server itself calls "deactivated" keeps showing up as a live, writable
 *      dialog on every fresh read, and nothing ever resolves it to the supergroup it became.
 *
 * Asserted on the manager seam (not the DOM) for the same reason as groupManagerOpens.live.test.ts:
 * this is where the rejection and the stale snapshot are produced. Assertion 2 and 3 use a SECOND
 * `bootLiveManagerStack` call over the SAME persisted account — the documented "a second boot in
 * the same test is a page refresh" contract (managerStack.ts) — because the FIRST stack's own
 * chat cache was seeded straight from the migrate answer's own `chats[]`, which is not proof
 * that the snapshot lane (what getDialogs actually re-reads) carries `migrated_to` too. Only a
 * fresh read exercises the lane the bug lives on.
 *
 * The new channel's id is recovered independently of editAdmin's own (broken) return value, via
 * the `chat_update` event `saveApiChats` fires for every chat in an answer's `chats[]`
 * (appChatsManager.ts:289) — so assertions 2 and 3 do not depend on assertion 1 having a green
 * outcome to know which channel the group became.
 */
const bootTimeoutMs = 180_000;
const itTimeoutMs = 60_000;

const adminRights: any = {
  _: 'chatAdminRights',
  pFlags: {change_info: true, invite_users: true}
};


describeLive('B1 basic-group migration: the tag-edit upgrade path leaves the group reachable and the old chat gone (issue #325)', () => {
  const rejections = new UnhandledRejectionGuard();

  const ownerPersona = ephemeralPersona('BasicGroupMigrationOwner');
  const participantPersona = ephemeralPersona('BasicGroupMigrationParticipant');

  let stack1: LiveStack | undefined;
  let stack2: LiveStack | undefined;
  let oldChatId: ChatId | undefined;
  let newChannelId: ChatId | undefined;
  let editAdminResult: ChatId | undefined;
  let editAdminError: unknown;
  let foldersDialogsAfterReload: Array<{peerId: PeerId}> | undefined;
  let migratedToAfterReload: PeerId | undefined;

  beforeAll(async() => {
    rejections.install();

    // ---- step 1: the owner's real manager stack, the participant as a raw RPC identity ----
    stack1 = await bootLiveManagerStack(liveLane.gatewayOrigin);
    await signInHeadless(stack1, ownerPersona);

    const participantSession = await openMinimalRpcSession(liveLane.gatewayOrigin, participantPersona);
    const participantUser = await stack1.managers.appUsersManager.resolvePhone(participantPersona.phone);
    expect(
      String(participantUser?.id ?? ''),
      'contacts.resolvePhone through the owner\'s manager must resolve the participant persona — ' +
      'without it there is no second member to make an admin'
    ).toBe(participantSession.userId);

    // ---- step 2: a basic group with the owner and the participant ----
    const title = `BasicGroupMigration-${Date.now()}`;
    const created = await stack1.managers.appChatsManager.createChat(title, [participantUser.id]);
    oldChatId = created.chatId;

    // ---- step 3: the upstream trigger — a non-empty rank forces the upgrade path ----
    // (appChatsManager.ts:824 canStickToLegacy = !rank && ...; rank='tag' makes it false
    // regardless of the rights payload, so this is the exact branch the CEO's edit took.)
    const touchedChatIds = new Set<ChatId>();
    const chatUpdateListener = (chatId: ChatId) => touchedChatIds.add(chatId);
    stack1.managers.rootScope.addEventListener('chat_update', chatUpdateListener);

    try {
      editAdminResult = await stack1.managers.appChatsManager.editAdmin(
        oldChatId,
        participantUser.id as unknown as PeerId,
        adminRights,
        'tag'
      );
    } catch(error) {
      editAdminError = error;
    } finally {
      stack1.managers.rootScope.removeEventListener('chat_update', chatUpdateListener);
    }

    // Ground truth for the new channel id: whichever touched chat is NOT the old basic group and
    // is now a channel. Independent of editAdmin's own (possibly-thrown) return value.
    for(const candidateId of touchedChatIds) {
      if(candidateId === oldChatId) {
        continue;
      }

      const candidate = await stack1.managers.appChatsManager.getChat(candidateId);
      if(candidate?._ === 'channel') {
        newChannelId = candidateId;
        break;
      }
    }

    // ---- step 4: reload — a SECOND stack over the SAME persisted account, no re-sign-in ----
    stack2 = await bootLiveManagerStack(liveLane.gatewayOrigin);
    expect(
      stack2.userIdAtBoot,
      'the reload boot must find the owner\'s persisted account — booting logged-out would ' +
      'measure a fresh account\'s empty dialog list instead of the just-migrated one'
    ).toBe(stack1.userIdAtBoot);

    const {FOLDER_ID_ALL} = await import('@appManagers/constants');
    await stack2.managers.dialogsStorage.getDialogs({filterId: FOLDER_ID_ALL, skipMigrated: true, limit: 50});

    foldersDialogsAfterReload = await stack2.managers.dialogsStorage.getFolderDialogs(FOLDER_ID_ALL, true);
    migratedToAfterReload = oldChatId !== undefined ?
      await stack2.managers.appPeersManager.getPeerMigratedTo((oldChatId as ChatId).toPeerId(true)) :
      undefined;

    console.log('[liveharness] basic-group migration evidence:', JSON.stringify({
      oldChatId,
      newChannelId,
      editAdminResult,
      editAdminError: editAdminError instanceof Error ?
        {message: editAdminError.message, name: editAdminError.name} :
        editAdminError,
      foldersDialogsAfterReloadPeerIds: foldersDialogsAfterReload?.map((d: any) => d.peerId),
      migratedToAfterReload
    }));
  }, bootTimeoutMs);

  afterAll(async() => {
    rejections.uninstall();
    await stack1?.dispose?.();
    await stack2?.dispose?.();
  }, bootTimeoutMs);

  it('precondition: the migration committed server-side — a new channel chat was touched by the edit-admin attempt', () => {
    expect(
      newChannelId,
      'no chat_update fired for a chat other than the old basic group during editAdmin — the ' +
      'server never migrated the group at all, so assertions 1-3 below have nothing to check. ' +
      `Touched ids and outcome: ${JSON.stringify({oldChatId, editAdminError: describeRejection(editAdminError)})}`
    ).not.toBeUndefined();
  }, itTimeoutMs);

  it('assertion 1: appChatsManager.editAdmin(chat, participant, rights, \'tag\') resolves to the new channel id', () => {
    expect(
      editAdminError,
      'editAdmin(..., \'tag\') must resolve once the tag reaches the server, the same as it does ' +
      'upstream against real Telegram. It rejects here because migrateChat ' +
      '(appChatsManager.ts:786-787) reads updates.updates.find(u => u._ === \'updateChannel\') ' +
      'and the messages.migrateChat answer never contains one (MessagesPartialService.cs:1113-1167 ' +
      'builds only UpdateNewMessage/UpdateNewChannelMessage and the two chats), so `.channel_id` ' +
      `is read off undefined. Caught: ${describeRejection(editAdminError)}`
    ).toBeUndefined();
    expect(
      editAdminResult,
      'editAdmin must resolve to the NEW channel id (the group that migrateChat produced), not ' +
      `the old basic-group id or undefined. newChannelId (ground truth): ${newChannelId}`
    ).toBe(newChannelId);
  }, itTimeoutMs);

  it('assertion 2: the folder dialogs (skipMigrated) lack the old peer on a fresh manager stack', () => {
    const oldPeerId = oldChatId !== undefined ? (oldChatId as ChatId).toPeerId(true) : undefined;
    const stillListed = foldersDialogsAfterReload?.some((dialog) => dialog.peerId === oldPeerId);

    expect(
      stillListed,
      'the old basic group is still in the main folder\'s dialog list (with skipMigrated=true) ' +
      'after a fresh boot re-read getDialogs from the server. dialogsStorage only sets ' +
      'dialog.migratedTo (the field getFolderDialogs:514 filters on) when the chat carries BOTH ' +
      '`migrated_to` AND `pFlags.deactivated` (storages/dialogs.ts:1568) — the snapshot lane sets ' +
      'only `deactivated`, so a chat the server itself calls migrated never leaves the list. ' +
      `Dialog peerIds after reload: ${JSON.stringify(foldersDialogsAfterReload?.map((d) => d.peerId))}; ` +
      `old peerId: ${oldPeerId}`
    ).toBe(false);
  }, itTimeoutMs);

  it('assertion 3: appPeersManager.getPeerMigratedTo(old) equals the new channel after getDialogs', () => {
    const expectedPeerId = newChannelId !== undefined ? (newChannelId as ChatId).toPeerId(true) : undefined;

    expect(
      migratedToAfterReload,
      'getPeerMigratedTo(old) must resolve to the new supergroup once the fresh stack has re-read ' +
      'the chat from the server (appPeersManager.ts:53-54 requires BOTH chat.migrated_to and ' +
      'pFlags.deactivated). The snapshot lane never sets migrated_to (ChatWireBuilder.cs:213-216, ' +
      '"MigratedTo is deliberately not built here"), so this stays undefined and every caller that ' +
      'redirects through it (forwarding, sending, opening the old peer) keeps addressing a dead ' +
      `chat. Expected peerId: ${expectedPeerId}; got: ${migratedToAfterReload}`
    ).toBe(expectedPeerId);
  }, itTimeoutMs);

  it('standing invariant: no unhandled rejections across the migration scenario', () => {
    rejections.assertNone('basic-group migration scenario');
  }, itTimeoutMs);
});


function describeRejection(reason: unknown): string {
  if(reason && typeof reason === 'object') {
    const err = reason as {type?: string, message?: string, name?: string, stack?: string};
    return err.type || `${err.name ?? 'Error'}: ${err.message ?? JSON.stringify(reason)}`;
  }

  return String(reason);
}
