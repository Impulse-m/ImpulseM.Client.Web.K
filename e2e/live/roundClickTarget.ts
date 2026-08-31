import {Page} from '@playwright/test';

import {captureMediaDiagnostics, describePlaybackFailure, MediaElementState} from './mediaPlayback';
import type {PersonaSession} from './personaSession';

/*
 * Issue #112 instrumentation: "the user taps a round video note and nothing happens".
 *
 * The existing round-note scenario clicks a HAND-PICKED node (canvas.video-round-canvas — the
 * element wrappers/video.ts happens to attach its handler to), which cannot see the defect at
 * all: a user does not aim at a node, they tap the circle, and whatever the browser decides is
 * topmost at that pixel is what receives the event. This module drives that gesture — a real
 * trusted mouse press at the geometric centre of the rendered circle, through page.mouse, with
 * NO actionability retargeting — and, when nothing plays, captures the four facts that separate
 * the possible causes of a dead tap:
 *
 *   - the hit stack at the tapped pixel (document.elementsFromPoint), each layer with the
 *     computed position / z-index / pointer-events that put it there — this alone settles
 *     whether some sibling is intercepting the tap;
 *   - which elements of the round bubble actually carry a click/mousedown listener (recorded by
 *     wrapping addEventListener from before app boot), and whether the topmost hit layer is one
 *     of them or an ancestor of one — a listener on a node the user never hits is a dead tap
 *     even though every element and every byte is healthy;
 *   - the click/mousedown events the document actually observed, with their targets — so a tap
 *     that the browser never delivered is distinguishable from one delivered to the wrong node;
 *   - the media state (play() call count, readyState, networkState, MediaError, whether
 *     appMediaPlaybackController holds a playingMedia), reusing the lane's media diagnostics.
 */
export type HitStackLayer = {
  depth: number,
  tag: string,
  className: string,
  position: string,
  zIndex: string,
  pointerEvents: string,
  inRoundBubble: boolean,
  listenerTypes: string[],
  hasListener: boolean
};

export type RoundBubbleNode = {
  path: string,
  tag: string,
  className: string,
  position: string,
  zIndex: string,
  pointerEvents: string,
  rect: string,
  coversTapPoint: boolean,
  listenerTypes: string[]
};

export type ObservedPointerEvent = {
  type: string,
  isTrusted: boolean,
  targetTag: string,
  targetClassName: string,
  clientX: number,
  clientY: number,
  at: number
};

export type RoundClickProbe = {
  bubbleFound: boolean,
  tapX: number,
  tapY: number,
  hitStack: HitStackLayer[],
  bubbleNodes: RoundBubbleNode[],
  handlerBearingNodes: string[],
  topmostHitReachesHandler: boolean,
  tapPathReachesRoundHandler: boolean,
  tapPathTopmost: string,
  observedEvents: ObservedPointerEvent[],
  playingMediaPresent: boolean,
  playingMediaPaused: boolean,
  playingMediaCurrentTime: number,
  playingMediaReadyState: number,
  playingMediaNetworkState: number,
  bubbleShowsPaused: boolean,
  previewVideoHidden: boolean,
  spinnerOverCircle: boolean,
  previewIsMoving: boolean
};

export type RoundTapOutcome = {
  played: boolean,
  report: string,
  /**
   * The state of the tapped pixel just before the press, kept on GREEN runs too: the layer the
   * user's finger actually lands on and whether it reaches the round bubble's own tap handler is
   * the evidence for or against every layering theory of a dead tap, and a scenario that only
   * captures it when it fails cannot testify that the layering is sound when it passes.
   */
  hitSummary: string
};

/** How long the tapped note is given to become moving video before the tap counts as dead. */
const playbackWindowMs = 30_000;


/*
 * The probe body, installed both as an init script (so it survives a reload) and into the page
 * as it stands (so no scenario has to reload to arm it). It is idempotent: whichever runs
 * first wins and the other returns immediately.
 *
 * Arming it after boot is enough for what it must see: the round bubble registers its tap
 * handler when the bubble is RENDERED, which for the message under test is always after the
 * scenario has armed the probe.
 */
const probeBody = () => {
  if((window as any).__impulseRoundClickProbe) {
    return;
  }

  const probe = {
    observedEvents: [] as ObservedPointerEvent[]
  };
  (window as any).__impulseRoundClickProbe = probe;

  // Which node carries the tap handler is the whole question of issue #112, and nothing in
  // the DOM exposes it — so record it at registration time. Only the two types
  // attachClickEvent can ever register (CLICK_EVENT_NAME is 'click' or 'mousedown') are
  // tracked, so the wrap stays a no-op for every other listener the app installs.
  const trackedTypes = new Set(['click', 'mousedown']);
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    try {
      if(trackedTypes.has(type) && this instanceof Element) {
        const element = this as any;
        if(!element.__impulseListenerTypes) {
          element.__impulseListenerTypes = new Set<string>();
        }
        element.__impulseListenerTypes.add(type);
      }
    } catch(ignored) {
      // instrumentation must never break the app's own event wiring
    }

    return originalAddEventListener.call(this, type, listener, options);
  };

  const describeTarget = (target: EventTarget | null): {tag: string, className: string} => {
    if(!(target instanceof Element)) {
      return {tag: 'non-element', className: ''};
    }
    return {tag: target.tagName.toLowerCase(), className: String(target.className)};
  };

  for(const type of ['mousedown', 'click']) {
    document.addEventListener(type, (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const target = describeTarget(event.target);
      probe.observedEvents.push({
        type,
        isTrusted: event.isTrusted,
        targetTag: target.tag,
        targetClassName: target.className,
        clientX: mouseEvent.clientX,
        clientY: mouseEvent.clientY,
        at: Date.now()
      });
      if(probe.observedEvents.length > 40) {
        probe.observedEvents.splice(0, probe.observedEvents.length - 40);
      }
    }, true);
  }
};


/**
 * Arms the probe on a persona's page: as an init script for any later navigation, and in the
 * page as it stands right now, so the caller does not have to reload — a reload is a state
 * change the scenario under test should not have to pay for.
 */
export async function installRoundClickProbe(page: Page): Promise<void> {
  await page.addInitScript(probeBody);
  await page.evaluate(probeBody);
}


/**
 * The state of the round bubble and of the tapped pixel, read from the page. Safe to call
 * before and after the tap; it mutates nothing.
 */
export async function captureRoundClickProbe(page: Page, tapX: number, tapY: number): Promise<RoundClickProbe> {
  return page.evaluate(({x, y}) => {
    const w = window as any;
    const observedEvents: ObservedPointerEvent[] = w.__impulseRoundClickProbe?.observedEvents ?? [];
    const rounds = document.querySelectorAll<HTMLElement>('.media-round[data-mid]');
    const round = rounds.length ? rounds[rounds.length - 1] : undefined;

    const listenerTypesOf = (element: Element): string[] => {
      const types: Set<string> | undefined = (element as any).__impulseListenerTypes;
      return types ? [...types] : [];
    };

    const describeLayer = (element: Element, depth: number) => {
      const style = getComputedStyle(element);
      const listenerTypes = listenerTypesOf(element);
      return {
        depth,
        tag: element.tagName.toLowerCase(),
        className: String(element.className),
        position: style.position,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        inRoundBubble: !!element.closest('.media-round'),
        listenerTypes,
        hasListener: listenerTypes.length > 0
      };
    };

    const hitStack = Array.from(document.elementsFromPoint(x, y)).map(describeLayer);
    const topmost = document.elementFromPoint(x, y);

    const pathOf = (element: Element, root: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while(current && current !== root.parentElement) {
        parts.unshift(`${current.tagName.toLowerCase()}${current.className ? '.' + String(current.className).trim().split(/\s+/).join('.') : ''}`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const bubbleNodes = [];
    const handlerBearingNodes: string[] = [];
    if(round) {
      const nodes = [round, ...Array.from(round.querySelectorAll('*'))];
      for(const node of nodes) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const listenerTypes = listenerTypesOf(node);
        const path = pathOf(node, round);
        bubbleNodes.push({
          path,
          tag: node.tagName.toLowerCase(),
          className: String(node.className),
          position: style.position,
          zIndex: style.zIndex,
          pointerEvents: style.pointerEvents,
          rect: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          coversTapPoint: x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
          listenerTypes
        });
        if(listenerTypes.length > 0) {
          handlerBearingNodes.push(`${path} [${listenerTypes.join(',')}]`);
        }
      }
    }

    // A tap on `topmost` reaches a handler only if the handler sits on it or on one of its
    // ancestors — a listener on a SIBLING never sees the event, however close it is on screen.
    let topmostHitReachesHandler = false;
    let cursor: Element | null = topmost;
    while(cursor) {
      if(listenerTypesOf(cursor).length > 0) {
        topmostHitReachesHandler = true;
        break;
      }
      cursor = cursor.parentElement;
    }

    // The round note's OWN handler, not the chat container's: walk from the topmost hit layer up
    // to the bubble and stop there. This is the layering question in one boolean — if the layer
    // the user presses is a sibling of the node that carries the handler, the tap is dead however
    // healthy every element and every byte is.
    let tapPathReachesRoundHandler = false;
    let tapPathTopmost = topmost ? `<${topmost.tagName.toLowerCase()} class="${String(topmost.className)}">` : '(nothing)';
    if(round && topmost && (topmost === round || round.contains(topmost))) {
      let node: Element | null = topmost;
      while(node) {
        if(listenerTypesOf(node).length > 0) {
          tapPathReachesRoundHandler = true;
          break;
        }
        node = node === round ? null : node.parentElement;
      }
    } else if(round) {
      tapPathTopmost += ' — which is NOT inside the round bubble at all';
    }

    const playing: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
    const preview = round?.querySelector<HTMLVideoElement>('video.media-video');

    return {
      bubbleFound: !!round,
      tapX: x,
      tapY: y,
      hitStack,
      bubbleNodes,
      handlerBearingNodes,
      topmostHitReachesHandler,
      tapPathReachesRoundHandler,
      tapPathTopmost,
      observedEvents,
      playingMediaPresent: !!playing,
      playingMediaPaused: playing ? playing.paused : true,
      playingMediaCurrentTime: playing ? playing.currentTime : 0,
      playingMediaReadyState: playing ? playing.readyState : -1,
      playingMediaNetworkState: playing ? playing.networkState : -1,
      bubbleShowsPaused: !!round?.classList.contains('is-paused'),
      previewVideoHidden: !!document.querySelector('.media-round[data-mid] video.media-video.hide'),
      // What the user is looking at, in two facts: is anything telling them to wait, and is the
      // circle already showing motion. A dead tap on a still, spinner-covered bubble is a loading
      // story; a dead tap on a moving circle with no spinner is the defect.
      spinnerOverCircle: !!round?.closest('.attachment')?.querySelector('.preloader-container'),
      previewIsMoving: !!preview && !preview.paused && preview.currentTime > 0
    };
  }, {x: tapX, y: tapY});
}


export function describeRoundClickProbe(probe: RoundClickProbe): string {
  const lines: string[] = [];

  lines.push(`tap point: (${Math.round(probe.tapX)}, ${Math.round(probe.tapY)}) — the centre of the rendered circle`);
  lines.push(`document.elementFromPoint at the tap point returns ${probe.tapPathTopmost}`);
  lines.push(
    `that layer reaches a tap handler ON THE ROUND BUBBLE: ${probe.tapPathReachesRoundHandler} ` +
    `(it reaches SOME handler, chat container included: ${probe.topmostHitReachesHandler})`
  );
  lines.push('hit stack at the tap point (topmost first — the layer the user actually presses is depth 0):');
  if(probe.hitStack.length === 0) {
    lines.push('  (nothing is hit-testable at the tap point)');
  }
  for(const layer of probe.hitStack) {
    lines.push(
      `  [${layer.depth}] <${layer.tag} class="${layer.className}"> position=${layer.position}, ` +
      `z-index=${layer.zIndex}, pointer-events=${layer.pointerEvents}, ` +
      `inRoundBubble=${layer.inRoundBubble}, click listeners=${layer.listenerTypes.length ? layer.listenerTypes.join(',') : 'none'}`
    );
  }

  lines.push('round bubble subtree (every node, with what the user could hit):');
  if(!probe.bubbleFound) {
    lines.push('  (no .media-round[data-mid] in the DOM)');
  }
  for(const node of probe.bubbleNodes) {
    lines.push(
      `  ${node.path} rect=${node.rect}, position=${node.position}, z-index=${node.zIndex}, ` +
      `pointer-events=${node.pointerEvents}, coversTapPoint=${node.coversTapPoint}, ` +
      `click listeners=${node.listenerTypes.length ? node.listenerTypes.join(',') : 'none'}`
    );
  }

  lines.push('nodes of the round bubble that carry a tap handler:');
  if(probe.handlerBearingNodes.length === 0) {
    lines.push('  (NONE — the bubble has no click handler anywhere in it: nothing the user presses can start playback)');
  }
  for(const node of probe.handlerBearingNodes) {
    lines.push(`  ${node}`);
  }

  lines.push('mousedown/click events the document observed (capture phase, newest last):');
  if(probe.observedEvents.length === 0) {
    lines.push('  (the document saw no pointer event at all — the tap never reached the page)');
  }
  for(const event of probe.observedEvents) {
    lines.push(
      `  ${event.type} isTrusted=${event.isTrusted} at (${Math.round(event.clientX)}, ${Math.round(event.clientY)}) ` +
      `-> <${event.targetTag} class="${event.targetClassName}">`
    );
  }

  lines.push(
    `playback controller: playingMedia=${probe.playingMediaPresent}, paused=${probe.playingMediaPaused}, ` +
    `currentTime=${probe.playingMediaCurrentTime}, readyState=${probe.playingMediaReadyState}, ` +
    `networkState=${probe.playingMediaNetworkState}`
  );
  lines.push(
    `what the user sees: spinner over the circle=${probe.spinnerOverCircle}, ` +
    `the circle's preview is moving=${probe.previewIsMoving}, ` +
    `bubble marked paused=${probe.bubbleShowsPaused}, preview hidden behind the canvas=${probe.previewVideoHidden}`
  );

  return lines.join('\n');
}


/**
 * The gesture under test: press the centre of the visible circle the way a finger or a cursor
 * does. page.mouse is used deliberately — Playwright's locator.click() would resolve the
 * actionability of a node the author picked and refuse or retarget when something covers it,
 * which is precisely the condition the user runs into and the scenario must be able to observe.
 *
 * Never throws for a dead tap: it returns the outcome plus a full report, so ONE scenario run
 * can exercise both sides of the exchange and name every side that failed.
 */
export async function tapRoundNoteLikeAUser(session: PersonaSession, side: string): Promise<RoundTapOutcome> {
  const page = session.page;
  const round = page.locator('.media-round[data-mid]').last();
  await round.waitFor({state: 'visible', timeout: 90_000});

  // Tap only once the client has stopped asking the user to wait. A dead tap on a bubble that is
  // still showing its progress spinner is arguable ("it was uploading"); a dead tap on a circle
  // the client itself has declared finished is not. The wait polls on animation frames so the
  // press lands in the first frame after the spinner goes — where the user's thumb lands too.
  await page.waitForFunction(() => {
    const rounds = document.querySelectorAll<HTMLElement>('.media-round[data-mid]');
    const bubble = rounds.length ? rounds[rounds.length - 1] : undefined;
    return !!bubble && !bubble.closest('.attachment')?.querySelector('.preloader-container');
  }, undefined, {timeout: 120_000, polling: 'raf'}).catch(() => {
    // Not fatal on its own: the tap goes in anyway and the report below carries the spinner
    // state, so a note that never finishes is named as such instead of vanishing into a wait.
  });

  await round.scrollIntoViewIfNeeded({timeout: 30_000});

  const box = await round.boundingBox();
  if(!box) {
    return {
      played: false,
      hitSummary: `[${side}] the round-note bubble has no layout box, so there was no pixel to probe`,
      report: `[${side}] the round-note bubble is in the DOM but has no layout box at all — the ` +
        'user is looking at a chat where the round note occupies no pixels, so there is nothing to tap'
    };
  }

  const tapX = box.x + box.width / 2;
  const tapY = box.y + box.height / 2;
  const before = await captureRoundClickProbe(page, tapX, tapY);
  const hitSummary = `[${side}] state of the tapped pixel before the press:\n${describeRoundClickProbe(before)}`;

  // Non-vacuity, asserted rather than assumed: the note must be SILENT before the tap, so the
  // green below can only mean the tap started it. Without this a scenario that stopped tapping
  // altogether — or one whose playback signal is satisfied by something else on the page —
  // would pass while the user's gesture does nothing.
  if(before.playingMediaPresent && !before.playingMediaPaused) {
    return {
      played: false,
      hitSummary,
      report: `[${side}] the round note was ALREADY playing before the tap, so this run cannot ` +
        'attribute playback to the user\'s gesture — the scenario refuses to report a green it ' +
        'did not earn.\n' +
        describeRoundClickProbe(before)
    };
  }

  const tapAt = Date.now();

  await page.mouse.move(tapX, tapY);
  await page.mouse.click(tapX, tapY);

  const played = await page
    .waitForFunction(() => {
      const w = window as any;
      const playing: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
      const rounds = document.querySelectorAll<HTMLElement>('.media-round[data-mid]');
      const tapped = rounds.length ? rounds[rounds.length - 1] : undefined;
      // Moving video for the user: the app's playback controller holds a media whose clock is
      // past zero and running, AND the tapped bubble has left its paused presentation — so a
      // note playing somewhere else in the session can never satisfy the tapped one.
      return !!playing && !playing.paused && playing.currentTime > 0 && !!tapped && !tapped.classList.contains('is-paused');
    }, undefined, {timeout: playbackWindowMs})
    .then(() => true)
    .catch(() => false);

  if(played) {
    return {played: true, hitSummary, report: ''};
  }

  const after = await captureRoundClickProbe(page, tapX, tapY);
  const diagnostics = await captureMediaDiagnostics(page);
  const roundSrcs = new Set(
    diagnostics.elements
      .filter((state: MediaElementState) => state.inRoundBubble && state.currentSrc)
      .map((state: MediaElementState) => state.currentSrc)
  );
  const relevant = diagnostics.elements.filter((state: MediaElementState) => {
    return state.inRoundBubble || state.isPlaybackControllerMedia || roundSrcs.has(state.currentSrc);
  });

  return {
    played: false,
    hitSummary,
    report: [
      `[${side}] the round video note did not start playing within ${playbackWindowMs}ms of a real ` +
      'press on the centre of its circle.',
      '--- page state BEFORE the tap ---',
      describeRoundClickProbe(before),
      '--- page state AFTER the tap ---',
      describeRoundClickProbe(after),
      '--- media lanes ---',
      describePlaybackFailure(diagnostics, relevant),
      '--- console around the tap ---',
      session.formatConsoleTrailSince(tapAt - 2_000)
    ].join('\n')
  };
}
