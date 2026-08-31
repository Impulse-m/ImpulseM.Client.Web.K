import {readFileSync} from 'fs';
import {join} from 'path';

import {Browser, BrowserContext, chromium, Page, expect} from '@playwright/test';

import {devStackTestCode, Persona} from '../../src/tests/liveharness/personas';
import {ConsoleCleanInvariant} from './invariants';

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


export function roundNoteFixtures(): {webmBase64: string, posterBase64: string} {
  return {
    webmBase64: readFileSync(join(liveharnessFixturesDir, 'round-note-vp8-opus.webm')).toString('base64'),
    posterBase64: readFileSync(join(liveharnessFixturesDir, 'round-note-poster-400.jpg')).toString('base64')
  };
}


export class PersonaSession {
  public readonly persona: Persona;
  public page: Page;
  public readonly consoleClean: ConsoleCleanInvariant;

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


  public static async open(browser: Browser, persona: Persona): Promise<PersonaSession> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleClean = await ConsoleCleanInvariant.attach(page, persona.firstName);
    return new PersonaSession(persona, context, page, consoleClean);
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
    return new PersonaSession(persona, context, page, consoleClean, userDataDir, baseUrl);
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
    await this.page.goto('/', {waitUntil: 'domcontentloaded'});
  }


  public async signUpThroughUi(): Promise<void> {
    await this.page.goto('/', {waitUntil: 'domcontentloaded'});

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

    // The dev stack answers auth.sendCode with the scripted code (see liveharness/personas.ts).
    const codeInput = this.page.locator('input[autocomplete="one-time-code"]');
    await codeInput.waitFor({state: 'visible', timeout: 60_000});
    await codeInput.click();
    await this.page.keyboard.type(devStackTestCode, {delay: 60});

    // Ephemeral personas are unique per run, so the flow deterministically lands on the
    // sign-up card (auth.authorizationSignUpRequired).
    const nameInput = this.page.locator('.input-field-input[contenteditable="true"]:not(.input-field-input-fake)').first();
    await nameInput.waitFor({state: 'visible', timeout: 60_000});
    await nameInput.click();
    await this.page.keyboard.type(this.persona.firstName, {delay: 20});

    const lastNameInput = this.page.locator('.input-field-input[contenteditable="true"]:not(.input-field-input-fake)').nth(1);
    await lastNameInput.click();
    await this.page.keyboard.type(this.persona.lastName, {delay: 20});

    await this.page.getByRole('button', {name: 'Start Messaging', exact: true}).click();

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


  public async sendTextThroughUi(text: string): Promise<void> {
    const input = this.messageInput();
    await input.click();
    await this.page.keyboard.type(text, {delay: 10});
    await this.page.keyboard.press('Enter');
    await this.waitForOwnBubbleWithText(text);
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

    await this.waitForOutgoingSettled();
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

    await this.waitForOutgoingSettled();
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
    await round.locator('canvas.video-round-canvas').click();

    await this.page.waitForFunction(() => {
      const w = window as any;
      const playing: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
      const started = !!document.querySelector('.media-round[data-mid] video.media-video.hide');
      return started && !!playing && !playing.paused && playing.currentTime > 0;
    }, undefined, {timeout: 60_000}).catch(() => {
      throw new Error(
        `the round note on the ${side} side never started playing after a click on its bubble — ` +
        'the user-visible shape of issue #91 (eternal spinner: the click resolves against a stale ' +
        'temp message/document and the download never produces playable media)'
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
   * Ack discipline for outgoing sends: bubbles carry is-outgoing/is-sending until the server
   * ack rebinds them (bubbles.ts:964,1170); an is-error bubble is an immediate, named failure
   * rather than a timeout.
   */
  public async waitForOutgoingSettled(): Promise<void> {
    await this.page.waitForFunction(() => {
      const container: HTMLElement | undefined = (window as any).appImManager?.chat?.bubbles?.container;
      if(!container) {
        return false;
      }

      if(container.querySelector('.bubble.is-error')) {
        throw new Error('an outgoing bubble entered is-error state — the send failed at the server or the transport');
      }

      return !container.querySelector('.bubble.is-outgoing, .bubble.is-sending');
    }, undefined, {timeout: 120_000});
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
   * Public for the warm-cache flow: after restartBrowserProfile the SPEC verifies storage
   * survival on the fresh page first and only then awaits app readiness through this.
   */
  public async waitForImReady(): Promise<void> {
    await this.page.waitForFunction(() => {
      const w = window as any;
      return !document.body.classList.contains('has-auth-pages') && !!w.appImManager && !!w.rootScope?.managers;
    }, undefined, {timeout: 180_000});
  }


  private messageInput() {
    return this.page.locator('.input-message-input[contenteditable="true"]:not(.input-field-input-fake)').first();
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
