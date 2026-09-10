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
 * IT IS A RACE, AND THE SCENARIO IS SHAPED AROUND THAT. A single clear-and-reload reproduces it
 * sometimes and not always: measured directly, one run came back 5 s after the reload with a NEW
 * date and a recreated server row, and the next identical run stayed clean. That is also what the
 * report describes -- the gaps between resurrections ran from 12 seconds to 28 minutes. So the
 * cycle is repeated, which is what the CEO does over a working day, and the scenario fails on the
 * FIRST cycle that resurrects rather than on the last. A one-shot version of this test would be
 * intermittently red, and an intermittently red test is worse than none: it gets rerun until green
 * and then believed.
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
 * How long the composer is watched after each reload. Every resurrection that could be timed
 * landed within 7 seconds of the reload, so this is comfortably past that -- the assertion is that
 * nothing comes back rather than that something arrives, and a window that is too short would read
 * as health.
 */
const resurrectWatchMs = 10_000;

/**
 * How many clear-and-reload cycles the scenario walks before it accepts that the draft stays
 * cleared. Not a retry: each cycle is an independent chance for the race to land, and the scenario
 * fails on the first one that does. Chosen so a run says something -- one cycle reproduced it on
 * one attempt and not the next, so a single cycle would be a coin toss reported as a verdict.
 */
const clearAndReloadCycles = 5;


test('a draft cleared in Saved Messages does not come back after a reload', async({pair}) => {
  const {sender} = pair;

  await sender.openSavedMessages();
  const selfPeerId = await sender.ownPeerId();
  const serverDraft = async() => textOfDraftFor(await sender.draftsOnServer(), selfPeerId);

  for(let cycle = 1; cycle <= clearAndReloadCycles; ++cycle) {
    const draft = `draft-${cycle}-${Date.now().toString(36)}`;

    // Retyped every cycle with a fresh marker, so a resurrection names the cycle that produced it
    // and cannot be confused with a leftover of an earlier one.
    await sender.typeIntoComposer(draft);
    await expect
      .poll(serverDraft, {
        timeout: draftSettleBound,
        message: `cycle ${cycle}: the draft has to reach the server before clearing it can mean ` +
          'anything -- a cycle where it never saved would otherwise read as a successful clear'
      })
      .toBe(draft);

    await sender.clearComposer();
    await expect
      .poll(serverDraft, {
        timeout: draftSettleBound,
        message: `cycle ${cycle}: clearing the composer must reach the server as a cleared draft; ` +
          'if it never does, the resurrect after reload is only the client reading back a draft ' +
          'that was never removed'
      })
      .toBe('');

    await sender.reloadAndReopenSavedMessages();

    // The save that carries the draft back to the server is debounced, so a single reading taken
    // right after the reload would be answered before the defect had a chance to complete. The
    // whole window is watched, and BOTH halves are recorded before either is asserted: stopping at
    // the first sighting would report the composer and leave the server side unmeasured, which is
    // the half that outlives the tab.
    const start = Date.now();
    const deadline = start + resurrectWatchMs;
    let composerCameBackAfterMs: number | undefined;
    let serverCameBackAfterMs: number | undefined;
    for(;;) {
      if(composerCameBackAfterMs === undefined && (await sender.composerText()) !== '') {
        composerCameBackAfterMs = Date.now() - start;
      }

      if(serverCameBackAfterMs === undefined && (await serverDraft()) !== '') {
        serverCameBackAfterMs = Date.now() - start;
      }

      if(Date.now() >= deadline) {
        break;
      }

      await sender.page.waitForTimeout(1_000);
    }

    expect(
      composerCameBackAfterMs,
      `cycle ${cycle} of ${clearAndReloadCycles}: the composer must still be empty after the ` +
        'reload, and this reports how many ms after it the text reappeared. A draft that comes ' +
        'back here is the reported defect -- the text is restored from state the client kept ' +
        'across the reload, of a draft the server had already removed at the assertion above (#440)'
    ).toBeUndefined();

    expect(
      serverCameBackAfterMs,
      `cycle ${cycle} of ${clearAndReloadCycles}: and the server must still hold no draft for ` +
        'Saved Messages. This is the half that outlives the tab -- the row is recreated by the ' +
        'client saving the restored text back, so the draft is waiting again on the next cold ' +
        'start, on this device and every other one (#440)'
    ).toBeUndefined();
  }
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
