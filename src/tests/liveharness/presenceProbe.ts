import type {LiveStack} from './managerStack';
import {PublicationRecord, RealtimeWireObserver} from './realtimeWire';


/*
 * Shared presence-push probes for the B1 live lane.
 *
 * Extracted from presencePushApplied.live.test.ts the moment a second scenario
 * (freshLoginRealtime.live.test.ts) needed the same three instruments: the
 * processUpdateMessage tap, the decode replay, and the localization ladder. The ladder walks
 * the push pipeline from the wire inward and names the FIRST hop that has no evidence beyond
 * it — so a timed-out presence wait fails with a verdict, not a number of milliseconds.
 *
 * The pipeline the ladder covers:
 *   Centrifugo envelope -> realtime.ts decode (UpdatesSchema, protoToTL) -> sink ->
 *   apiUpdatesManager.processUpdateMessage -> appUsersManager updateUserStatus handler ->
 *   'user_update' + users storage.
 */
export type PresenceDelivery = {
  userId: string,
  statusName: string | undefined,
  atMs: number
};

export type PresenceDecodeResult = {
  matches: {statusName: string | undefined}[],
  notes: string[]
};


export function tapPresenceDeliveries(updatesManager: any, deliveries: PresenceDelivery[]): void {
  const original = updatesManager.processUpdateMessage;
  updatesManager.processUpdateMessage = (updateMessage: any, options?: any) => {
    const updates = updateMessage?._ === 'updateShort' ?
      [updateMessage.update] :
      (Array.isArray(updateMessage?.updates) ? updateMessage.updates : []);
    for(const update of updates) {
      if(update?._ === 'updateUserStatus') {
        deliveries.push({
          userId: String(update.user_id),
          statusName: update.status?._,
          atMs: Date.now()
        });
      }
    }

    return original(updateMessage, options);
  };
}


/**
 * Replays every captured wire envelope through the client's OWN decoder of the current
 * module graph — the exact code handleEnvelope runs — so "arrived but undecodable" and
 * "arrived and decodes fine" are distinguishable in a verdict without touching production.
 */
// An updateShort carries one update, the others carry a list.
function carriedUpdates(decoded: any): any[] {
  if(decoded._ === 'updateShort') {
    return decoded.update ? [decoded.update] : [];
  }

  return Array.isArray(decoded.updates) ? decoded.updates : [];
}

export async function decodePresenceEnvelopes(
  envelopes: PublicationRecord[],
  ownerKey: string
): Promise<PresenceDecodeResult> {
  const realtime = await import('@lib/impulse/realtime');
  const matches: {statusName: string | undefined}[] = [];
  const notes: string[] = [];

  for(const record of envelopes) {
    let decoded: any;
    try {
      decoded = realtime.decodeRealtimeEnvelope(record.envelope);
    } catch(error) {
      notes.push(`decode threw: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if(!decoded || typeof decoded !== 'object') {
      notes.push(`decode yielded ${String(decoded)} (envelope type=${record.envelope?.type}, ` +
        `data ${typeof record.envelope?.data})`);
      continue;
    }

    const updates: any[] = carriedUpdates(decoded);
    const presence = updates.filter((update: any) => {
      return update?._ === 'updateUserStatus' && String(update.user_id) === ownerKey;
    });
    if(!presence.length) {
      notes.push(`decoded container '${decoded._}' carries [${updates.map((u: any) => u?._).join(', ')}] ` +
        '— no updateUserStatus for the owner');
      continue;
    }

    for(const update of presence) {
      matches.push({statusName: update.status?._});
    }
  }

  return {matches, notes};
}


/**
 * The localization ladder for a presence wait that timed out: walks the pipeline from the
 * wire inward and names the FIRST hop that has no evidence beyond it. The message is the
 * verdict — it must say which hop died and what the user sees because of it.
 *
 * `headline` is the scenario's own user-visible-consequence sentence; `sinkNote` (optional)
 * is appended to the SINK NOT WIRED branch when the scenario knows the specific reason the
 * sink can be missing (e.g. the fresh-login bring-up hole of issue #100).
 */
export async function diagnosePresenceHop(args: {
  stack: LiveStack,
  wire: RealtimeWireObserver,
  deliveries: PresenceDelivery[],
  inboxChannel: string,
  ownerKey: string,
  ownerRawId: any,
  expectedStatusName: string,
  actionStartMs: number,
  leg: string,
  timeoutMs: number,
  headline: string,
  sinkNote?: string
}): Promise<string> {
  const {stack, wire, deliveries, inboxChannel, ownerKey, ownerRawId, expectedStatusName, actionStartMs, leg} = args;
  const prefix = `${leg}: the viewer's manager stack never applied ${expectedStatusName} for the owner ` +
    `within ${args.timeoutMs}ms — ${args.headline}. Dying hop: `;

  if(!wire.hasSubscribeAck(inboxChannel)) {
    return prefix + `the realtime lane is NOT SUBSCRIBED to ${inboxChannel} — nothing downstream ` +
      `could ever fire. Wire evidence: ${wire.describeWire(inboxChannel)}`;
  }

  const envelopes = wire.publicationsOn(inboxChannel).filter((record) => record.receivedAtMs >= actionStartMs);
  if(!envelopes.length) {
    return prefix + 'ENVELOPE NOT ARRIVING — the subscription was acked before the action, yet no ' +
      'publication reached the viewer\'s own websocket after account.updateStatus. The loss is ' +
      'upstream of the web client (server fan-out/audience or channel routing) despite the green ' +
      `C# server lane. Wire evidence: ${wire.describeWire(inboxChannel)}`;
  }

  const {matches, notes} = await decodePresenceEnvelopes(envelopes, ownerKey);
  if(!matches.length) {
    return prefix + `DECODE DROPPING — ${envelopes.length} publication(s) reached the socket after the ` +
      'action, but the client\'s own decodeRealtimeEnvelope (realtime.ts, UpdatesSchema + protoToTL) ' +
      `produced no updateUserStatus for the owner. Decode notes: ${notes.join(' | ') || 'none'}`;
  }

  const applied = deliveries.filter((delivery) => delivery.userId === ownerKey && delivery.atMs >= actionStartMs);
  if(!applied.length) {
    return prefix + 'SINK NOT WIRED — the envelope reached the socket AND decodes to ' +
      `updateUserStatus(${matches.map((m) => m.statusName).join(', ')}), but ` +
      'apiUpdatesManager.processUpdateMessage never received it: the realtime sink is not delivering ' +
      '(setRealtimeDispatch registration in apiManager.after() vs handleEnvelope early-outs), so every ' +
      'push this session is silently discarded' +
      (args.sinkNote ? `. ${args.sinkNote}` : '');
  }

  const ownerInStore = stack.managers.appUsersManager.getUser(ownerRawId);
  return prefix + 'MANAGER NOT APPLYING — processUpdateMessage received ' +
    `updateUserStatus(${applied.map((d) => d.statusName).join(', ')}) yet appUsersManager reports ` +
    `status=${ownerInStore?.status?._ ?? '<none>'} (owner is ${ownerInStore ? 'present' : 'ABSENT'} in ` +
    'the users storage — the updateUserStatus handler drops updates for users it does not know)';
}
