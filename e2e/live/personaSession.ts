import {readFileSync} from 'fs';
import {join} from 'path';

import {Browser, BrowserContext, chromium, Page, expect} from '@playwright/test';

import type {ActiveAccountNumber} from '../../src/lib/accounts/types';
import {loginCodeFor, Persona} from '../../src/tests/liveharness/personas';
import {ConsoleCleanInvariant} from './invariants';
import {captureMediaDiagnostics, describePlaybackFailure, installMediaDiagnostics, MediaElementState} from './mediaPlayback';

/*
 * One persona = one isolated browser context on the lane's own client instance. Everything a
 * scenario does goes through the surfaces a real user's session exercises:
 *
 *   - sign-up runs through the REAL auth UI (phone card -> scripted code 11111 -> sign-up
 *     card), the same flow the CEO walks — no headless invokeApi shortcut;
 *   - text sends type into the real message input and press Enter;
 *   - media sends click the real attach menu, feed the real file chooser, and confirm the
 *     real PopupNewMedia — the exact album pipeline;
 *   - the round note is the ONE documented fidelity boundary: headless chromium has no camera,
 *     so the scenario calls appMessagesManager.sendFile from the page context with byte-for-
 *     byte the recorder's options (chatRecording.ts:311-325) and a real VP8+Opus capture — the
 *     UI record button itself is the only part not driven. Everything downstream (pending
 *     bubble, ack rebind, playback click) is the real UI.
 *
 * Peer resolution is test plumbing, not the surface under test: contacts.resolvePhone through
 * the page's own managers (the same RPC the C# harness twins use — TwinClientSession.cs:514)
 * followed by the app's own appImManager.setInnerPeer. Both handles come off window.* mounts
 * the app itself exports (MOUNT_CLASS_TO in src/config/debug.ts).
 */
const liveharnessFixturesDir = join(__dirname, '..', '..', 'src', 'tests', 'liveharness', 'fixtures');

/**
 * One console/pageerror line with its arrival time — ALL levels, not just errors (the
 * console-clean invariant owns the error-level failures; the trail exists so a playback or
 * rebind red can quote what the console said AROUND the failing action).
 */
export type ConsoleTrailEntry = {
  at: number,
  kind: string,
  text: string
};

const consoleTrailCap = 400;


export function roundNoteFixtures(): {webmBase64: string, posterBase64: string} {
  return {
    webmBase64: readFileSync(join(liveharnessFixturesDir, 'round-note-vp8-opus.webm')).toString('base64'),
    posterBase64: readFileSync(join(liveharnessFixturesDir, 'round-note-poster-400.jpg')).toString('base64')
  };
}


export class PersonaSession {
  public readonly persona: Persona;

  /**
   * DIAGNOSTIC ONLY. `?noWorker=1` (Modes.noWorker, config/modes.ts:37) loops both ends of a
   * MessageChannel into the page's own realm, so the mtproto worker module runs in the MAIN
   * THREAD. The update pipeline is then visible to `page.on('console')`, which it is not
   * otherwise: tweb owns it from a SharedWorker (apiManagerProxy.ts:1047) that neither an init
   * script nor the page console reaches.
   *
   * <p>It CHANGES the environment, so a scenario that asserts under it is asserting about a mode
   * no user runs. Use it to see, never to prove — and record which mode a finding came from.</p>
   */
  private inProcessWorker = false;

  /**
   * Which account SLOT this tab drives. tweb binds a tab to one account through the `account` URL
   * query param (getCurrentAccountFromURL, cached for the page's life), so a second account in the
   * SAME browser is a second TAB opened at `?account=2`. The SharedWorker is shared across the
   * context's tabs, which is precisely the surface the CEO's multi-account realtime report lives on:
   * the two tabs share one realtime module, and bringing up slot 2 must not silence slot 1.
   */
  private accountNumber: ActiveAccountNumber = 1;

  /**
   * True when signUpThroughUi found the number already registered and signed in instead.
   *
   * Surfaced rather than absorbed: a run where this is true exercised a REUSED account, which may
   * carry another run's dialogs and read state, and a scenario that asserts about what an account
   * contains must say so rather than quietly measure somebody else's leftovers (#509).
   */
  public reusedExistingAccount = false;
  public page: Page;
  public readonly consoleClean: ConsoleCleanInvariant;
  public readonly consoleTrail: ConsoleTrailEntry[] = [];

  private context: BrowserContext;
  private readonly userDataDir: string | undefined;
  private readonly baseUrl: string | undefined;


  private constructor(
    persona: Persona,
    context: BrowserContext,
    page: Page,
    consoleClean: ConsoleCleanInvariant,
    userDataDir?: string,
    baseUrl?: string
  ) {
    this.persona = persona;
    this.context = context;
    this.page = page;
    this.consoleClean = consoleClean;
    this.userDataDir = userDataDir;
    this.baseUrl = baseUrl;
  }


  /**
   * `blockServiceWorkers` opens the context with service workers blocked — a browser state
   * the client must survive (first load before SW activation, private windows, a failed SW
   * update). Without a service worker appDocsManager marks every video
   * supportsStreaming=false (appDocsManager.ts:286), so playback takes the worker-minted
   * BLOB URL lane — the exact lane behind the board's {sourceKind: "blob"} failure record,
   * unreachable in this harness while the /stream/ lane is available.
   */
  public static async open(
    browser: Browser,
    persona: Persona,
    options: {blockServiceWorkers?: boolean, inProcessWorker?: boolean} = {}
  ): Promise<PersonaSession> {
    const context = await browser.newContext(
      options.blockServiceWorkers ? {serviceWorkers: 'block'} : {}
    );
    const page = await context.newPage();
    const consoleClean = await ConsoleCleanInvariant.attach(page, persona.firstName);
    const session = new PersonaSession(persona, context, page, consoleClean);
    session.inProcessWorker = options.inProcessWorker === true;
    await session.wireDiagnostics(page);
    return session;
  }


  /**
   * A SECOND account in the SAME browser: a new tab in the existing session's context, bound to
   * `accountNumber` through the `account` URL param. The two tabs share one BrowserContext and
   * therefore one SharedWorker — the exact setup behind the CEO's report of two accounts in one
   * browser where realtime breaks for one of them. The returned session drives its own slot; the
   * caller signs it up/in as usual. It rides the base session's context, so tear it down with
   * closePageOnly() and let the base session's close() dispose the shared context.
   */
  public static async openAdditionalAccount(
    base: PersonaSession,
    persona: Persona,
    accountNumber: ActiveAccountNumber,
    options: {inProcessWorker?: boolean} = {}
  ): Promise<PersonaSession> {
    const page = await base.context.newPage();
    const consoleClean = await ConsoleCleanInvariant.attach(page, persona.firstName);
    const session = new PersonaSession(persona, base.context, page, consoleClean);
    session.inProcessWorker = options.inProcessWorker === true;
    session.accountNumber = accountNumber;
    await session.wireDiagnostics(page);
    return session;
  }


  /**
   * Warm-cache variant (issue #108): the persona lives in an on-disk chromium profile
   * (userDataDir), so its IndexedDB, localStorage, caches and service worker survive not just
   * a page reload but a FULL browser restart (restartBrowserProfile) — the state the CEO's
   * long-lived session is always in and no fresh-context scenario can reproduce.
   */
  public static async openPersistent(userDataDir: string, persona: Persona, baseUrl: string): Promise<PersonaSession> {
    const context = await PersonaSession.launchPersistent(userDataDir, baseUrl);
    const page = context.pages()[0] ?? await context.newPage();
    const consoleClean = await ConsoleCleanInvariant.attach(page, persona.firstName);
    const session = new PersonaSession(persona, context, page, consoleClean, userDataDir, baseUrl);
    await session.wireDiagnostics(page);
    return session;
  }


  /**
   * Closes the whole browser over the persistent profile and launches a fresh one on the SAME
   * profile directory — a real browser restart, not a tab reload. Leaves the new page on '/'
   * WITHOUT waiting for the app to become ready: the caller verifies storage survival first
   * (a restart that silently wiped IndexedDB must fail by name, not by an opaque auth-page
   * timeout) and then awaits readiness itself.
   */
  public async restartBrowserProfile(): Promise<void> {
    if(!this.userDataDir || !this.baseUrl) {
      throw new Error('restartBrowserProfile is only valid on a session opened with openPersistent');
    }

    await this.context.close();
    this.context = await PersonaSession.launchPersistent(this.userDataDir, this.baseUrl);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.consoleClean.wire(this.page);
    await this.wireDiagnostics(this.page);
    await this.page.goto('/', {waitUntil: 'domcontentloaded'});
  }


  /**
   * Phone and code, through the real cards — the half every authorization shares.
   *
   * Split out of signUpThroughUi when a second DEVICE on an EXISTING account became reproducible
   * (#319): the two flows are identical up to the code and diverge only afterwards, where a new
   * number gets the name card and a known one lands straight in the app. Sharing the half that is
   * genuinely shared keeps the country auto-fill defence, which is load-bearing and was written
   * against a real corruption, in ONE place.
   */
  private async enterPhoneAndCodeThroughUi(): Promise<void> {
    // The `account` query param selects the slot before boot — getCurrentAccount reads it from the
    // URL and caches it, so an empty slot 2 lands on its own login screen. Slot 1 keeps the bare
    // '/' so every existing single-account scenario navigates to exactly the URL it did before.
    const params = new URLSearchParams();
    if(this.inProcessWorker) {
      params.set('noWorker', '1');
    }
    if(this.accountNumber !== 1) {
      params.set('account', String(this.accountNumber));
    }
    const query = params.toString();
    await this.page.goto(query ? `/?${query}` : '/', {waitUntil: 'domcontentloaded'});

    // A virgin desktop boot lands on the QR card (state.ts: authState defaults to
    // authStateSignQr when !IS_MOBILE); the real UI escape hatch is its
    // "Log in by phone number >" button (SignQRCard, Login.QR.Cancel). First contact with a
    // cold Vite server compiles the whole module graph — generous wait.
    const phoneInput = this.page.locator('.input-field-phone .input-field-input');
    const qrToPhoneButton = this.page.getByRole('button', {name: 'Log in by phone number'});
    await phoneInput.or(qrToPhoneButton).first().waitFor({state: 'visible', timeout: 180_000});
    if(!(await phoneInput.isVisible())) {
      await qrToPhoneButton.click();
      await phoneInput.waitFor({state: 'visible', timeout: 30_000});
    }

    // The sign-in card auto-detects a country asynchronously (nearestDc) and, when it lands,
    // REWRITES the tel field to that country's '+<code>' — typing over that race once produced
    // an account registered on '+1<persona digits>' (verified in user_profiles). Let the
    // auto-fill land (bounded), then clear, type, and VERIFY the field holds exactly the
    // persona's digits before submitting.
    await this.page
      .waitForFunction(() => {
        const country = document.querySelector('.input-select .input-field-input');
        return !!country?.textContent?.trim();
      }, undefined, {timeout: 5_000})
      .catch(() => {
        // No auto-detected country on this stack — nothing will rewrite the field.
      });

    const personaDigits = this.persona.phone.replace(/\D/g, '');
    let typedDigits = '';
    for(let attempt = 0; attempt < 3; ++attempt) {
      await phoneInput.click();
      await this.page.keyboard.press('ControlOrMeta+a');
      await this.page.keyboard.press('Backspace');
      await this.page.keyboard.type(this.persona.phone, {delay: 20});
      typedDigits = ((await phoneInput.textContent()) ?? '').replace(/\D/g, '');
      if(typedDigits === personaDigits) {
        break;
      }
    }

    expect(
      typedDigits,
      `the phone field ended up with different digits than the persona's phone after 3 attempts — ` +
      'the country auto-fill keeps rewriting the field, and submitting would register the account ' +
      'under a wrong number (the exact corruption found in user_profiles as "+1<digits>")'
    ).toBe(personaDigits);

    await this.page.getByRole('button', {name: 'Next', exact: true}).click();

    // The code is DERIVED from the persona's own number rather than configured: canon's reserved
    // test block always answers with the DC digit repeated (api/auth.md:1003-1005). See
    // liveharness/personas.ts — this lane went dark once because that moved on the backend and the
    // harness kept typing the old fixed constant, which reads as "Invalid code" on the card.
    const codeInput = this.page.locator('input[autocomplete="one-time-code"]');
    await codeInput.waitFor({state: 'visible', timeout: 60_000});
    await codeInput.click();
    await this.page.keyboard.type(loginCodeFor(this.persona), {delay: 60});
  }


  /**
   * A NEW number: the code is followed by the name card, which only an account that does not
   * exist is shown (auth.authorizationSignUpRequired).
   */
  public async signUpThroughUi(): Promise<void> {
    await this.enterPhoneAndCodeThroughUi();

    // The name card is EXPECTED but not guaranteed, and the difference cost a wrong verdict. An
    // ephemeral persona is unique within a run, not across runs: the reserved block's allocator
    // wraps, so a number this run believes is new can already carry an account from an earlier one
    // (#509). auth.signIn then answers an authorization instead of authorizationSignUpRequired,
    // no name card is ever shown, and waiting for it times out INSIDE the fixture — which reads as
    // the scenario failing when nothing has been measured yet.
    //
    // So both outcomes are accepted here and the account ends up signed in either way. What is NOT
    // accepted is silence: a scenario that cannot tell which happened is one whose flakes get
    // attributed to whatever it was testing, and that is exactly how #319's fix looked
    // intermittent when a third of its reds were this.
    const nameInput = this.page.locator('.input-field-input[contenteditable="true"]:not(.input-field-input-fake)').first();
    const ready = this.page.waitForFunction(() => {
      const w = window as any;
      return !document.body.classList.contains('has-auth-pages') && !!w.appImManager && !!w.rootScope?.managers;
    }, undefined, {timeout: 180_000});

    const outcome = await Promise.race([
      nameInput.waitFor({state: 'visible', timeout: 180_000}).then(() => 'sign-up-card' as const),
      ready.then(() => 'already-registered' as const)
    ]);

    if(outcome === 'already-registered') {
      this.reusedExistingAccount = true;
      await this.waitForImReady();
      return;
    }

    await nameInput.click();
    await this.page.keyboard.type(this.persona.firstName, {delay: 20});

    const lastNameInput = this.page.locator('.input-field-input[contenteditable="true"]:not(.input-field-input-fake)').nth(1);
    await lastNameInput.click();
    await this.page.keyboard.type(this.persona.lastName, {delay: 20});

    await this.page.getByRole('button', {name: 'Start Messaging', exact: true}).click();

    await this.waitForImReady();
  }


  /**
   * A SECOND DEVICE on an account that already exists: the same phone and code, and then the app
   * directly — no name card, because auth.signIn answers an authorization rather than
   * authorizationSignUpRequired.
   *
   * <p>The name card appearing here is not a UI detail to absorb; it means the account was not
   * found and this browser is about to register a SECOND account under the same number's
   * neighbourhood. A scenario that let that through would then compare two accounts and call the
   * result multi-device. So it is asserted against rather than waited past.</p>
   */
  public async signInThroughUi(): Promise<void> {
    await this.enterPhoneAndCodeThroughUi();

    const nameCard = this.page.locator('.input-field-input[contenteditable="true"]:not(.input-field-input-fake)').first();
    const ready = this.page.waitForFunction(() => {
      const w = window as any;
      return !document.body.classList.contains('has-auth-pages') && !!w.appImManager && !!w.rootScope?.managers;
    }, undefined, {timeout: 180_000});

    const outcome = await Promise.race([
      ready.then(() => 'signed-in' as const),
      nameCard.waitFor({state: 'visible', timeout: 180_000}).then(() => 'sign-up-card' as const)
    ]);

    expect(
      outcome,
      'signInThroughUi was asked to open a SECOND device on an existing account, and the client ' +
      'was shown the sign-up name card instead — which means auth.signIn answered ' +
      'authorizationSignUpRequired and this number has no account. Continuing would register a ' +
      'new one and every multi-device assertion afterwards would be comparing two accounts'
    ).toBe('signed-in');

    await this.waitForImReady();
  }


  public async openDialogWithPhone(phone: string): Promise<void> {
    await this.page.evaluate(async(phoneDigits) => {
      // App-level rejections are plain objects (ApiError shape), which Playwright renders as
      // an opaque "Object" — rethrow them named so a resolve failure is diagnosable verbatim.
      const rethrowNamed = (stage: string, error: any): never => {
        const rendered = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : JSON.stringify(error);
        throw new Error(`${stage} failed for "+${phoneDigits}": ${rendered}`);
      };

      const w = window as any;

      // A just-signed-up twin becomes phone-discoverable only after the Users service's
      // AuthEventConsumer materialises its user_profiles row off the Kafka auth event —
      // at-least-once, eventually consistent by design. Retry ONLY that exact not-yet-there
      // shape (PHONE_NOT_OCCUPIED), bounded; every other error fails immediately, verbatim.
      const deadline = Date.now() + 45_000;
      let user: any;
      for(;;) {
        try {
          user = await w.rootScope.managers.appUsersManager.resolvePhone(phoneDigits);
          break;
        } catch(error: any) {
          if(error?.type !== 'PHONE_NOT_OCCUPIED') {
            rethrowNamed('contacts.resolvePhone', error);
          }

          if(Date.now() > deadline) {
            throw new Error(
              `contacts.resolvePhone("+${phoneDigits}") still returns PHONE_NOT_OCCUPIED 45s after ` +
              'the twin persona finished sign-up — the auth->users profile propagation (Kafka ' +
              'AuthEventConsumer -> user_profiles) never landed, so the account is unreachable by phone'
            );
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if(!user?.id) {
        throw new Error(`contacts.resolvePhone("+${phoneDigits}") resolved no user — the twin persona is not reachable on this stack`);
      }

      const peerId = user.id.toPeerId(false);
      await w.appImManager.setInnerPeer({peerId})
        .catch((error: any) => rethrowNamed('appImManager.setInnerPeer', error));
    }, phone.replace('+', ''));

    await this.messageInput().waitFor({state: 'visible', timeout: 30_000});
  }


  public async reloadAndReopenDialog(phone: string): Promise<void> {
    await this.page.reload({waitUntil: 'domcontentloaded'});
    await this.waitForImReady();
    await this.openDialogWithPhone(phone);
  }


  /**
   * Saved Messages — the degenerate peer shape where the peer id and the owner id are the same
   * value, and the dialog the resurrecting draft was reported in (#440).
   */
  public async openSavedMessages(): Promise<void> {
    await this.page.evaluate(async() => {
      const w = window as any;
      await w.appImManager.setInnerPeer({peerId: w.rootScope.myId});
    });

    await this.messageInput().waitFor({state: 'visible', timeout: 30_000});
  }


  public async reloadAndReopenSavedMessages(): Promise<void> {
    await this.page.reload({waitUntil: 'domcontentloaded'});
    await this.waitForImReady();
    await this.openSavedMessages();
  }


  /**
   * Types into the composer and leaves the text sitting there, which is what makes it a draft.
   * The save is debounced (2500 ms, components/chat/input.ts), so a caller that needs the draft
   * to exist server-side must wait for the server to say so rather than for the keystroke.
   */
  public async typeIntoComposer(text: string): Promise<void> {
    await this.messageInput().click();
    await this.page.keyboard.type(text, {delay: 10});
  }


  /**
   * Clears the composer the way a user does — select-all then delete — rather than by calling a
   * manager. The reported defect is about what the real input path leaves behind, so a
   * programmatic clear would skip the very code under test.
   */
  public async clearComposer(): Promise<void> {
    await this.messageInput().click();
    await this.page.keyboard.press('Control+A');
    await this.page.keyboard.press('Backspace');
  }


  public async composerText(): Promise<string> {
    return (await this.messageInput().innerText()).trim();
  }


  /**
   * Every draft the SERVER holds, read through the page's own apiManager — the same lane the
   * user is on. Reading the client's cached draft map instead would answer a different question:
   * the whole point is whether the two agree.
   *
   * messages.getAllDrafts answers as a vector of updateDraftMessage, and canon spells "no draft"
   * as the draftMessageEmpty variant rather than as a draftMessage with an empty string
   * (api/drafts.md), so an entry that is not a draftMessage reads here as empty text.
   */
  public async draftsOnServer(): Promise<{peerId: string, text: string}[]> {
    return this.page.evaluate(async() => {
      const w = window as any;
      const updates = await w.rootScope.managers.apiManager.invokeApi('messages.getAllDrafts');

      return (updates?.updates ?? [])
        .filter((update: any) => update?._ === 'updateDraftMessage')
        .map((update: any) => ({
          peerId: String(
            update?.peer?.user_id ?? update?.peer?.chat_id ?? update?.peer?.channel_id ?? ''
          ),
          text: update?.draft?._ === 'draftMessage' ? String(update.draft.message ?? '') : ''
        }));
    });
  }


  public async ownPeerId(): Promise<string> {
    return this.page.evaluate(() => String((window as any).rootScope.myId));
  }


  public async sendTextThroughUi(text: string): Promise<void> {
    await this.typeAndSendText(text);
    await this.waitForOwnBubbleWithText(text);
  }


  /**
   * The raw UI send with NO settle wait — for scenarios whose subject IS the settling (the
   * defect-B rebind pin installs its own hooks between the keystroke and the assertion).
   */
  public async typeAndSendText(text: string): Promise<void> {
    const input = this.messageInput();
    await input.click();
    await this.page.keyboard.type(text, {delay: 10});
    await this.page.keyboard.press('Enter');
  }


  /**
   * Real attach flow: attach menu -> "Photo or Video" -> file chooser -> PopupNewMedia ->
   * confirm. `files` go in as in-memory payloads, exactly what the OS picker would hand over.
   * PopupNewMedia's default `group: true` makes 2..10 media items an album.
   */
  public async attachMediaThroughUi(files: {name: string, mimeType: string, buffer: Buffer}[]): Promise<void> {
    await this.page.locator('.attach-file').click();

    const menuItem = this.page.locator('.btn-menu-item:visible', {hasText: 'Photo or Video'}).first();
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      menuItem.click()
    ]);
    await chooser.setFiles(files);

    const confirm = this.page.locator('.popup-new-media button.btn-primary');
    await confirm.waitFor({state: 'visible', timeout: 30_000});
    await confirm.click();
    await this.page.locator('.popup-new-media').waitFor({state: 'hidden', timeout: 30_000});

    await this.waitForOutgoingSettled('attached media');
  }


  /**
   * The documented fidelity boundary (see the file header): the recorder's sendFile call,
   * byte-for-byte its options (chatRecording.ts:311-325), from the page context, with a real
   * VP8+Opus capture and the recorder's poster. thumb.size goes through the app's own
   * makeMediaSize off the page's Vite module graph — the same object shape the real recorder
   * hands to the same proxied manager over the same MessagePort.
   */
  public async sendRoundNoteAsRecorder(): Promise<void> {
    const fixtures = roundNoteFixtures();
    await this.page.evaluate(async({webmBase64, posterBase64}) => {
      const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const {makeMediaSize} = await dynamicImport('/src/helpers/mediaSize.ts');

      const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const w = window as any;
      const chat = w.appImManager.chat;
      if(!chat?.peerId) {
        throw new Error('round-note send requested with no open dialog');
      }

      const blob = new Blob([toBytes(webmBase64)], {type: 'video/webm'});
      const poster = new Blob([toBytes(posterBase64)], {type: 'image/jpeg'});

      await w.rootScope.managers.appMessagesManager.sendFile({
        ...chat.getMessageSendingParams(),
        file: blob,
        isRoundMessage: true,
        isMedia: true,
        duration: 2,
        width: 400,
        height: 400,
        objectURLBlob: blob,
        thumb: {blob: poster, size: makeMediaSize(400, 400)},
        clearDraft: true
      });
    }, fixtures);

    await this.waitForOutgoingSettled('round note');
  }


  /**
   * Clicks the round bubble and asserts playback actually starts — the #91 failure shape is a
   * click that leaves an eternal spinner. Playing is proven by the wrapper's own signals: on
   * the global media's `play` event the inner preview video gets the `hide` class
   * (wrappers/video.ts onPlay) and appMediaPlaybackController's current media advances.
   */
  public async playRoundNote(side: string): Promise<void> {
    const round = this.page.locator('.media-round[data-mid]').last();
    await round.waitFor({state: 'visible', timeout: 60_000});
    const clickAt = Date.now();
    await round.locator('canvas.video-round-canvas').click();

    await this.page.waitForFunction(() => {
      const w = window as any;
      const playing: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
      const started = !!document.querySelector('.media-round[data-mid] video.media-video.hide');
      return started && !!playing && !playing.paused && playing.currentTime > 0;
    }, undefined, {timeout: 60_000}).catch(async() => {
      const diagnostics = await captureMediaDiagnostics(this.page);
      // The round note plays through a GLOBAL media element (appMediaPlaybackController), not
      // the bubble's muted preview — run #2 caught it outside the bubble with the same blob
      // src and zero play() calls, so same-src elements count as relevant.
      const roundSrcs = new Set(
        diagnostics.elements
          .filter((state: MediaElementState) => state.inRoundBubble && state.currentSrc)
          .map((state: MediaElementState) => state.currentSrc)
      );
      const relevant = diagnostics.elements.filter((state: MediaElementState) => {
        return state.inRoundBubble || state.isPlaybackControllerMedia || roundSrcs.has(state.currentSrc);
      });
      throw new Error(
        `the round note on the ${side} side never started playing after a click on its bubble — ` +
        'the user-visible shape of issue #91 (eternal spinner: the click never turns into moving ' +
        'video for the user).\n' +
        describePlaybackFailure(diagnostics, relevant) + '\n' +
        `console around the click:\n${this.formatConsoleTrailSince(clickAt - 2_000)}`
      );
    });

    const spinnerCount = await round.locator('.preloader-container').count();
    expect(
      spinnerCount,
      `the round note on the ${side} side is playing but still shows a preloader spinner — ` +
      'playback fell back to some other element while the bubble itself is stuck downloading'
    ).toBe(0);
  }


  /**
   * The board's defect-A surface for a PLAIN video: click the video bubble the way a user
   * does; the client opens the media viewer and must actually start playback there —
   * currentTime advancing past zero with readyState beyond HAVE_CURRENT_DATA. A red names
   * the lane that broke (no source / src refused / decode error / no play() call) from the
   * page-wide media instrumentation, plus the console around the click.
   *
   * `age` picks which video bubble the user clicks: 'newest' is the freshest exchange (the
   * default), 'oldest' is the rewatch journey — the board's failing gesture is opening a
   * video it had already seen, after newer media went through the session.
   */
  public async playVideoFromBubble(side: string, age: 'newest' | 'oldest' = 'newest'): Promise<void> {
    const bubbles = this.page.locator('.bubble[data-mid]', {has: this.page.locator('.video-time')});
    const bubble = age === 'oldest' ? bubbles.first() : bubbles.last();
    await bubble.waitFor({state: 'visible', timeout: 60_000});

    // Click the media CONTAINER, not a leaf: an inline-autoplaying <video> sits on top of
    // the poster <img>, so a leaf click gets refused as intercepted — while whichever
    // descendant is on top (video, poster, play button) is exactly what the user hits, and
    // Playwright accepts a hit on a descendant of the clicked element.
    const clickTarget = bubble.locator('.attachment, .bubble__media-container').first();
    const clickAt = Date.now();
    const clickBubble = async() => {
      await clickTarget.click({timeout: 30_000}).catch(async(error: Error) => {
        const diagnostics = await captureMediaDiagnostics(this.page);
        throw new Error(
          `the video bubble on the ${side} side could not even be clicked: ${error.message}\n` +
          describePlaybackFailure(diagnostics, []) + '\n' +
          `console around the click attempt:\n${this.formatConsoleTrailSince(clickAt - 2_000)}`
        );
      });
    };

    await clickBubble();

    // Observed live (viewerRewatch run #1): a click landing ~120ms after the bubble renders —
    // inside the render's heavy-animation window — is silently dropped: no viewer, no toast,
    // no play() call. A human in that situation clicks again, so the scenario retries ONCE,
    // waiting for the viewer element (the click's own success signal) before deciding; the
    // playback assertion below stays the sole judge of the lane under test.
    const viewerAppeared = await this.page
      .waitForFunction(() => {
        return !!document.querySelector<HTMLVideoElement>('.media-viewer-whole video');
      }, undefined, {timeout: 10_000})
      .then(() => true)
      .catch(() => false);
    if(!viewerAppeared) {
      await clickBubble();
    }

    await this.page.waitForFunction(() => {
      const viewerVideo = document.querySelector<HTMLVideoElement>('.media-viewer-whole video');
      // HAVE_CURRENT_DATA is 2 — playback must be PAST it, with the clock actually moving.
      return !!viewerVideo && !viewerVideo.paused && viewerVideo.currentTime > 0 && viewerVideo.readyState > 2;
    }, undefined, {timeout: 60_000}).catch(async() => {
      const diagnostics = await captureMediaDiagnostics(this.page);
      const relevant = diagnostics.elements.filter((state: MediaElementState) => {
        return state.inMediaViewer || state.isPlaybackControllerMedia;
      });
      throw new Error(
        `the plain video on the ${side} side never started playing after a click on its bubble — ` +
        'the board-reported defect A shape: the user clicks the video and never gets moving ' +
        'pictures.\n' +
        describePlaybackFailure(diagnostics, relevant) + '\n' +
        `console around the click:\n${this.formatConsoleTrailSince(clickAt - 2_000)}`
      );
    });
  }


  /**
   * The src the media viewer's video element is actually playing from — for scenarios that
   * must assert WHICH lane (blob vs /stream/) carried the playback, so a lane-specific test
   * cannot silently go green on the other lane.
   */
  public async viewerVideoSrc(): Promise<string> {
    return this.page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('.media-viewer-whole video');
      return video ? (video.currentSrc || video.getAttribute('src') || '') : '';
    });
  }


  /**
   * Leaves the media viewer opened by playVideoFromBubble, so the scenario can hand the
   * page back to further UI steps with nothing overlaying the chat.
   */
  public async closeMediaViewer(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await this.page.locator('.media-viewer-whole').waitFor({state: 'detached', timeout: 30_000}).catch(async() => {
      throw new Error('the media viewer did not close on Escape — the overlay is stuck over the chat');
    });
  }


  /**
   * A settled incoming (non-outgoing) video bubble — the .video-time badge is the marker
   * every video message carries regardless of autoplay/thumbnail state.
   */
  public async waitForIncomingVideo(): Promise<void> {
    await this.page
      .locator('.bubble[data-mid]:not(.is-outgoing):not(.is-sending)', {has: this.page.locator('.video-time')})
      .last()
      .waitFor({state: 'visible', timeout: 90_000});
  }


  /**
   * Waits until at least `count` settled incoming videos are rendered — the single-bubble
   * variant above returns as soon as ANY incoming video is visible, which is useless after a
   * second send: the first video already satisfies it while the new one is still in flight.
   */
  public async waitForIncomingVideoCount(count: number): Promise<void> {
    await this.page.waitForFunction((expected) => {
      return document.querySelectorAll(
        '.bubble[data-mid]:not(.is-outgoing):not(.is-sending) .video-time'
      ).length >= expected;
    }, count, {timeout: 90_000});
  }


  /**
   * Ack discipline for outgoing sends: bubbles carry is-outgoing/is-sending until the server
   * ack rebinds them (bubbles.ts:964,1170); an is-error bubble is an immediate, named failure
   * rather than a timeout. On ANY failure the red carries the pending bubbles' state and the
   * console trail since the send — a media send that produces ZERO server RPCs dies inside
   * the client worker, and this capture is the only page-side evidence of where.
   */
  public async waitForOutgoingSettled(what: string): Promise<void> {
    const sinceMs = Date.now() - 10_000;
    await this.page.waitForFunction(() => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      if(container.querySelector('.bubble.is-error')) {
        throw new Error('an outgoing bubble entered is-error state — the send failed at the server or the transport');
      }

      return !container.querySelector('.bubble.is-outgoing, .bubble.is-sending');
    }, undefined, {timeout: 120_000}).catch(async(error: Error) => {
      const capture = await this.page.evaluate(() => {
        const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
        const pendingBubbles = container ?
          Array.from(container.querySelectorAll<HTMLElement>('.bubble.is-outgoing, .bubble.is-sending, .bubble.is-error'))
            .map((bubble) => ({
              mid: bubble.dataset.mid ?? '',
              classes: bubble.className,
              preloaderText: bubble.querySelector('.preloader-container')?.textContent ?? '(no preloader)'
            })) :
          [];

        return {
          pendingBubbles,
          messageSentEvents: (window as any).__impulseSentEvents ?? []
        };
      }).catch(() => ({
        pendingBubbles: [] as {mid: string, classes: string, preloaderText: string}[],
        messageSentEvents: [] as {tempId: string, mid: string, at: number}[]
      }));

      throw new Error(
        `the ${what} send never settled on the ${this.persona.firstName} page: the user's bubble keeps the ` +
        `clock/sending state forever instead of becoming a sent message (${error.message.split('\n')[0]}).\n` +
        `pending bubbles: ${JSON.stringify(capture.pendingBubbles)}\n` +
        `message_sent events on the main thread: ${JSON.stringify(capture.messageSentEvents)}\n` +
        `console since the send:\n${this.formatConsoleTrailSince(sinceMs)}`
      );
    });
  }


  /**
   * A bubble carrying `text` that has SETTLED, whichever direction it is.
   *
   * waitForIncomingText cannot serve Saved Messages or a second device's view of the account's own
   * send: both render as outgoing, and its selector excludes them by design. `:not(.is-sending)` is
   * kept, because a bubble still showing its clock is not "it appeared" — it is the other half of
   * #510.
   */
  public async waitForSettledText(text: string, timeoutMs = 60_000): Promise<void> {
    await this.page.waitForFunction((needle) => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      return Array.from(container.querySelectorAll('.bubble[data-mid]:not(.is-sending)'))
        .some((bubble) => bubble.textContent.includes(needle));
    }, text, {timeout: timeoutMs});
  }


  public async waitForIncomingText(text: string): Promise<void> {
    await this.page.waitForFunction((needle) => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      return Array.from(container.querySelectorAll('.bubble[data-mid]:not(.is-outgoing):not(.is-sending)'))
        .some((bubble) => bubble.textContent.includes(needle));
    }, text, {timeout: 60_000});
  }


  public async waitForIncomingRoundNote(): Promise<void> {
    await this.page.locator('.media-round[data-mid]').last().waitFor({state: 'visible', timeout: 90_000});
  }


  /**
   * Waits until the open dialog shows at least `expected` settled, non-service message bubbles
   * — the live receive gate before a reload, so a scenario never reloads ahead of the push it
   * is supposed to preserve.
   */
  public async waitForSettledMessageCount(expected: number): Promise<void> {
    await this.page.waitForFunction((count) => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      return container.querySelectorAll('.bubble[data-mid]:not(.service):not(.is-outgoing):not(.is-sending)').length >= count;
    }, expected, {timeout: 90_000});
  }


  public async close(): Promise<void> {
    await this.context.close();
  }


  /**
   * Closes only this tab's page, leaving the shared BrowserContext open — for a session created
   * with openAdditionalAccount, whose context belongs to the base session.
   */
  public async closePageOnly(): Promise<void> {
    await this.page.close();
  }


  /**
   * Public for the warm-cache flow: after restartBrowserProfile the SPEC verifies storage
   * survival on the fresh page first and only then awaits app readiness through this.
   */
  /**
   * What this page's realtime layer believes about itself, as one line for a failure message.
   *
   * Reads the fork's own handles rather than the network: connection status is what the client
   * ACTS on, and a socket that is open while the client thinks it is not is the #100 shape.
   */
  public async describeRealtimeState(): Promise<string> {
    return await this.page.evaluate(() => {
      const w = window as any;
      const statuses = w.rootScope?.connectionStatus ?? {};
      const keys = Object.keys(statuses);
      return JSON.stringify({
        hasAppImManager: !!w.appImManager,
        hasManagers: !!w.rootScope?.managers,
        myId: String(w.rootScope?.myId ?? ''),
        connectionStatusKeys: keys,
        connectionStatuses: keys.map((key) => `${key}=${JSON.stringify(statuses[key])}`),
        sentEvents: (w.__impulseSentEvents ?? []).length,
        // The half the console never states: does this device hold a socket, and did anything
        // ever arrive on it.
        sockets: (w.__impulseWire?.sockets ?? []).map((socket: any) => ({
          url: socket.url,
          opened: socket.opened,
          frames: socket.frames,
          closed: socket.closed
        }))
      });
    }).catch((error) => `<unreadable: ${String(error)}>`);
  }


  public async waitForImReady(): Promise<void> {
    await this.page.waitForFunction(() => {
      const w = window as any;
      return !document.body.classList.contains('has-auth-pages') && !!w.appImManager && !!w.rootScope?.managers;
    }, undefined, {timeout: 180_000});

    // Standing ack recorder: every 'message_sent' the worker mirrors onto the main-thread
    // rootScope is logged, so a send that never settles can be split into "the ack never
    // reached the main thread" vs "the ack arrived and the DOM rebind dropped it"
    // (waitForOutgoingSettled quotes this on timeout). Re-armed after reloads because
    // every reload path passes through here.
    await this.page.evaluate(() => {
      const w = window as any;
      if(w.__impulseSentEvents) {
        return;
      }
      w.__impulseSentEvents = [];
      w.rootScope.addEventListener('message_sent', (payload: any) => {
        w.__impulseSentEvents.push({
          tempId: String(payload?.tempId),
          mid: String(payload?.mid),
          at: Date.now()
        });
      });
    });
  }


  /**
   * What this page's MANAGERS hold for the open chat, independent of what the DOM shows.
   *
   * "The message never arrived" and "the message arrived and the chat did not draw it" are
   * different defects with different owners, and a bubble assertion alone cannot tell them apart.
   * This asks the storage the bubbles are rendered from.
   */
  public async describeStoredHistory(needle: string): Promise<string> {
    return await this.page.evaluate(async(text) => {
      const w = window as any;
      const peerId = w.appImManager?.chat?.peerId;
      if(peerId === undefined) {
        return '<no chat open>';
      }

      try {
        const history = await w.rootScope.managers.appMessagesManager.getHistory({peerId, limit: 30});
        const messages: any[] = history?.history?.slice?.(0, 30) ?? [];
        const resolved = await Promise.all(messages.map((mid: any) =>
          w.rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid)
        ));
        const bodies = resolved.map((message: any) => String(message?.message ?? '')).filter(Boolean);
        return JSON.stringify({
          peerId: String(peerId),
          count: bodies.length,
          holdsTheMessage: bodies.some((body) => body.includes(text)),
          bodies: bodies.slice(0, 10)
        });
      } catch(error) {
        return `<getHistory threw: ${String(error)}>`;
      }
    }, needle).catch((error) => `<unreadable: ${String(error)}>`);
  }


  /**
   * Every console entry of the whole run that mentions the update pipeline, however old.
   *
   * The time-windowed trail is the wrong instrument for #319: the lines that decide it — a pts
   * hole, a refused update, a realtime envelope — are rare and can land well before the window,
   * while the window itself fills with rendering chatter. This filters instead of slicing.
   */
  public formatUpdatePipelineTrail(): string {
    const needles = [
      'pts hole',
      'not enough data',
      'processUpdate',
      'processUpdateMessage',
      'getDifference',
      'handleEnvelope',
      'realtime',
      'Realtime',
      'centrifug',
      'Centrifug',
      'updateNewMessage',
      'sink'
    ];
    const matched = this.consoleTrail
      .filter((entry) => needles.some((needle) => entry.text.includes(needle)))
      .slice(-60);
    if(matched.length === 0) {
      return '  <the update pipeline logged NOTHING in this page for the whole run — no envelope, ' +
        'no processUpdate, no gap, no difference>';
    }

    return matched.map((entry) => `  [${entry.kind}] ${entry.text.slice(0, 300)}`).join('\n');
  }


  /**
   * The console entries (all levels) and page errors recorded at or after `sinceMs`,
   * formatted for an assertion message — bounded so a chatty page cannot drown the red.
   */
  public formatConsoleTrailSince(sinceMs: number): string {
    const recent = this.consoleTrail.filter((entry) => entry.at >= sinceMs).slice(-40);
    if(recent.length === 0) {
      return '  (no console entries in the window)';
    }

    return recent
      .map((entry) => `  [+${entry.at - sinceMs}ms][${entry.kind}] ${entry.text.slice(0, 500)}`)
      .join('\n');
  }


  /**
   * The composer of the ACTIVE chat, not merely the first one in the document.
   *
   * The client keeps a chat per open tab, each with its own composer, and the inactive ones stay in
   * the DOM. A scenario that opens a second dialog therefore has two composers, and `.first()`
   * resolved to whichever came first in document order — visible, but overlaid by the active chat,
   * so every click was intercepted and retried until the scenario timed out with no hint that it
   * was typing into the wrong chat. Scoping to `.active` names the one the user is looking at.
   */
  private messageInput() {
    return this.page
      .locator('.chat.tabs-tab.active .input-message-input[contenteditable="true"]:not(.input-field-input-fake)')
      .first();
  }


  /**
   * Per-page diagnostic wiring on top of the console-clean invariant: the full console trail
   * (all levels, ring-capped) and the media playback instrumentation (init script, so it is
   * in place before any app code runs and survives reloads). Re-invoked by
   * restartBrowserProfile for the fresh page, mirroring consoleClean.wire.
   */
  private async wireDiagnostics(page: Page): Promise<void> {
    const push = (kind: string, text: string) => {
      this.consoleTrail.push({at: Date.now(), kind, text});
      if(this.consoleTrail.length > consoleTrailCap) {
        this.consoleTrail.splice(0, this.consoleTrail.length - consoleTrailCap);
      }
    };

    page.on('console', (message) => {
      push(message.type(), message.text());
    });
    page.on('pageerror', (error) => {
      push('pageerror', `${error.message}\n${error.stack ?? ''}`);
    });

    // The realtime wire, recorded from INSIDE the page and before any of its scripts run.
    // #319 turns on one fact no console line states: whether this device holds a websocket to
    // Centrifugo at all, and whether anything ever arrived on it. A device that is silent because
    // it has no socket and a device that is silent because it drops what arrives are different
    // defects, and the console cannot tell them apart.
    await page.addInitScript(() => {
      const w = window as any;
      if(w.__impulseWire) {
        return;
      }

      w.__impulseWire = {sockets: [] as any[]};
      const NativeWebSocket = w.WebSocket;
      w.WebSocket = function(url: string, protocols?: any) {
        const record = {url: String(url), opened: false, frames: 0, closed: null as any, at: Date.now()};
        w.__impulseWire.sockets.push(record);
        const socket = protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
        socket.addEventListener('open', () => {
          record.opened = true;
        });
        socket.addEventListener('message', () => {
          record.frames += 1;
        });
        socket.addEventListener('close', (event: any) => {
          record.closed = {code: event?.code, reason: event?.reason};
        });
        return socket;
      } as any;
      w.WebSocket.prototype = NativeWebSocket.prototype;
      for(const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        w.WebSocket[key] = NativeWebSocket[key];
      }
    });

    await installMediaDiagnostics(page);
  }


  private static async launchPersistent(userDataDir: string, baseUrl: string): Promise<BrowserContext> {
    return chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: {width: 1280, height: 800},
      baseURL: baseUrl
    });
  }


  private async waitForOwnBubbleWithText(text: string): Promise<void> {
    await this.page.waitForFunction((needle) => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      return Array.from(container.querySelectorAll('.bubble[data-mid]'))
        .some((bubble) => {
          return bubble.textContent.includes(needle) &&
            !bubble.classList.contains('is-outgoing') &&
            !bubble.classList.contains('is-sending') &&
            !bubble.classList.contains('is-error');
        });
    }, text, {timeout: 60_000});
  }
}
