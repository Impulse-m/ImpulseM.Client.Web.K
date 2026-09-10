import {liveLane} from './lane';
import {expect, test} from './pair';

/*
 * CEO, 2026-09-10: "у меня постоянно черновик возвращается, хотя я его стираю" (#440, #437 item 5).
 *
 * What the server side already shows, and why the test had to move into the browser: his
 * pts_less_update_log holds seventeen updateDraftMessage entries for Saved Messages that alternate
 * save/clear/save/clear, ALWAYS with the identical text -- he did not retype it five times. Both
 * resurrections that could be timed landed 2-7 seconds after a getDifference burst, and the newest
 * entry at the moment of each of those bursts was a CLEAR. So the replay's last word was already
 * "no draft" and the text came back anyway: it is not the server handing the old draft back, it is
 * the client re-saving state it kept across the reload.
 *
 * SavedMessagesDraftClearsScenario covers the server half and passes -- the row is removed, and
 * messages.getAllDrafts and the dialog list agree. A backend pull test cannot close this one; the
 * defect lives between the client's persisted draft cache, the update it receives, and the save it
 * then decides to send. That is the consumption path, so this scenario drives the REAL client in a
 * REAL browser and reloads the page, which is the event both resurrections followed.
 *
 * The second scenario is the ordinary path, and it is not optional: a client that simply dropped
 * every draft on reload would pass the first scenario perfectly while being far more broken. One
 * scenario says a cleared draft stays cleared, the other says an uncleared one survives, and only
 * the pair distinguishes a working implementation from an inert one.
 */
test.skip(!liveLane.enabled, liveLane.skipReason);

/**
 * The debounce in components/chat/input.ts is 2500 ms before the save even leaves the page, so
 * every wait for a draft to appear or disappear server-side has to clear that first.
 */
const draftSettleBound = 20_000;

/**
 * How long the composer is watched AFTER the reload has settled. Both timed resurrections landed
 * within 7 seconds of the reload's getDifference; this is comfortably past that, because the
 * assertion is that nothing comes back rather than that something arrives.
 */
const resurrectWatchMs = 15_000;


test('a draft cleared in Saved Messages does not come back after a reload', async({pair}) => {
  const {sender} = pair;
  const draft = `draft-${Date.now().toString(36)}`;

  await sender.openSavedMessages();
  const selfPeerId = await sender.ownPeerId();

  await sender.typeIntoComposer(draft);
  await expect
    .poll(async() => textOfDraftFor(await sender.draftsOnServer(), selfPeerId), {
      timeout: draftSettleBound,
      message: 'the draft has to reach the server before clearing it can mean anything -- a run ' +
        'where it never saved would otherwise read as a successful clear'
    })
    .toBe(draft);

  await sender.clearComposer();
  await expect
    .poll(async() => textOfDraftFor(await sender.draftsOnServer(), selfPeerId), {
      timeout: draftSettleBound,
      message: 'clearing the composer must reach the server as a cleared draft; if it never does, ' +
        'the resurrect after reload is only the client reading back a draft that was never removed'
    })
    .toBe('');

  await sender.reloadAndReopenSavedMessages();

  // The reload is the event both timed resurrections followed, and the save that carries the draft
  // back to the server is debounced -- so a single assertion taken right after the reload would be
  // answered before the defect had a chance to complete. The whole window is watched, and BOTH
  // halves are recorded before either is asserted: failing on the first sighting would report the
  // composer and leave the server side unmeasured, which is the half that outlives the tab.
  const start = Date.now();
  const deadline = start + resurrectWatchMs;
  let composerCameBackAfterMs: number | undefined;
  let serverCameBackAfterMs: number | undefined;
  for(;;) {
    if(composerCameBackAfterMs === undefined && (await sender.composerText()) !== '') {
      composerCameBackAfterMs = Date.now() - start;
    }

    if(serverCameBackAfterMs === undefined
      && textOfDraftFor(await sender.draftsOnServer(), selfPeerId) !== '') {
      serverCameBackAfterMs = Date.now() - start;
    }

    if(Date.now() >= deadline) {
      break;
    }

    await sender.page.waitForTimeout(1_000);
  }

  expect(
    composerCameBackAfterMs,
    'the composer must still be empty after the reload, and this reports how many ms after it the ' +
      'text reappeared. A draft that comes back here is the reported defect: the text is restored ' +
      'from state the client kept across the reload, of a draft the server had already removed ' +
      'at the assertion above (#440)'
  ).toBeUndefined();

  expect(
    serverCameBackAfterMs,
    'and the server must still hold no draft for Saved Messages. This is the half that outlives ' +
      'the tab: the row is recreated by the client saving the restored text back, so the draft is ' +
      'waiting again on the next cold start, on this device and every other one (#440)'
  ).toBeUndefined();
});


test('a draft left in place is still there after a reload', async({pair}) => {
  const {sender, recipient} = pair;
  const draft = `kept-${Date.now().toString(36)}`;

  // Deliberately NOT Saved Messages: the sibling scenario owns the degenerate peer shape, and
  // this one is about the ordinary two-party dialog, where a draft surviving a reload is the
  // whole point of drafts existing.
  await sender.openDialogWithPhone(recipient.persona.phone);
  await sender.typeIntoComposer(draft);

  const peerId = await sender.page.evaluate(() => String((window as any).appImManager.chat.peerId));
  await expect
    .poll(async() => textOfDraftFor(await sender.draftsOnServer(), peerId), {
      timeout: draftSettleBound,
      message: 'a typed draft must reach the server -- without this the reload assertion below ' +
        'would be satisfied by a client that never saved anything in the first place'
    })
    .toBe(draft);

  await sender.page.reload({waitUntil: 'domcontentloaded'});
  await sender.waitForImReady();
  await sender.openDialogWithPhone(recipient.persona.phone);

  await expect
    .poll(async() => sender.composerText(), {
      timeout: draftSettleBound,
      message: 'the draft must be restored into the composer after a reload. This is the ordinary ' +
        'path, and it is asserted so that a fix which simply stops restoring drafts cannot pass ' +
        'as a fix for the resurrecting one'
    })
    .toBe(draft);

  expect(
    textOfDraftFor(await sender.draftsOnServer(), peerId),
    'and the server still holds it -- the restore must come from a draft that genuinely exists, ' +
      'not from a stale local copy of one the server dropped'
  ).toBe(draft);
});


function textOfDraftFor(drafts: {peerId: string, text: string}[], peerId: string): string {
  return drafts.find((draft) => draft.peerId === peerId)?.text ?? '';
}
