import {expect, it} from 'vitest';

import {signInHeadless} from './authFlow';
import {UnhandledRejectionGuard} from './invariants';
import {describeLive, liveLane} from './liveGate';
import {bootLiveManagerStack, LiveStack} from './managerStack';
import {ephemeralPersona} from './personas';
import {decodePresenceEnvelopes, diagnosePresenceHop, PresenceDelivery, tapPresenceDeliveries} from './presenceProbe';
import {RealtimeWireObserver} from './realtimeWire';
import {MinimalRpcSession, openMinimalRpcSession} from './rpcDriver';
import {waitUntil} from './wait';


/*
 * B1 presence scenario — the last unproven hop of the online-status loss.
 *
 * The live bug: two MUTUAL CONTACTS (zero privacy rows) never see each other online in the
 * real web client. The C# canon scenario (OnlineStatusPresenceCanonScenario) has proven the
 * SERVER side green on the fresh stack: account.updateStatus fans updateUserStatus out to the
 * contact viewer's user-inbox channel, field-correct, both lanes. What no lane has ever
 * proven is the WEB CLIENT's own consumption of that push:
 *
 *   Centrifugo envelope -> realtime.ts decode (UpdatesSchema, protoToTL) -> sink ->
 *   apiUpdatesManager.processUpdateMessage -> appUsersManager updateUserStatus handler ->
 *   'user_update' + users storage.
 *
 * This scenario drives that pipeline end to end on the REAL managers:
 *   - the viewer is a full manager stack booted the way the CEO's steady-state session boots
 *     (signed in, then a page-refresh boot over the persisted account — the shape in which
 *     apiManager.after() registers the realtime sink and starts the push channel);
 *   - the owner is a second minimal RPC session (the manager graph is a process singleton,
 *     so the counterparty acts through ./rpcDriver.ts — same wire stages, own identity);
 *   - mutual contacts are made through the app's own flows (appUsersManager.resolvePhone +
 *     appUsersManager.addContact on the viewer; the same RPC pair on the owner), mirroring
 *     the C# cast fixture (contacts.resolvePhone -> contacts.addContact both ways);
 *   - the assert sits at the manager seam: a 'user_update'-keyed bounded wait until
 *     appUsersManager.getUser(owner).status becomes userStatusOnline with a future expires,
 *     then userStatusOffline with a real was_online.
 *
 * GREEN localizes the remaining live loss ABOVE the managers (main-thread rendering / event
 * consumption — B2's territory). RED names the dying hop: the wire observer proves whether
 * the envelope reached the socket, a decode replay through the client's own
 * decodeRealtimeEnvelope proves whether decoding drops it, a processUpdateMessage tap proves
 * whether the sink is wired, and the storage probe proves whether the manager applied it.
 */
const subscribeTimeoutMs = 60_000;
const syncSettleTimeoutMs = 60_000;
const presenceTimeoutMs = 45_000;

type UserUpdateEvent = {
  userId: any,
  atMs: number
};

type AppliedStatus = {
  status: any,
  matchedAtMs: number
};


describeLive('B1 presence: a mutual contact going online/offline must be APPLIED by the viewer\'s manager stack from the push lane', () => {
  it('updateUserStatus pushed to the user-inbox channel becomes userStatusOnline (future expires) then userStatusOffline (real was_online) in appUsersManager', async() => {
    const rejections = new UnhandledRejectionGuard();
    rejections.install();

    const wireObserver = new RealtimeWireObserver();
    let stack1: LiveStack | undefined;
    let stack2: LiveStack | undefined;

    try {
      const scenarioStartUnix = Math.floor(Date.now() / 1000);

      // ---- act 1: identities and the mutual-contact edge, through the app's own flows ----
      stack1 = await bootLiveManagerStack(liveLane.gatewayOrigin);
      const viewerPersona = ephemeralPersona('PresencePushViewer');
      const ownerPersona = ephemeralPersona('PresencePushOwner');
      const {userId: viewerUserId} = await signInHeadless(stack1, viewerPersona);
      const viewerKey = String(viewerUserId);
      stack1.managers.apiUpdatesManager.attach();

      const owner: MinimalRpcSession = await openMinimalRpcSession(liveLane.gatewayOrigin, ownerPersona);
      const ownerKey = owner.userId;

      // Viewer adds the owner exactly as the app does: resolve the phone, then addContact.
      const ownerUser = await stack1.managers.appUsersManager.resolvePhone(ownerPersona.phone);
      expect(
        String(ownerUser?.id ?? ''),
        'contacts.resolvePhone through the manager must resolve the owner persona — without the ' +
        'resolved user the add-contact flow (and this whole scenario) has nobody to point at'
      ).toBe(ownerKey);
      await stack1.managers.appUsersManager.addContact(
        ownerUser.id,
        ownerPersona.firstName,
        ownerPersona.lastName,
        ownerPersona.phone
      );

      // Owner adds the viewer back over the same RPC pair — the edge is now MUTUAL, the exact
      // fixture shape of the green C# server lane (CreateContactCastAsync).
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

      // Pin the baseline: the owner's LAST word before the observed legs is "offline", so the
      // online leg below asserts a real transition, not a leftover of registration activity.
      await owner.invoke('account.updateStatus', {offline: true});

      // Reload-survival prerequisite (same as the round-note scenario): act 2 must boot into
      // the signed-in viewer, or it measures a logged-out client.
      const persistedAccount = await stack1.helpers.accountController.get(1);
      expect(
        Boolean(persistedAccount?.impulse_session_token && persistedAccount?.userId),
        'the signed-in viewer session must be persisted before the reload boot — without it act 2 ' +
        'boots logged out and the push lane is never armed for anyone'
      ).toBe(true);

      // ---- act 2: the viewer's steady-state session — the boot shape the CEO actually runs ----
      // apiManager.after() registers the realtime sink and starts the push channel ONLY when it
      // finds a persisted account at boot; a page-refresh boot over the signed-in state is
      // therefore the faithful (and the armed) wiring. The wire observer must be installed from
      // the boot hook: installNodeEnv overwrites globalThis.WebSocket on every boot.
      await stack1.dispose();
      stack2 = await bootLiveManagerStack(liveLane.gatewayOrigin, {
        afterEnvInstalled: () => wireObserver.install()
      });

      expect(
        String(stack2.userIdAtBoot ?? ''),
        'the reload boot must find the persisted viewer account — booting logged-out after a ' +
        'refresh is a session-persistence loss, not a presence loss'
      ).toBe(viewerKey);

      const presenceDeliveries: PresenceDelivery[] = [];
      tapPresenceDeliveries(stack2.managers.apiUpdatesManager, presenceDeliveries);

      const userUpdateEvents: UserUpdateEvent[] = [];
      stack2.managers.rootScope.addEventListener('user_update', (userId: any) => {
        userUpdateEvents.push({userId, atMs: Date.now()});
      });

      stack2.managers.apiUpdatesManager.attach();

      // Readiness gate 1: the push lane is live — the subscribe ack for the viewer's own
      // user-inbox channel is on the wire. A one-shot push fans out ONCE; acting before this
      // ack would race the subscription and measure nothing.
      const inboxChannel = `user:${viewerKey}`;
      await waitUntil(
        () => wireObserver.hasSubscribeAck(inboxChannel) ? true : undefined,
        subscribeTimeoutMs,
        `the viewer's realtime lane to subscribe to its user-inbox channel (${inboxChannel})`
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — the reload boot never armed ` +
          'the push lane (apiManager.after() -> setRealtimeSink + startImpulseRealtime -> Centrifugo ' +
          `connect/subscribe). Wire evidence: ${wireObserver.describeWire(inboxChannel)}`
        );
      });

      // Readiness gate 2: the updates machinery settled (mirrors the round-note scenario), so
      // an incoming update cannot be parked behind syncLoading.
      const updatesState = (stack2.managers.apiUpdatesManager as any).updatesState;
      await waitUntil(
        () => {
          const ranSync = stack2!.wire.records.some((record) => {
            return record.method === 'updates.getDifference' || record.method === 'updates.getState';
          });
          return ranSync && updatesState.syncLoading === null ? true : undefined;
        },
        syncSettleTimeoutMs,
        'the reloaded viewer finishing its updates sync (getState/getDifference settled)'
      );

      // Precondition the manager pipeline depends on: the owner must exist in the viewer's
      // users storage (the updateUserStatus handler drops updates for unknown users BY DESIGN).
      // The contacts-list fill is the app's own hydration path for exactly that.
      const contactIds: any[] = await stack2.managers.appUsersManager.getContacts();
      expect(
        contactIds.map((id) => String(id)),
        'contacts.getContacts on the reloaded viewer must list the owner — the mutual-contact edge ' +
        'built in act 1 is the audience the presence fan-out is defined over; without it every hop ' +
        'downstream is legitimately silent'
      ).toContain(ownerKey);
      const ownerRawId = contactIds.find((id) => String(id) === ownerKey);
      const hydratedOwner = stack2.managers.appUsersManager.getUser(ownerRawId);
      expect(
        Boolean(hydratedOwner),
        'the owner user object must be in the viewer\'s users storage after the contacts fill — ' +
        'appUsersManager silently drops updateUserStatus for users it does not know, so this absence ' +
        'alone would blind the whole presence lane'
      ).toBe(true);
      expect(
        hydratedOwner?.status?._,
        'the owner declared offline=true as their last act-1 action, so the hydrated baseline must ' +
        'not be userStatusOnline — an online baseline would make the online-leg transition ' +
        'unprovable (and would itself violate account.updateStatus canon)'
      ).not.toBe('userStatusOnline');

      // ---- act 3: the owner goes ONLINE; the viewer must apply it from the push ----
      const onlineActionStartMs = Date.now();
      await owner.invoke('account.updateStatus', {offline: false});

      let onlineApplied: AppliedStatus | undefined;
      try {
        onlineApplied = await waitUntil(
          () => {
            const eventSeen = userUpdateEvents.some((event) => {
              return String(event.userId) === ownerKey && event.atMs >= onlineActionStartMs;
            });
            if(!eventSeen) {
              return undefined;
            }

            const status = stack2!.managers.appUsersManager.getUser(ownerRawId)?.status;
            return status?._ === 'userStatusOnline' ? {status, matchedAtMs: Date.now()} : undefined;
          },
          presenceTimeoutMs,
          "a 'user_update'-keyed application of userStatusOnline for the owner"
        );
      } catch{
        // Timed out — the ladder below names the dying hop.
      }

      if(!onlineApplied) {
        const verdict = await diagnosePresenceHop({
          stack: stack2,
          wire: wireObserver,
          deliveries: presenceDeliveries,
          inboxChannel,
          ownerKey,
          ownerRawId,
          expectedStatusName: 'userStatusOnline',
          actionStartMs: onlineActionStartMs,
          leg: 'ONLINE leg',
          timeoutMs: presenceTimeoutMs,
          headline: "in the real client this is the CEO's bug (the peer never changes online state)"
        });
        expect(onlineApplied, verdict).toBeDefined();
      }

      const onlineMatchedAtUnix = Math.floor(onlineApplied!.matchedAtMs / 1000);
      const expires = onlineApplied!.status.expires;
      expect(
        typeof expires === 'number' && expires > onlineMatchedAtUnix,
        `userStatusOnline.expires ("${String(expires)}") must be a strictly future unix time at the ` +
        `moment of application (${onlineMatchedAtUnix}) — a stale or missing expires renders the peer ` +
        'as already-offline the instant the client evaluates it'
      ).toBe(true);
      expect(
        expires <= onlineMatchedAtUnix + 86_400,
        `userStatusOnline.expires ("${String(expires)}") is more than a day in the future — the shape ` +
        'of a milliseconds-for-seconds mixup, which the UI would render as permanently online'
      ).toBe(true);

      // Provenance: the applied status must have come through the PUSH lane — the wire saw the
      // envelope, the client's own decoder accepts it, and the sink handed it to the manager.
      // Without these three, a green above could be a pull-path coincidence.
      const onlineEnvelopes = wireObserver.publicationsOn(inboxChannel)
        .filter((record) => record.receivedAtMs >= onlineActionStartMs);
      const onlineDecode = await decodePresenceEnvelopes(onlineEnvelopes, ownerKey);
      expect(
        onlineDecode.matches.some((match) => match.statusName === 'userStatusOnline'),
        'the applied userStatusOnline must be backed by a decodable presence envelope on the ' +
        `viewer's own websocket — otherwise this green does not prove the push lane. Decode notes: ` +
        `${onlineDecode.notes.join(' | ') || 'none'}; wire: ${wireObserver.describeWire(inboxChannel)}`
      ).toBe(true);
      expect(
        presenceDeliveries.some((delivery) => {
          return delivery.userId === ownerKey &&
            delivery.statusName === 'userStatusOnline' &&
            delivery.atMs >= onlineActionStartMs;
        }),
        'the applied userStatusOnline must have travelled through apiUpdatesManager.processUpdateMessage ' +
        '(the realtime sink) — otherwise the manager state came from somewhere other than the push lane'
      ).toBe(true);

      // ---- act 4: the owner goes OFFLINE; the viewer must apply was_online ----
      const offlineActionStartMs = Date.now();
      await owner.invoke('account.updateStatus', {offline: true});

      let offlineApplied: AppliedStatus | undefined;
      try {
        offlineApplied = await waitUntil(
          () => {
            const eventSeen = userUpdateEvents.some((event) => {
              return String(event.userId) === ownerKey && event.atMs >= offlineActionStartMs;
            });
            if(!eventSeen) {
              return undefined;
            }

            const status = stack2!.managers.appUsersManager.getUser(ownerRawId)?.status;
            return status?._ === 'userStatusOffline' ? {status, matchedAtMs: Date.now()} : undefined;
          },
          presenceTimeoutMs,
          "a 'user_update'-keyed application of userStatusOffline for the owner"
        );
      } catch{
        // Timed out — the ladder below names the dying hop.
      }

      if(!offlineApplied) {
        const verdict = await diagnosePresenceHop({
          stack: stack2,
          wire: wireObserver,
          deliveries: presenceDeliveries,
          inboxChannel,
          ownerKey,
          ownerRawId,
          expectedStatusName: 'userStatusOffline',
          actionStartMs: offlineActionStartMs,
          leg: 'OFFLINE leg',
          timeoutMs: presenceTimeoutMs,
          headline: "in the real client this is the CEO's bug (the peer never changes online state)"
        });
        expect(offlineApplied, verdict).toBeDefined();
      }

      const offlineMatchedAtUnix = Math.floor(offlineApplied!.matchedAtMs / 1000);
      const wasOnline = offlineApplied!.status.was_online;
      expect(
        typeof wasOnline === 'number' && wasOnline > 0,
        `userStatusOffline.was_online ("${String(wasOnline)}") must be a real last-seen unix time — ` +
        'zero/absent renders "last seen a long time ago" for a contact who was online seconds ago'
      ).toBe(true);
      expect(
        wasOnline >= scenarioStartUnix - 3600 && wasOnline <= offlineMatchedAtUnix + 300,
        `userStatusOffline.was_online ("${String(wasOnline)}") must fall inside this scenario's ` +
        `lifetime (${scenarioStartUnix - 3600}..${offlineMatchedAtUnix + 300}) — a value outside it is ` +
        'epoch garbage or a milliseconds-for-seconds mixup, both of which corrupt "last seen" for the user'
      ).toBe(true);

      console.log('[liveharness] presence push evidence:', JSON.stringify({
        viewerUserId: viewerKey,
        ownerUserId: ownerKey,
        inboxChannel,
        wire: wireObserver.describeWire(inboxChannel),
        presenceDeliveries,
        onlineExpires: expires,
        offlineWasOnline: wasOnline
      }));

      // ---- standing invariants (every B1 scenario asserts these) ----
      // Close the known post-auth rejection window deterministically (see the round-note
      // scenario): both boots arm the 5s greeting-sticker preload, whose chain carries no
      // rejection handler; wait for its own wire action, then drain.
      await waitUntil(
        () => {
          const firstRan = stack1!.wire.records.some((record) => record.method === 'messages.getStickers');
          const secondRan = stack2!.wire.records.some((record) => record.method === 'messages.getStickers');
          return firstRan && secondRan ? true : undefined;
        },
        30_000,
        'both boots\' greeting-sticker preload (messages.getStickers, armed 5s after user_auth) to reach the wire'
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 750);
      });

      stack1.wire.assertClean('viewer sign-in and mutual-contact setup');
      stack2.wire.assertClean('reloaded viewer session (push lane, sync, contacts fill)');
      rejections.assertNone('the whole presence push scenario');
    } finally {
      rejections.uninstall();
      wireObserver.uninstall();
      await stack1?.dispose();
      await stack2?.dispose();
    }
  }, 300_000);
});
