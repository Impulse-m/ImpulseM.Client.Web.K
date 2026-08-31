import {expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {diagnosePresenceHop, PresenceDelivery, tapPresenceDeliveries} from './presenceProbe';
import {RealtimeWireObserver} from './realtimeWire';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';


/*
 * B1 presence durability — the OPEN contract of issue #101 (the status-wipe).
 *
 * THE CONTRACT (user-visible): a presence status the client has APPLIED must survive
 * unrelated durable updates that merely mention the same user. The live story of the
 * violation: a contact is online (the dot renders) — then an unrelated update about them
 * arrives, and the online indicator vanishes.
 *
 * THE MECHANISM (proven in the #101 evidence, red-run log of freshLoginRealtime): Sync
 * hydrates the users[] of durable updates via UserMapper.Map with status:null
 * (UpdateDispatcher.cs:790, UserMapper.cs:15-24) — a FULL-looking user object with no status
 * field — and the client's saveApiUser replaces a known user wholesale (safeReplaceObject
 * deletes keys absent from the payload). The applied status lives until the next such
 * hydration, typically a millisecond. The proven wiper is the contact-edge lane:
 * ContactEventConsumer dispatches updateUser about the peer into the actor's own inbox with
 * the peer hydrated in users[].
 *
 * THE CANON ANCHOR: user.status is flags.6 of the user constructor — an absent field means
 * "not set by the server", never "cleared". Telegram ships update-rider hydrations as MIN
 * users, and neither reference client lets those touch a known user's status:
 *   - tdlib: UserManager::on_get_user applies a received status to an already-received user
 *     only from a non-min payload — `if (is_received || !u->is_received || u->was_online == 0)
 *     on_update_user_online(...)` (.demo/tdlib/td/telegram/UserManager.cpp:3319-3321, where
 *     `is_received = !user->min_`, :3092);
 *   - this fork's own saveApiUser ignores a min payload for a known user ENTIRELY:
 *     `if(user.pFlags.min && oldUser !== undefined) { return; }` (appUsersManager.ts:598-600).
 * The backend sends full-looking, status-less users instead — a shape no canon client is
 * built to survive.
 *
 * THE TRIGGER (deliberate and deterministic): the viewer deletes the owner contact.
 * contacts.deleteContacts -> ContactEdgeChanged(Removed, Owner=viewer, Contact=owner) ->
 * ContactEventConsumer dispatches updateUser about the owner into the viewer's own inbox,
 * and UpdateDispatcher.BuildPushContainerAsync hydrates users[] UNCONDITIONALLY for exactly
 * this update kind (the `ValueCase == UpdateUser` branch) — the only push lane that carries
 * a users[] rider at all, and the same lane the #101 log first proved as the wiper (there it
 * was the trailing add-contact fan-out). updateNewMessage pushes carry NO users[] (live-
 * verified), so a message is NOT a usable trigger; worse, an unknown-dialog message takes
 * the reload-conversation PULL path whose response hydrates the sender WITH a real status —
 * re-populating a just-wiped status and masking the defect, which is why a message-triggered
 * probe of this invariant flip-flopped. Deleting a contact is presence-neutral server-side:
 * no updateUserStatus accompanies it (the personas have zero privacy rows, so status
 * visibility does not change), so any status change the client shows after it is the
 * client's own invention. Live-proven wipe signature: rider {hadStatus:false, isMin:false},
 * stored status userStatusOnline -> <none>.
 *
 * THE ASSERT deliberately pins only the user-visible invariant, because the fix may land on
 * either side: hydrate the real viewer-masked status (GetUsersQuery already has the
 * Redis+privacy machinery), mark hydration riders min (the client's existing guard then
 * protects everything), or stop deleting a known status on absence. Any of the three makes
 * this green.
 *
 * Relationship to the sibling scenarios: freshLoginRealtime and presencePushApplied assert
 * APPLICATION (and deliberately capture at application time to stay immune to this very
 * wipe); THIS scenario asserts DURABILITY and is the red that keeps #101 open.
 */
const subscribeTimeoutMs = 60_000;
const syncSettleTimeoutMs = 60_000;
const presenceTimeoutMs = 45_000;
const triggerTimeoutMs = 45_000;

type UserUpdateCapture = {
  userId: any,
  atMs: number,
  statusName: string | undefined
};

type HydrationSighting = {
  atMs: number,
  hadStatus: boolean,
  statusName: string | undefined,
  isMin: boolean
};

/**
 * Chain-wraps processUpdateMessage to record every users[] hydration entry that mentions the
 * target user — the scalars only, captured BEFORE saveApiUsers can mutate the object. This
 * covers both rider sources: pushed envelopes AND RPC responses the managers feed through
 * the same seam (appUsersManager.deleteContacts does exactly that). It is the premise probe:
 * the contract assert is only meaningful when a hydration rider actually arrived.
 */
function tapHydrationSightings(updatesManager: any, targetKey: string, sightings: HydrationSighting[]): void {
  const original = updatesManager.processUpdateMessage;
  updatesManager.processUpdateMessage = (updateMessage: any, options?: any) => {
    const users = Array.isArray(updateMessage?.users) ? updateMessage.users : [];
    for(const user of users) {
      if(String(user?.id) === targetKey) {
        sightings.push({
          atMs: Date.now(),
          hadStatus: user?.status !== undefined,
          statusName: user?.status?._,
          isMin: Boolean(user?.pFlags?.min)
        });
      }
    }

    return original(updateMessage, options);
  };
}


function survivalVerdict(args: {
  trigger: string,
  statusAfterName: string | undefined,
  statusBeforeName: string | undefined,
  ridersSummary: string,
  presencePushesAfterTrigger: string
}): string {
  return `the owner's applied userStatusOnline did NOT survive ${args.trigger} — appUsersManager now ` +
    `reports status=${args.statusAfterName ?? '<none>'} (right before the trigger it was ` +
    `${args.statusBeforeName ?? '<none>'}). USER STORY: a contact is online, an unrelated update ` +
    'about them arrives — and their online indicator vanishes. MECHANISM (issue #101): Sync ' +
    'hydrates the users[] of durable updates with status:null (UpdateDispatcher.cs:790 -> ' +
    'UserMapper.Map), and saveApiUser replaces a known user wholesale (safeReplaceObject deletes ' +
    'keys absent from the payload). CANON: user.status is flags.6 — absence means "not set", ' +
    'never "cleared"; Telegram ships update-rider hydrations as MIN users and neither reference ' +
    'client lets those touch a known status (tdlib UserManager::on_get_user applies status to an ' +
    'already-received user only from a non-min payload, .demo/tdlib/td/telegram/UserManager.cpp:' +
    '3319-3321; this fork\'s own saveApiUser ignores min payloads for known users, ' +
    'appUsersManager.ts:598-600). The fix may land on either side — hydrate the real ' +
    'viewer-masked status (GetUsersQuery machinery), mark riders min, or stop deleting on ' +
    `absence — this assert pins only the user-visible invariant. Rider evidence: ` +
    `${args.ridersSummary}. updateUserStatus pushes after the trigger (a canon-legit status ` +
    `change would appear here): ${args.presencePushesAfterTrigger}`;
}


describeLive('B1 presence durability: an applied online status must survive a later durable update that merely mentions the user (issue #101)', () => {
  it('the owner goes online (applied); the contact-edge updateUser then rides in with its users[] hydration — it must not wipe the owner\'s userStatusOnline', async() => {
    const rejections = new UnhandledRejectionGuard();
    rejections.install();

    const wireObserver = new RealtimeWireObserver();
    let stack: LiveStack | undefined;

    try {
      // ---- act 1: a signed-in viewer with a live push lane, and the mutual-contact edge ----
      stack = await bootLiveManagerStack(liveLane.gatewayOrigin, {
        afterEnvInstalled: () => wireObserver.install()
      });
      expect(
        stack.userIdAtBoot,
        'pristine-storage precondition: a leaked persona from another test in this process would ' +
        'make this scenario measure somebody else\'s state'
      ).toBeUndefined();

      const viewerPersona = ephemeralPersona('DurabilityViewer');
      const ownerPersona = ephemeralPersona('DurabilityOwner');
      const {userId: viewerUserId} = await signInHeadless(stack, viewerPersona);
      const viewerKey = String(viewerUserId);
      const inboxChannel = `user:${viewerKey}`;

      const owner: MinimalRpcSession = await openMinimalRpcSession(liveLane.gatewayOrigin, ownerPersona);
      const ownerKey = owner.userId;

      const presenceDeliveries: PresenceDelivery[] = [];
      tapPresenceDeliveries(stack.managers.apiUpdatesManager, presenceDeliveries);
      const hydrationSightings: HydrationSighting[] = [];
      tapHydrationSightings(stack.managers.apiUpdatesManager, ownerKey, hydrationSightings);

      // Application-time capture ('user_update' dispatches synchronously right after the
      // status write) — the same wipe this scenario pins makes any later storage poll
      // unreliable as an APPLICATION probe, so application and durability are read at
      // different moments on purpose.
      const userUpdateCaptures: UserUpdateCapture[] = [];
      stack.managers.rootScope.addEventListener('user_update', (userId: any) => {
        const status = stack!.managers.appUsersManager.getUser(userId)?.status;
        userUpdateCaptures.push({userId, atMs: Date.now(), statusName: status?._});
      });

      stack.managers.apiUpdatesManager.attach();

      const ownerUser = await stack.managers.appUsersManager.resolvePhone(ownerPersona.phone);
      expect(
        String(ownerUser?.id ?? ''),
        'contacts.resolvePhone through the manager must resolve the owner persona — without the ' +
        'resolved user this scenario has nobody to point at'
      ).toBe(ownerKey);
      const ownerRawId = ownerUser.id;
      await stack.managers.appUsersManager.addContact(
        ownerUser.id,
        ownerPersona.firstName,
        ownerPersona.lastName,
        ownerPersona.phone
      );

      const resolvedViewer = await owner.invoke('contacts.resolvePhone', {phone: viewerPersona.phone});
      const viewerAsSeenByOwner = (resolvedViewer?.users ?? []).find((user: any) => String(user?.id) === viewerKey);
      expect(
        Boolean(viewerAsSeenByOwner),
        'the owner\'s contacts.resolvePhone must resolve the viewer persona — the mutual edge ' +
        'cannot be built otherwise'
      ).toBe(true);
      await owner.invoke('contacts.addContact', {
        id: {
          _: 'inputUser',
          user_id: viewerAsSeenByOwner.id,
          access_hash: viewerAsSeenByOwner.access_hash
        },
        first_name: viewerPersona.firstName,
        last_name: viewerPersona.lastName,
        phone: viewerPersona.phone
      });

      await owner.invoke('account.updateStatus', {offline: true});
      const contactIds: any[] = await stack.managers.appUsersManager.getContacts();
      expect(
        contactIds.map((id) => String(id)),
        'contacts.getContacts must list the owner — the mutual-contact edge is the audience the ' +
        'presence fan-out is defined over'
      ).toContain(ownerKey);

      await waitUntil(
        () => wireObserver.hasSubscribeAck(inboxChannel) ? true : undefined,
        subscribeTimeoutMs,
        `the viewer's realtime lane to subscribe to its user-inbox channel (${inboxChannel})`
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — the push lane never armed; ` +
          'this is freshLoginRealtime territory (bring-up), not the durability contract. Wire ' +
          `evidence: ${wireObserver.describeWire(inboxChannel)}`
        );
      });

      const updatesState = (stack.managers.apiUpdatesManager as any).updatesState;
      await waitUntil(
        () => {
          const ranSync = stack!.wire.records.some((record) => {
            return record.method === 'updates.getDifference' || record.method === 'updates.getState';
          });
          return ranSync && updatesState.syncLoading === null ? true : undefined;
        },
        syncSettleTimeoutMs,
        'the viewer finishing its updates sync (getState/getDifference settled)'
      );

      // ---- act 2: the owner goes online; the viewer must APPLY it (precondition leg) ----
      const onlineActionStartMs = Date.now();
      await owner.invoke('account.updateStatus', {offline: false});

      const onlineApplied = await waitUntil(
        () => {
          const captured = userUpdateCaptures.find((event) => {
            return String(event.userId) === ownerKey &&
              event.atMs >= onlineActionStartMs &&
              event.statusName === 'userStatusOnline';
          });
          return captured ?? undefined;
        },
        presenceTimeoutMs,
        'a \'user_update\'-captured application of userStatusOnline for the owner'
      ).catch((): undefined => undefined);

      if(!onlineApplied) {
        const verdict = await diagnosePresenceHop({
          stack,
          wire: wireObserver,
          deliveries: presenceDeliveries,
          inboxChannel,
          ownerKey,
          ownerRawId,
          expectedStatusName: 'userStatusOnline',
          actionStartMs: onlineActionStartMs,
          leg: 'PRECONDITION online leg',
          timeoutMs: presenceTimeoutMs,
          headline: 'PRECONDITION failure, not the durability contract: the push lane itself did not ' +
            'apply the status, so the wipe cannot even be exercised — that application contract is ' +
            'owned by freshLoginRealtime/presencePushApplied and was green when this scenario landed'
        });
        expect(onlineApplied, verdict).toBeDefined();
      }

      const presencePushesAfter = (sinceMs: number) => {
        const pushes = presenceDeliveries.filter((delivery) => {
          return delivery.userId === ownerKey && delivery.atMs >= sinceMs;
        });
        return JSON.stringify(pushes.map((push) => push.statusName)) || 'none';
      };

      // ---- THE TRIGGER: the viewer deletes the owner contact (the proven wiper lane) ----
      // See the header for why this is the one deterministic rider-bearing push. The manager
      // flow also feeds the RPC response through processUpdateMessage; the PUSH-borne rider is
      // the one gated on below (a sighting recorded at the tap of the same synchronous
      // processUpdateMessage call that saves the hydration, after the RPC await returned — by
      // the time a poll tick observes it, the save has run).
      const statusBeforeB = stack.managers.appUsersManager.getUser(ownerRawId)?.status?._;
      const triggerBStartMs = Date.now();
      await stack.managers.appUsersManager.deleteContacts([ownerRawId]);
      const triggerBRpcDoneMs = Date.now();

      const ridersB = await waitUntil(
        () => {
          const seen = hydrationSightings.filter((sighting) => sighting.atMs >= triggerBRpcDoneMs);
          return seen.length ? seen : undefined;
        },
        triggerTimeoutMs,
        'the push-borne users[] hydration of the contact-edge updateUser (owner mentioned) to ride ' +
        'into the viewer\'s inbox after contacts.deleteContacts'
      ).catch((): undefined => undefined);
      console.log('[liveharness] durability trigger (contact edge) evidence:', JSON.stringify({
        ridersB,
        ridersBResponseBorne: hydrationSightings.filter((sighting) => {
          return sighting.atMs >= triggerBStartMs && sighting.atMs < triggerBRpcDoneMs;
        }),
        statusBeforeB,
        statusAfterB: stack.managers.appUsersManager.getUser(ownerRawId)?.status?._ ?? null,
        wire: wireObserver.describeWire(inboxChannel)
      }));
      expect(
        ridersB,
        'scenario premise failed: no users[] hydration mentioning the owner arrived ' +
        'after contacts.deleteContacts returned — the contact-edge lane (ContactEventConsumer -> ' +
        'updateUser + hydration, the proven #101 wiper) no longer rides, so the durability ' +
        'contract was not exercised; replace the trigger, do not weaken the assert'
      ).toBeDefined();

      // ---- THE CONTRACT: the applied status survives the proven wiper ----
      const statusAfterB = stack.managers.appUsersManager.getUser(ownerRawId)?.status;
      expect(
        statusAfterB?._,
        survivalVerdict({
          trigger: 'the contact-edge updateUser (contacts.deleteContacts fan-out, the exact lane ' +
            'the #101 log proved as the wiper); deleting a contact is presence-neutral server-side ' +
            '(no updateUserStatus accompanies it)',
          statusAfterName: statusAfterB?._,
          statusBeforeName: statusBeforeB,
          ridersSummary: JSON.stringify(ridersB ?? []),
          presencePushesAfterTrigger: presencePushesAfter(triggerBStartMs)
        })
      ).toBe('userStatusOnline');

      // ---- standing invariants ----
      await waitUntil(
        () => stack!.wire.records.some((record) => record.method === 'messages.getStickers') ? true : undefined,
        30_000,
        'the greeting-sticker preload (messages.getStickers, armed 5s after user_auth) to reach the wire'
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 750);
      });

      stack.wire.assertClean('presence durability scenario (sign-in, contacts, presence, contact delete)');
      rejections.assertNone('the whole presence durability scenario');
    } finally {
      rejections.uninstall();
      wireObserver.uninstall();
      await stack?.dispose();
    }
  }, 300_000);
});
