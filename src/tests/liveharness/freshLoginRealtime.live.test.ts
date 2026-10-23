import {afterAll, beforeAll, expect, it} from 'vitest';

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
 * B1 fresh-login realtime — issue #100: the fresh-login realtime hole.
 *
 * THE CONTRACT. apiManager.after() (apiManager.ts:154-167) performs the full realtime
 * bring-up trio — setRealtimeDispatch + startImpulseRealtime + reportImpulseConnected() — but
 * ONLY on the branch where a persisted signed-in account exists at boot. setUserAuth
 * (apiManager.ts:321), the seam every fresh login runs through (setUser -> setUserAuth),
 * calls startImpulseRealtime ALONE. A session that boots with NO persisted account and then
 * signs in — no reload — therefore gets a live, subscribed socket whose every publication
 * dies in handleEnvelope's `!sink` early-out (realtime.ts), and never files
 * ConnectionStatus.Connected. The user of that tab sees nothing live (no incoming messages,
 * no presence, sends stuck on the clock icon), reads "Waiting for network..." forever, and
 * network-gated behavior (hadConnect -> forceGetDifference, the download queue) degrades —
 * until a manual reload flips the session into the persisted-boot branch. The CEO never sees
 * it because his sessions are persisted and he always reloads.
 *
 * The persisted-boot (reload) form is already proven GREEN by
 * presencePushApplied.live.test.ts. THIS scenario pins bring-up PARITY for the fresh-login
 * form, as three facts, each its own test so one run shows the whole pattern:
 *
 *   fact C  realtime STARTED at all (socket + connect ack + subscribe ack) — expected GREEN
 *           today (startImpulseRealtime IS called from setUserAuth); it stands as the
 *           localization control so the red pattern reads "sink + status missing, socket
 *           present", not "nothing was ever started".
 *   fact A  a push driven AFTER the fresh login is APPLIED by the managers — the sink half
 *           of the trio. RED today.
 *   fact B  ConnectionStatus.Connected is FILED under 'NET-' + baseDcId — the exact key
 *           ConnectionStatusComponent reads (connectionStatus.ts:101) — the status half of
 *           the trio. RED today.
 *
 * A negative control then reboots over the now-persisted storage and requires the same three
 * facts on the reload form — so a fix cannot go green here by breaking the path the CEO's
 * sessions rely on. Its driven act is the OFFLINE transition, deliberately — see the
 * debounce note at the drive site. Standing B1 invariants close the file.
 */
const subscribeTimeoutMs = 60_000;
const syncSettleTimeoutMs = 60_000;
const presenceTimeoutMs = 45_000;
const connectedFilingTimeoutMs = 15_000;

type UserUpdateEvent = {
  userId: any,
  atMs: number,
  /** The stored status of that user AT THE MOMENT the event dispatched — see the capture note. */
  statusName: string | undefined,
  status: any
};

type AppliedStatus = {
  status: any,
  matchedAtMs: number
};


describeLive('B1 fresh-login realtime: a session signed in THIS boot (no persisted account, no reload) must get the same realtime bring-up as a persisted boot (issue #100)', () => {
  const rejections = new UnhandledRejectionGuard();
  const freshWire = new RealtimeWireObserver();
  const reloadWire = new RealtimeWireObserver();

  const viewerPersona = ephemeralPersona('FreshLoginViewer');
  const ownerPersona = ephemeralPersona('FreshLoginOwner');

  let stack1: LiveStack | undefined;
  let stack2: LiveStack | undefined;
  let owner: MinimalRpcSession | undefined;
  let viewerKey = '';
  let ownerKey = '';
  let ownerRawId: any;
  let inboxChannel = '';
  let scenarioStartUnix = 0;
  let syncSettled = false;
  let onlineActionStartMs = 0;
  let onlineApplied: AppliedStatus | undefined;
  const presenceDeliveries: PresenceDelivery[] = [];
  const userUpdateEvents: UserUpdateEvent[] = [];

  beforeAll(async() => {
    rejections.install();
    scenarioStartUnix = Math.floor(Date.now() / 1000);

    // ---- step 1: a boot that finds NO persisted account — the branch after() early-outs of ----
    // The wire observer must ride the boot hook: installNodeEnv overwrites globalThis.WebSocket
    // on every boot, and the socket under test is opened MID-SIGN-IN by setUserAuth.
    stack1 = await bootLiveManagerStack(liveLane.gatewayOrigin, {
      afterEnvInstalled: () => freshWire.install()
    });
    expect(
      stack1.userIdAtBoot,
      'pristine-storage precondition: this scenario is DEFINED over a boot with no persisted ' +
      'account (each vitest file runs in its own forked process, so storage starts empty). A ' +
      'userId found at boot means state leaked into this process and the scenario would silently ' +
      'measure the already-green persisted-boot form instead of the fresh-login form'
    ).toBeUndefined();

    // ---- step 2: sign in through the real auth path, in the SAME module graph — no reload ----
    // signInHeadless ends in apiManager.setUser -> setUserAuth: the exact production fresh-login
    // seam under test. Every fact below is measured on this graph.
    const {userId: signedInUserId} = await signInHeadless(stack1, viewerPersona);
    viewerKey = String(signedInUserId);
    inboxChannel = `user:${viewerKey}`;

    tapPresenceDeliveries(stack1.managers.apiUpdatesManager, presenceDeliveries);
    // Status is captured INSIDE the event dispatch, not polled from storage afterwards.
    // 'user_update' is dispatched synchronously by the updateUserStatus handler right after
    // the storage write — so the capture IS the application moment. Polling later is racy
    // against issue #101: Sync hydrates the users[] of every durable update with status:null
    // (UpdateDispatcher.cs:790 -> UserMapper.Map), and the client's saveApiUser replaces the
    // stored user wholesale, deleting keys absent from the payload — a trailing hydrated
    // update about the owner (e.g. the contact-flow fan-out arriving late) wipes a
    // just-applied status within a millisecond. THIS scenario pins bring-up APPLICATION;
    // status durability against #101 is that issue's own contract, not this file's.
    stack1.managers.rootScope.addEventListener('user_update', (userId: any) => {
      const status = stack1!.managers.appUsersManager.getUser(userId)?.status;
      userUpdateEvents.push({userId, atMs: Date.now(), statusName: status?._, status});
    });
    stack1.managers.apiUpdatesManager.attach();

    // ---- step 3: the counterparty and the mutual-contact edge (the fan-out audience) ----
    owner = await openMinimalRpcSession(liveLane.gatewayOrigin, ownerPersona);
    ownerKey = owner.userId;

    const ownerUser = await stack1.managers.appUsersManager.resolvePhone(ownerPersona.phone);
    expect(
      String(ownerUser?.id ?? ''),
      'contacts.resolvePhone through the manager must resolve the owner persona — without the ' +
      'resolved user the add-contact flow (and this whole scenario) has nobody to point at'
    ).toBe(ownerKey);
    ownerRawId = ownerUser.id;
    await stack1.managers.appUsersManager.addContact(
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

    // Baseline pin: the owner's LAST setup action is "offline", and the contacts fill refreshes
    // the viewer's stored owner (saveApiUser replaces the object wholesale), so the online leg
    // below asserts a real transition, not leftover registration activity.
    await owner.invoke('account.updateStatus', {offline: true});
    const contactIds: any[] = await stack1.managers.appUsersManager.getContacts();
    expect(
      contactIds.map((id) => String(id)),
      'contacts.getContacts on the freshly-signed-in viewer must list the owner — the mutual-' +
      'contact edge just built is the audience the presence fan-out is defined over; without it ' +
      'every hop downstream is legitimately silent'
    ).toContain(ownerKey);
    const hydratedOwner = stack1.managers.appUsersManager.getUser(ownerRawId);
    expect(
      Boolean(hydratedOwner),
      'the owner user object must be in the viewer\'s users storage after the contacts fill — ' +
      'appUsersManager silently drops updateUserStatus for users it does not know, so this ' +
      'absence alone would blind the whole presence lane'
    ).toBe(true);
    expect(
      hydratedOwner?.status?._,
      'the owner declared offline=true as their last setup action, so the hydrated baseline must ' +
      'not be userStatusOnline — an online baseline would make the online-leg transition ' +
      'unprovable (and would itself violate account.updateStatus canon)'
    ).not.toBe('userStatusOnline');

    // ---- step 4: readiness evidence, then the driven push (recorded, asserted in the facts) ----
    // A one-shot push fans out ONCE; the subscribe ack is the only non-racing readiness sign.
    // The waits are bounded and CAUGHT: beforeAll collects evidence, each fact test passes its
    // own verdict on it — so one run shows the whole red pattern, not just the first failure.
    await waitUntil(
      () => freshWire.hasSubscribeAck(inboxChannel) ? true : undefined,
      subscribeTimeoutMs,
      `the fresh-login session's realtime lane to subscribe to its user-inbox channel (${inboxChannel})`
    ).catch((): undefined => undefined);

    const updatesState = (stack1.managers.apiUpdatesManager as any).updatesState;
    syncSettled = await waitUntil(
      () => {
        const ranSync = stack1!.wire.records.some((record) => {
          return record.method === 'updates.getDifference' || record.method === 'updates.getState';
        });
        return ranSync && updatesState.syncLoading === null ? true : undefined;
      },
      syncSettleTimeoutMs,
      'the freshly-signed-in viewer finishing its updates sync (getState/getDifference settled)'
    ).then(() => true).catch(() => false);

    onlineActionStartMs = Date.now();
    await owner.invoke('account.updateStatus', {offline: false});

    onlineApplied = await waitUntil(
      () => {
        const applied = userUpdateEvents.find((event) => {
          return String(event.userId) === ownerKey &&
            event.atMs >= onlineActionStartMs &&
            event.statusName === 'userStatusOnline';
        });
        return applied ? {status: applied.status, matchedAtMs: applied.atMs} : undefined;
      },
      presenceTimeoutMs,
      'a \'user_update\'-captured application of userStatusOnline for the owner on the fresh-login session'
    ).catch((): undefined => undefined);

    console.log('[liveharness] fresh-login evidence:', JSON.stringify({
      viewerUserId: viewerKey,
      ownerUserId: ownerKey,
      inboxChannel,
      wire: freshWire.describeWire(inboxChannel),
      syncSettled,
      onlineApplied: Boolean(onlineApplied),
      presenceDeliveries
    }));
  }, 300_000);

  afterAll(async() => {
    rejections.uninstall();
    freshWire.uninstall();
    reloadWire.uninstall();
    await stack1?.dispose();
    await stack2?.dispose();
  }, 60_000);

  it('fact C (localization control): the fresh-login session STARTS realtime at all — socket opened, connect acked, user-inbox subscribe acked', () => {
    expect(
      freshWire.socketsOpened,
      'the fresh-login session never opened a realtime WebSocket — startImpulseRealtime ' +
      '(called from setUserAuth, apiManager.ts:330) did not even establish a socket, so the hole ' +
      'is wider than the missing sink/status halves this scenario pins. ' +
      `Wire evidence: ${freshWire.describeWire(inboxChannel)}`
    ).toBeGreaterThan(0);
    expect(
      freshWire.connectAcks,
      'the fresh-login session opened a socket but Centrifugo never acked the connect — the ' +
      'push lane died during connect (token minting / proxy auth), upstream of the sink and ' +
      `status halves this scenario pins. Wire evidence: ${freshWire.describeWire(inboxChannel)}`
    ).toBeGreaterThan(0);
    expect(
      freshWire.hasSubscribeAck(inboxChannel),
      `the fresh-login session never got a subscribe ack on its user-inbox channel (${inboxChannel}) — ` +
      'a connected socket carrying no subscription delivers nothing, so every downstream fact is ' +
      `legitimately silent. Wire evidence: ${freshWire.describeWire(inboxChannel)}`
    ).toBe(true);
  }, 60_000);

  it('fact A: a push driven after the fresh login is APPLIED by the managers — the missing setRealtimeDispatch half of the bring-up trio', async() => {
    if(!onlineApplied) {
      let verdict = await diagnosePresenceHop({
        stack: stack1!,
        wire: freshWire,
        deliveries: presenceDeliveries,
        inboxChannel,
        ownerKey,
        ownerRawId,
        expectedStatusName: 'userStatusOnline',
        actionStartMs: onlineActionStartMs,
        leg: 'FRESH-LOGIN online leg',
        timeoutMs: presenceTimeoutMs,
        headline: 'in the real client a tab that just signed in (no reload) renders NOTHING live: ' +
          'no incoming messages, no presence, sends stuck on the clock icon, until the user ' +
          'happens to reload',
        sinkNote: 'FRESH-LOGIN SPECIFIC (issue #100): apiManager.after() (apiManager.ts:154-167) ' +
          'registers the sink only on its persisted-account branch, and setUserAuth ' +
          '(apiManager.ts:321) starts the socket WITHOUT one — the bring-up trio must run for ' +
          'BOTH paths'
      });
      if(!syncSettled) {
        verdict += ' [context: the updates sync (getState/getDifference) also never settled on ' +
          'this fresh session — if sink evidence IS present above, the update may be parked ' +
          'behind syncLoading instead]';
      }

      expect(onlineApplied, verdict).toBeDefined();
    }

    // Green path (post-fix): the applied status must be shaped right and PROVENANCED to the
    // push lane, or a pull-path coincidence could fake the parity this scenario pins.
    const onlineMatchedAtUnix = Math.floor(onlineApplied!.matchedAtMs / 1000);
    const expires = onlineApplied!.status.expires;
    expect(
      typeof expires === 'number' && expires > onlineMatchedAtUnix,
      `userStatusOnline.expires ("${String(expires)}") must be a strictly future unix time at the ` +
      `moment of application (${onlineMatchedAtUnix}) — a stale or missing expires renders the peer ` +
      'as already-offline the instant the client evaluates it'
    ).toBe(true);

    const onlineEnvelopes = freshWire.publicationsOn(inboxChannel)
      .filter((record) => record.receivedAtMs >= onlineActionStartMs);
    const onlineDecode = await decodePresenceEnvelopes(onlineEnvelopes, ownerKey);
    expect(
      onlineDecode.matches.some((match) => match.statusName === 'userStatusOnline'),
      'the applied userStatusOnline must be backed by a decodable presence envelope on the ' +
      'fresh-login session\'s own websocket — otherwise this green does not prove the push lane. ' +
      `Decode notes: ${onlineDecode.notes.join(' | ') || 'none'}; wire: ${freshWire.describeWire(inboxChannel)}`
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
  }, 60_000);

  it('fact B: ConnectionStatus.Connected is FILED under \'NET-\' + baseDcId — the missing reportImpulseConnected half of the bring-up trio', async() => {
    const {ConnectionStatus} = await import('@lib/mtproto/connectionStatus');
    const App = (await import('@config/app')).default;

    // The exact lookup ConnectionStatusComponent performs (connectionStatus.ts:101):
    // getBaseDcId, App.baseDcId fallback, then connectionStatus['NET-' + baseDcId].
    const baseDcIdRaw = await stack1!.managers.apiManager.getBaseDcId();
    const statusKey = 'NET-' + (baseDcIdRaw || App.baseDcId);

    const filed = await waitUntil(
      () => {
        const statuses = stack1!.managers.rootScope.getConnectionStatus();
        const record = statuses[statusKey];
        return record?.status === ConnectionStatus.Connected ? record : undefined;
      },
      connectedFilingTimeoutMs,
      `ConnectionStatus.Connected to be filed under '${statusKey}'`
    ).catch((): undefined => undefined);

    const statuses = stack1!.managers.rootScope.getConnectionStatus();
    expect(
      filed,
      `the fresh-login session never filed ConnectionStatus.Connected under '${statusKey}' — the ` +
      'exact key ConnectionStatusComponent reads (connectionStatus.ts:101: connectionStatus[\'NET-\' ' +
      '+ baseDcId]). reportImpulseConnected() runs only on apiManager.after()\'s persisted-account ' +
      'branch; setUserAuth (fresh login) never calls it, so nothing ever dispatches ' +
      'connection_status_change for this session. In the real client the header sits on "Waiting ' +
      'for network..." for the life of the tab, hadConnect never arms, and a reconnect never runs ' +
      `forceGetDifference. Keys actually filed: [${Object.keys(statuses).join(', ') || 'none'}]`
    ).toBeDefined();
  }, 60_000);

  it('negative control: after a reload over the now-persisted account the same three facts hold — the proven-green form must survive any fix', async() => {
    const persistedAccount = await stack1!.helpers.accountController.get(1);
    expect(
      Boolean(persistedAccount?.impulse_session_token && persistedAccount?.userId),
      'the signed-in session must be persisted before the reload boot — without it the control ' +
      'boots logged out and guards nothing'
    ).toBe(true);

    await stack1!.dispose();
    stack2 = await bootLiveManagerStack(liveLane.gatewayOrigin, {
      afterEnvInstalled: () => reloadWire.install()
    });
    expect(
      String(stack2.userIdAtBoot ?? ''),
      'the reload boot must find the persisted viewer account — booting logged-out after a ' +
      'refresh is a session-persistence loss, not a bring-up-parity loss'
    ).toBe(viewerKey);

    const controlDeliveries: PresenceDelivery[] = [];
    tapPresenceDeliveries(stack2.managers.apiUpdatesManager, controlDeliveries);
    const controlUserUpdates: UserUpdateEvent[] = [];
    // Application-time capture, same rationale as the fresh leg (issue #101).
    stack2.managers.rootScope.addEventListener('user_update', (userId: any) => {
      const status = stack2!.managers.appUsersManager.getUser(userId)?.status;
      controlUserUpdates.push({userId, atMs: Date.now(), statusName: status?._, status});
    });
    stack2.managers.apiUpdatesManager.attach();

    // Fact C on the reload form (throwing waits: this form was proven green before the fix).
    await waitUntil(
      () => reloadWire.hasSubscribeAck(inboxChannel) ? true : undefined,
      subscribeTimeoutMs,
      `the reloaded session's realtime lane to subscribe to its user-inbox channel (${inboxChannel})`
    ).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} — regression: the persisted-boot ` +
        'bring-up (apiManager.after() restore branch) no longer arms the push lane. Wire evidence: ' +
        reloadWire.describeWire(inboxChannel)
      );
    });
    expect(
      reloadWire.connectAcks,
      'regression: the reloaded session subscribed without a recorded connect ack — the reload ' +
      `control cannot certify the persisted path. Wire evidence: ${reloadWire.describeWire(inboxChannel)}`
    ).toBeGreaterThan(0);

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

    const contactIds: any[] = await stack2.managers.appUsersManager.getContacts();
    expect(
      contactIds.map((id) => String(id)),
      'contacts.getContacts on the reloaded viewer must list the owner — without the hydrated ' +
      'audience the control leg downstream is legitimately silent'
    ).toContain(ownerKey);
    const controlOwnerRawId = contactIds.find((id) => String(id) === ownerKey);
    expect(
      Boolean(stack2.managers.appUsersManager.getUser(controlOwnerRawId)),
      'the owner user object must be in the reloaded viewer\'s users storage after the contacts ' +
      'fill — appUsersManager silently drops updateUserStatus for users it does not know'
    ).toBe(true);
    // No baseline-status precondition on purpose: getContacts hydrates a lastOnlineAt-derived
    // userStatusOffline (UserGrpcService.MapToProtoUser), never the live Redis online state, so
    // the hydrated baseline says nothing about the owner's actual state after the fresh leg.
    // The transition proof is the CAPTURED application event below: recorded at dispatch time
    // and gated on atMs >= actionStartMs, it can only come from the driven push.

    // Fact B on the reload form.
    const {ConnectionStatus} = await import('@lib/mtproto/connectionStatus');
    const App = (await import('@config/app')).default;
    const baseDcIdRaw = await stack2.managers.apiManager.getBaseDcId();
    const statusKey = 'NET-' + (baseDcIdRaw || App.baseDcId);
    const filed = await waitUntil(
      () => {
        const statuses = stack2!.managers.rootScope.getConnectionStatus();
        const record = statuses[statusKey];
        return record?.status === ConnectionStatus.Connected ? record : undefined;
      },
      connectedFilingTimeoutMs,
      `ConnectionStatus.Connected to be filed under '${statusKey}' on the reloaded session`
    ).catch((): undefined => undefined);
    expect(
      filed,
      `regression: the reloaded (persisted-boot) session no longer files ConnectionStatus.Connected ` +
      `under '${statusKey}' — reportImpulseConnected() was working on this branch before the ` +
      'fresh-login fix; a fix must ADD the trio to the fresh path, not move it'
    ).toBeDefined();

    // Fact A on the reload form — driven as the OFFLINE transition, deliberately. The server
    // debounces presence per-target per-statusKey (UpdateDispatcher.TryRecordPresence within
    // PresenceOptions.DebounceWindow), and the online statusKey is the CONSTANT 'online': a
    // second online drive landing near an earlier online publish for the same target is
    // suppressed server-side BY DESIGN, so an online-driving control raced the fresh leg's own
    // online act and intermittently saw no envelope at all (a 45s delivery timeout with facts
    // A/B/C green). The offline statusKey embeds the transition time ('offline:{WasOnline}'),
    // so an offline drive is never a debounce repeat of anything this scenario drove before —
    // and the fresh leg's online state is exactly the baseline that makes it a real transition.
    const actionStartMs = Date.now();
    await owner!.invoke('account.updateStatus', {offline: true});
    let applied: AppliedStatus | undefined;
    try {
      applied = await waitUntil(
        () => {
          const captured = controlUserUpdates.find((event) => {
            return String(event.userId) === ownerKey &&
              event.atMs >= actionStartMs &&
              event.statusName === 'userStatusOffline';
          });
          return captured ? {status: captured.status, matchedAtMs: captured.atMs} : undefined;
        },
        presenceTimeoutMs,
        'a \'user_update\'-captured application of userStatusOffline for the owner on the reloaded session'
      );
    } catch{
      // Timed out — the ladder below names the dying hop.
    }

    if(!applied) {
      const verdict = await diagnosePresenceHop({
        stack: stack2,
        wire: reloadWire,
        deliveries: controlDeliveries,
        inboxChannel,
        ownerKey,
        ownerRawId: controlOwnerRawId,
        expectedStatusName: 'userStatusOffline',
        actionStartMs,
        leg: 'RELOAD control leg',
        timeoutMs: presenceTimeoutMs,
        headline: 'regression: the persisted-boot form was proven green before the fresh-login ' +
          'fix — a red here means the fix broke the path every steady-state (CEO) session rides'
      });
      expect(applied, verdict).toBeDefined();
    }

    const offlineMatchedAtUnix = Math.floor(applied!.matchedAtMs / 1000);
    const wasOnline = applied!.status.was_online;
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
  }, 300_000);

  it('standing invariants: clean wire and zero unhandled rejections across both boots', async() => {
    // Close the known post-auth rejection window deterministically (see the round-note
    // scenario): each boot arms the 5s greeting-sticker preload, whose chain carries no
    // rejection handler; wait for its own wire action, then drain.
    await waitUntil(
      () => {
        const firstRan = stack1!.wire.records.some((record) => record.method === 'messages.getStickers');
        const secondRan = stack2 ? stack2.wire.records.some((record) => record.method === 'messages.getStickers') : true;
        return firstRan && secondRan ? true : undefined;
      },
      30_000,
      'each booted stack\'s greeting-sticker preload (messages.getStickers, armed 5s after user_auth) to reach the wire'
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750);
    });

    stack1!.wire.assertClean('fresh-login session (sign-in, mutual-contact setup, push leg)');
    stack2?.wire.assertClean('reload control session (push lane, sync, contacts fill)');
    rejections.assertNone('the whole fresh-login realtime scenario');
  }, 60_000);
});
