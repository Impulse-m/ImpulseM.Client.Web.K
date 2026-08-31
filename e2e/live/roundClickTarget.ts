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
 * NO actionability retargeting — and, when nothing plays, captures the facts that separate the
 * possible causes of a dead tap:
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
 *   - whether the press the bubble received was CANCELLED. The round bubble's playback toggle
 *     opens with cancelEvent(e) (wrappers/video.ts), which stops propagation and prevents the
 *     default, so a press that reaches the document's own bubble-phase listener with
 *     defaultPrevented still false is a press NO round-note toggle ran for. Together with "the
 *     bubble does carry a tap listener" that is the honest, production-unchanged signature of a
 *     press the buffering listener swallowed and never replayed — the arm never happened;
 *   - the state the bubble is in: whether it still carries the deferred-onLoad marker
 *     (data-is-outgoing), whether its message still says pFlags.is_outgoing, and whether it has
 *     ever shown the paused presentation that only onLoad can produce;
 *   - what appMediaPlaybackController holds for THAT note's (peerId, mid) — the shared element
 *     onLoad registers — with its src, readiness and the number of play() calls it has ever
 *     received, which separates "the handler never ran" from "the handler ran and playback
 *     failed";
 *   - the media state overall, reusing the lane's media diagnostics.
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
  targetElementId: number,
  targetRoundMid: string,
  /** Read after the event finished dispatching — true only if some handler called preventDefault. */
  defaultPrevented: boolean,
  /** False when a handler called stopPropagation before the document's bubble phase. */
  reachedDocumentBubblePhase: boolean,
  clientX: number,
  clientY: number,
  at: number
};

/**
 * Which round note of the dialog the gesture is aimed at. `{mid}` names one exactly — the only
 * way to say "the OLDEST one" in a chat that holds several. 'newest' follows the last bubble in
 * the DOM, which is what a scenario tapping a note whose mid is still changing (an unacked send)
 * has to do.
 */
export type RoundNoteTarget = {mid: string} | 'newest';

export type RoundClickProbe = {
  bubbleFound: boolean,
  targetMid: string,
  targetPeerId: string,
  /** Every round note in the dialog, oldest mid first — so a report names WHICH one was tapped. */
  midsInDialog: string[],
  /** message.pFlags.is_outgoing on the message the bubble still carries. */
  messageIsOutgoing: boolean,
  /** data-is-outgoing on the bubble: wrappers/video.ts sets it when it DEFERS onLoad. */
  bubbleCarriesDeferredMarker: boolean,
  /** The circle itself carries a tap listener — i.e. attachRoundPlaybackTap ran when it was built. */
  bubbleCarriesTapListener: boolean,
  tapX: number,
  tapY: number,
  hitStack: HitStackLayer[],
  bubbleNodes: RoundBubbleNode[],
  handlerBearingNodes: string[],
  topmostHitReachesHandler: boolean,
  tapPathReachesRoundHandler: boolean,
  tapPathTopmost: string,
  observedEvents: ObservedPointerEvent[],
  pressesInsideTargetBubble: number,
  pressesInsideTargetBubbleThatWereCancelled: number,
  playingMediaPresent: boolean,
  playingMediaPaused: boolean,
  playingMediaCurrentTime: number,
  playingMediaReadyState: number,
  playingMediaNetworkState: number,
  /** appMediaPlaybackController's shared element for THIS note's (peerId, mid). */
  noteMediaPresent: boolean,
  noteMediaIsPlayingMedia: boolean,
  noteMediaSrc: string,
  noteMediaPaused: boolean,
  noteMediaCurrentTime: number,
  noteMediaReadyState: number,
  noteMediaNetworkState: number,
  noteMediaErrorCode: number,
  noteMediaErrorMessage: string,
  /** play() invocations the lane's media instrumentation recorded on THAT element, ever. */
  playCallsOnNoteMedia: number,
  bubbleShowsPaused: boolean,
  previewVideoHidden: boolean,
  spinnerOverCircle: boolean,
  previewIsMoving: boolean
};

export type RoundTapOutcome = {
  played: boolean,
  /** The side label the scenario gave this gesture, so a collected outcome names itself. */
  side: string,
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

  const elementIds = new WeakMap<Element, number>();
  let nextElementId = 1;
  const identify = (target: EventTarget | null): number => {
    if(!(target instanceof Element)) {
      return 0;
    }

    let id = elementIds.get(target);
    if(!id) {
      elementIds.set(target, id = nextElementId++);
    }
    return id;
  };

  const describeTarget = (target: EventTarget | null): {tag: string, className: string, roundMid: string} => {
    if(!(target instanceof Element)) {
      return {tag: 'non-element', className: '', roundMid: ''};
    }

    const round = target.closest<HTMLElement>('.media-round[data-mid]');
    return {
      tag: target.tagName.toLowerCase(),
      className: String(target.className),
      roundMid: round?.dataset.mid ?? ''
    };
  };

  for(const type of ['mousedown', 'click']) {
    document.addEventListener(type, (event: Event) => {
      const mouseEvent = event as MouseEvent;
      const target = describeTarget(event.target);
      const record: ObservedPointerEvent = {
        type,
        isTrusted: event.isTrusted,
        targetTag: target.tag,
        targetClassName: target.className,
        targetElementId: identify(event.target),
        targetRoundMid: target.roundMid,
        defaultPrevented: false,
        reachedDocumentBubblePhase: false,
        clientX: mouseEvent.clientX,
        clientY: mouseEvent.clientY,
        at: Date.now()
      };
      (event as any).__impulseEventRecord = record;
      probe.observedEvents.push(record);

      // The cancellation state is only meaningful once dispatch is over: the round bubble's own
      // playback toggle opens with cancelEvent(), so a press that ends up NOT default-prevented
      // is a press no toggle ran for.
      setTimeout(() => {
        record.defaultPrevented = event.defaultPrevented;
      }, 0);

      if(probe.observedEvents.length > 40) {
        probe.observedEvents.splice(0, probe.observedEvents.length - 40);
      }
    }, true);

    // Bubble phase on the document: reached only when nothing along the way called
    // stopPropagation — which the round bubble's toggle always does.
    document.addEventListener(type, (event: Event) => {
      const record: ObservedPointerEvent | undefined = (event as any).__impulseEventRecord;
      if(record) {
        record.reachedDocumentBubblePhase = true;
      }
    }, false);
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
 * Every round note the open dialog is showing, oldest first (mid order — message ids grow with
 * time), so a scenario can name the note a user tapped instead of trusting DOM order.
 */
export async function roundNoteMidsOldestFirst(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>('.media-round[data-mid]'))
      .map((element) => element.dataset.mid ?? '')
      .filter((mid) => mid !== '')
      .sort((a, b) => Number(a) - Number(b));
  });
}


/**
 * Waits until the open dialog is showing at least `expected` round-note bubbles — a scenario
 * that taps "the oldest of three" must not start before all three are rendered.
 */
export async function waitForRoundNoteCount(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    return document.querySelectorAll('.media-round[data-mid]').length >= count;
  }, expected, {timeout: 120_000}).catch(async() => {
    const shown = await page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLElement>('.bubble[data-mid]')).map((bubble) => {
        return `${bubble.dataset.mid}: ${bubble.className} (round notes inside: ${bubble.querySelectorAll('.media-round').length})`;
      });
    }).catch((): string[] => []);

    throw new Error(
      `the chat is showing ${shown.length} message bubbles and fewer than ${expected} round notes ` +
      'two minutes after it was asked for them — the user is looking at a conversation that has ' +
      'lost round notes the server still holds (the other side of the exchange has them all). ' +
      `Bubbles actually rendered:\n  ${shown.join('\n  ') || '(none)'}`
    );
  });
}


/**
 * Test plumbing between two taps, not a gesture under test: pauses whatever the playback
 * controller is currently playing, so the NEXT tap can be asserted against a silent page. The
 * assertion that a note is silent before it is tapped lives in tapRoundNoteLikeAUser; this only
 * makes the silence happen.
 */
export async function stopRoundPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const playing: HTMLMediaElement | undefined = (window as any).appMediaPlaybackController?.playingMedia;
    playing?.pause();
  });

  await page.waitForFunction(() => {
    const playing: HTMLMediaElement | undefined = (window as any).appMediaPlaybackController?.playingMedia;
    return !playing || playing.paused;
  }, undefined, {timeout: 15_000});
}


/**
 * The state of the round bubble and of the tapped pixel, read from the page. Safe to call
 * before and after the tap; it mutates nothing.
 */
export async function captureRoundClickProbe(
  page: Page,
  tapX: number,
  tapY: number,
  targetMid: string | null
): Promise<RoundClickProbe> {
  return page.evaluate(({x, y, mid}) => {
    const w = window as any;
    const observedEvents: ObservedPointerEvent[] = w.__impulseRoundClickProbe?.observedEvents ?? [];
    const rounds = Array.from(document.querySelectorAll<HTMLElement>('.media-round[data-mid]'));
    const round = mid === null ?
      (rounds.length ? rounds[rounds.length - 1] : undefined) :
      rounds.find((element) => element.dataset.mid === mid);

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

    const message = round ? (round as any).message : undefined;
    const notePeerId = message ? message.peerId : Number(round?.dataset.peerId);
    const noteMid = message ? message.mid : Number(round?.dataset.mid);
    const controller = w.appMediaPlaybackController;
    const playing: HTMLMediaElement | undefined = controller?.playingMedia;
    // The shared element onLoad registers for this note. Its absence means no code path has ever
    // called addMedia for this (peerId, mid) — neither the bubble's own onLoad nor a neighbour's
    // playlist loader.
    const noteMedia: HTMLMediaElement | undefined = round && controller?.getMedia ?
      controller.getMedia(notePeerId, noteMid, !!message?.pFlags?.is_scheduled) :
      undefined;
    const playCalls: {elementId: number}[] = w.__impulseMediaDiag?.playCalls ?? [];
    const noteMediaId: number = noteMedia && w.__impulseMediaIdOf ? w.__impulseMediaIdOf(noteMedia) : 0;
    const preview = round?.querySelector<HTMLVideoElement>('video.media-video');
    const targetMidValue = round?.dataset.mid ?? '';
    const pressesInside = observedEvents.filter((event) => event.targetRoundMid === targetMidValue && targetMidValue !== '');

    return {
      bubbleFound: !!round,
      targetMid: targetMidValue,
      targetPeerId: round?.dataset.peerId ?? '',
      midsInDialog: rounds
        .map((element) => element.dataset.mid ?? '')
        .sort((a, b) => Number(a) - Number(b)),
      messageIsOutgoing: !!message?.pFlags?.is_outgoing,
      bubbleCarriesDeferredMarker: round?.dataset.isOutgoing === '1',
      bubbleCarriesTapListener: !!round && listenerTypesOf(round).length > 0,
      tapX: x,
      tapY: y,
      hitStack,
      bubbleNodes,
      handlerBearingNodes,
      topmostHitReachesHandler,
      tapPathReachesRoundHandler,
      tapPathTopmost,
      observedEvents,
      pressesInsideTargetBubble: pressesInside.length,
      pressesInsideTargetBubbleThatWereCancelled: pressesInside.filter((event) => event.defaultPrevented).length,
      playingMediaPresent: !!playing,
      playingMediaPaused: playing ? playing.paused : true,
      playingMediaCurrentTime: playing ? playing.currentTime : 0,
      playingMediaReadyState: playing ? playing.readyState : -1,
      playingMediaNetworkState: playing ? playing.networkState : -1,
      noteMediaPresent: !!noteMedia,
      noteMediaIsPlayingMedia: !!noteMedia && noteMedia === playing,
      noteMediaSrc: noteMedia ? (noteMedia.currentSrc || noteMedia.getAttribute('src') || '') : '',
      noteMediaPaused: noteMedia ? noteMedia.paused : true,
      noteMediaCurrentTime: noteMedia ? noteMedia.currentTime : 0,
      noteMediaReadyState: noteMedia ? noteMedia.readyState : -1,
      noteMediaNetworkState: noteMedia ? noteMedia.networkState : -1,
      noteMediaErrorCode: noteMedia?.error?.code ?? 0,
      noteMediaErrorMessage: noteMedia?.error?.message ?? '',
      playCallsOnNoteMedia: noteMediaId ? playCalls.filter((call) => call.elementId === noteMediaId).length : 0,
      bubbleShowsPaused: !!round?.classList.contains('is-paused'),
      previewVideoHidden: !!preview?.classList.contains('hide'),
      // What the user is looking at, in two facts: is anything telling them to wait, and is the
      // circle already showing motion. A dead tap on a still, spinner-covered bubble is a loading
      // story; a dead tap on a moving circle with no spinner is the defect.
      spinnerOverCircle: !!round?.closest('.attachment')?.querySelector('.preloader-container'),
      previewIsMoving: !!preview && !preview.paused && preview.currentTime > 0
    };
  }, {x: tapX, y: tapY, mid: targetMid});
}


export function describeRoundClickProbe(probe: RoundClickProbe): string {
  const lines: string[] = [];

  lines.push(
    `the note under the finger: mid=${probe.targetMid || '(none)'}, peerId=${probe.targetPeerId || '(none)'} — ` +
    `the dialog is showing round notes ${probe.midsInDialog.join(', ') || '(none)'} (oldest mid first)`
  );
  lines.push(`tap point: (${Math.round(probe.tapX)}, ${Math.round(probe.tapY)}) — the centre of the rendered circle`);
  lines.push(`document.elementFromPoint at the tap point returns ${probe.tapPathTopmost}`);
  lines.push(
    `that layer reaches a tap handler ON THE ROUND BUBBLE: ${probe.tapPathReachesRoundHandler} ` +
    `(it reaches SOME handler, chat container included: ${probe.topmostHitReachesHandler})`
  );
  lines.push(
    `the circle itself carries a tap listener: ${probe.bubbleCarriesTapListener} — so a press is ` +
    'received by the bubble whether or not a playback toggle has been armed behind it'
  );
  lines.push(
    `presses this run delivered inside THIS bubble: ${probe.pressesInsideTargetBubble}, of which ` +
    `${probe.pressesInsideTargetBubbleThatWereCancelled} were cancelled (the playback toggle opens ` +
    'with cancelEvent, so an uncancelled press is a press NO toggle ran for — swallowed by the ' +
    'buffering listener and never replayed)'
  );
  lines.push(
    `the bubble still carries the deferred-onLoad marker (data-is-outgoing): ${probe.bubbleCarriesDeferredMarker}; ` +
    `its message still says pFlags.is_outgoing: ${probe.messageIsOutgoing}; ` +
    `it has the paused presentation only onLoad can produce: ${probe.bubbleShowsPaused}`
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
    lines.push('  (the round note this gesture aimed at is not in the DOM)');
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
      `-> <${event.targetTag} class="${event.targetClassName}"> element#${event.targetElementId} ` +
      `roundMid=${event.targetRoundMid || '(outside any round note)'} ` +
      `defaultPrevented=${event.defaultPrevented} reachedDocumentBubblePhase=${event.reachedDocumentBubblePhase}`
    );
  }

  lines.push(
    `playback controller: playingMedia=${probe.playingMediaPresent}, paused=${probe.playingMediaPaused}, ` +
    `currentTime=${probe.playingMediaCurrentTime}, readyState=${probe.playingMediaReadyState}, ` +
    `networkState=${probe.playingMediaNetworkState}`
  );
  lines.push(
    `what appMediaPlaybackController holds for THIS note (peerId=${probe.targetPeerId}, mid=${probe.targetMid}): ` +
    `element present=${probe.noteMediaPresent}` +
    (probe.noteMediaPresent ?
      `, is the currently playing media=${probe.noteMediaIsPlayingMedia}, src=${probe.noteMediaSrc || 'NO SOURCE'}, ` +
      `paused=${probe.noteMediaPaused}, currentTime=${probe.noteMediaCurrentTime}, ` +
      `readyState=${probe.noteMediaReadyState}, networkState=${probe.noteMediaNetworkState}, ` +
      `MediaError=${probe.noteMediaErrorCode || 'none'}${probe.noteMediaErrorMessage ? ` "${probe.noteMediaErrorMessage}"` : ''}, ` +
      `play() calls on it this run=${probe.playCallsOnNoteMedia}` :
      ' — nothing has ever registered playback media for this note, so onLoad has not run for it')
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
 * `target` names the note: `{mid}` for a specific one (the only way to aim at the OLDEST note of
 * a dialog that holds several), 'newest' for the last bubble in the DOM.
 *
 * Never throws for a dead tap: it returns the outcome plus a full report, so ONE scenario run
 * can exercise every surface of the exchange and name every one that failed.
 */
export async function tapRoundNoteLikeAUser(
  session: PersonaSession,
  side: string,
  target: RoundNoteTarget = 'newest'
): Promise<RoundTapOutcome> {
  const page = session.page;
  const targetMid = target === 'newest' ? null : target.mid;
  const round = targetMid === null ?
    page.locator('.media-round[data-mid]').last() :
    page.locator(`.media-round[data-mid="${targetMid}"]`);
  await round.waitFor({state: 'visible', timeout: 90_000});

  // Tap only once the client has stopped asking the user to wait. A dead tap on a bubble that is
  // still showing its progress spinner is arguable ("it was uploading"); a dead tap on a circle
  // the client itself has declared finished is not. The wait polls on animation frames so the
  // press lands in the first frame after the spinner goes — where the user's thumb lands too.
  await page.waitForFunction((mid) => {
    const rounds = Array.from(document.querySelectorAll<HTMLElement>('.media-round[data-mid]'));
    const bubble = mid === null ?
      (rounds.length ? rounds[rounds.length - 1] : undefined) :
      rounds.find((element) => element.dataset.mid === mid);
    return !!bubble && !bubble.closest('.attachment')?.querySelector('.preloader-container');
  }, targetMid, {timeout: 120_000, polling: 'raf'}).catch(() => {
    // Not fatal on its own: the tap goes in anyway and the report below carries the spinner
    // state, so a note that never finishes is named as such instead of vanishing into a wait.
  });

  await round.scrollIntoViewIfNeeded({timeout: 30_000});

  const box = await round.boundingBox();
  if(!box) {
    return {
      played: false,
      side,
      hitSummary: `[${side}] the round-note bubble has no layout box, so there was no pixel to probe`,
      report: `[${side}] the round-note bubble is in the DOM but has no layout box at all — the ` +
        'user is looking at a chat where the round note occupies no pixels, so there is nothing to tap'
    };
  }

  const tapX = box.x + box.width / 2;
  const tapY = box.y + box.height / 2;
  const before = await captureRoundClickProbe(page, tapX, tapY, targetMid);
  const hitSummary = `[${side}] state of the tapped pixel before the press:\n${describeRoundClickProbe(before)}`;

  // Non-vacuity, asserted rather than assumed: the note must be SILENT before the tap, so the
  // green below can only mean the tap started it. Without this a scenario that stopped tapping
  // altogether — or one whose playback signal is satisfied by something else on the page —
  // would pass while the user's gesture does nothing.
  if((before.playingMediaPresent && !before.playingMediaPaused) || (before.noteMediaPresent && !before.noteMediaPaused)) {
    return {
      played: false,
      side,
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
    .waitForFunction((mid) => {
      const w = window as any;
      const controller = w.appMediaPlaybackController;
      const playing: HTMLMediaElement | undefined = controller?.playingMedia;
      const rounds = Array.from(document.querySelectorAll<HTMLElement>('.media-round[data-mid]'));
      const tapped = mid === null ?
        (rounds.length ? rounds[rounds.length - 1] : undefined) :
        rounds.find((element) => element.dataset.mid === mid);
      if(!tapped || !playing || !controller?.getMedia) {
        return false;
      }

      // Moving video of THE TAPPED NOTE: the element the playback controller is running must be
      // the very element it holds for this note's (peerId, mid), its clock must be past zero and
      // running, and the tapped bubble must have left its paused presentation. A note playing
      // anywhere else in the session can never satisfy the tapped one.
      const message = (tapped as any).message;
      const noteMedia: HTMLMediaElement | undefined = controller.getMedia(
        message ? message.peerId : Number(tapped.dataset.peerId),
        message ? message.mid : Number(tapped.dataset.mid),
        !!message?.pFlags?.is_scheduled
      );
      return !!noteMedia &&
        noteMedia === playing &&
        !playing.paused &&
        playing.currentTime > 0 &&
        !tapped.classList.contains('is-paused');
    }, targetMid, {timeout: playbackWindowMs})
    .then(() => true)
    .catch(() => false);

  if(played) {
    return {played: true, side, hitSummary, report: ''};
  }

  const after = await captureRoundClickProbe(page, tapX, tapY, targetMid);
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
    side,
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


export type UnackedPressOutcome = {
  /** The press really landed while the note was still unacknowledged — otherwise nothing is judged. */
  pressedWhileUnacked: boolean,
  /** The note started playing while it was still unacknowledged: the user's own file, no round trip. */
  playedBeforeAck: boolean,
  /** Milliseconds from the press to the first moving frame, or -1 if it never moved. */
  playedAfterMs: number,
  /** Milliseconds from the press to the server ack landing on the bubble, or -1 if it never came. */
  ackedAfterMs: number,
  report: string,
  hitSummary: string
};

/** How long a press on the user's own just-recorded note is given before it counts as ignored. */
const unackedPlaybackWindowMs = 10_000;


/**
 * The gesture the board reported dead: the user records a round note, the circle appears with its
 * preview already looping and nothing asking them to wait, and they press it — before the server
 * has acknowledged the send.
 *
 * The press is the same real trusted press as tapRoundNoteLikeAUser. What is watched is different:
 * a page-side frame loop, installed BEFORE the press, timestamps two things on one clock — the
 * first moving frame of the note, and the moment the bubble stops being unacknowledged. Their
 * ORDER is the invariant: the bytes are already on this machine (the circle is playing them), so
 * the press must be answered from them, not after a round trip. A note that only starts once the
 * server answers is a note that stays dead forever when the answer is lost, which is exactly the
 * state the live capture of this defect was taken in.
 */
export async function pressUnackedRoundNoteLikeAUser(session: PersonaSession, side: string): Promise<UnackedPressOutcome> {
  const page = session.page;

  // One round trip does everything that must happen before the press: it waits (on animation
  // frames) for a round bubble that still carries the deferred-onLoad marker, arms a frame loop
  // that timestamps the first moving frame and the arrival of the server ack on ONE clock, and
  // hands back the rectangle to press. Anything heavier here — a locator round trip, the full
  // hit-stack probe — would spend the very window the gesture has to land in.
  const armed = await page.waitForFunction(() => {
    const w = window as any;
    const rounds = Array.from(document.querySelectorAll<HTMLElement>('.media-round[data-mid]'));
    const bubble = rounds.length ? rounds[rounds.length - 1] : undefined;
    if(!bubble || bubble.dataset.isOutgoing !== '1') {
      return null;
    }

    const rect = bubble.getBoundingClientRect();
    if(rect.width < 40 || rect.height < 40) {
      return null;
    }

    const playing: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
    const watch = {armedAt: Date.now(), playedAt: 0, ackedAt: 0};
    w.__impulseUnackedRoundWatch = watch;
    const tick = () => {
      if(!watch.ackedAt && bubble.dataset.isOutgoing !== '1') {
        watch.ackedAt = Date.now();
      }

      const current: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
      if(!watch.playedAt && current && !current.paused && current.currentTime > 0) {
        watch.playedAt = Date.now();
      }

      if(!watch.playedAt || !watch.ackedAt) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);

    return {
      mid: bubble.dataset.mid ?? '',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      silent: !playing || playing.paused
    };
  }, undefined, {timeout: 60_000, polling: 'raf'}).then((handle) => handle.jsonValue());

  if(!armed.silent) {
    return {
      pressedWhileUnacked: false,
      playedBeforeAck: false,
      playedAfterMs: -1,
      ackedAfterMs: -1,
      hitSummary: `[${side}] something was already playing when the circle appeared`,
      report: `[${side}] this attempt cannot judge anything: a note was already playing before the ` +
        'press, so playback afterwards could not be attributed to the gesture'
    };
  }

  const pressedAt = Date.now();
  await page.mouse.move(armed.x, armed.y);
  await page.mouse.click(armed.x, armed.y);

  await page.waitForFunction(() => {
    const watch = (window as any).__impulseUnackedRoundWatch;
    return !!watch && !!watch.playedAt;
  }, undefined, {timeout: unackedPlaybackWindowMs}).catch(() => {
    // Not fatal: a note that never moved at all is what the watch below reports.
  });

  const watch = await page.evaluate(() => {
    const w = (window as any).__impulseUnackedRoundWatch ?? {armedAt: 0, playedAt: 0, ackedAt: 0};
    return {armedAt: w.armedAt as number, playedAt: w.playedAt as number, ackedAt: w.ackedAt as number};
  });

  const after = await captureRoundClickProbe(page, armed.x, armed.y, null);
  const hitSummary = `[${side}] state of the pressed pixel just after the press (the press itself is ` +
    `taken before any of this is read, so the gesture lands inside the window it is judged in):\n${describeRoundClickProbe(after)}`;

  // Did the press actually reach the circle it aimed at? A bubble that moved under the cursor
  // between measuring and pressing would make everything below meaningless, so it is checked
  // rather than assumed.
  const pressesOnTheCircle = after.observedEvents.filter((event) => {
    return event.isTrusted && event.at >= pressedAt - 1_000 && event.targetRoundMid !== '';
  });

  const playedAfterMs = watch.playedAt ? watch.playedAt - pressedAt : -1;
  const ackedAfterMs = watch.ackedAt ? watch.ackedAt - pressedAt : -1;
  const playedBeforeAck = !!watch.playedAt && (!watch.ackedAt || watch.playedAt < watch.ackedAt);
  const pressedWhileUnacked = pressesOnTheCircle.length > 0 && (!watch.ackedAt || watch.ackedAt >= pressedAt);

  if(!pressedWhileUnacked) {
    return {
      pressedWhileUnacked: false,
      playedBeforeAck: false,
      playedAfterMs,
      ackedAfterMs,
      hitSummary,
      report: `[${side}] this attempt cannot judge anything: ` +
        (pressesOnTheCircle.length === 0 ?
          'the press did not land on the circle at all (the bubble moved between measuring it and pressing it)' :
          `the server had already acknowledged the note ${-ackedAfterMs}ms before the press landed`) +
        `.\n${describeRoundClickProbe(after)}`
    };
  }

  if(playedBeforeAck) {
    return {pressedWhileUnacked: true, playedBeforeAck: true, playedAfterMs, ackedAfterMs, hitSummary, report: ''};
  }

  const diagnostics = await captureMediaDiagnostics(page);
  const relevant = diagnostics.elements.filter((state: MediaElementState) => {
    return state.inRoundBubble || state.isPlaybackControllerMedia;
  });

  return {
    pressedWhileUnacked: true,
    playedBeforeAck: false,
    playedAfterMs,
    ackedAfterMs,
    hitSummary,
    report: [
      `[${side}] the user pressed the centre of the circle they had just recorded — preview ` +
      `looping: ${after.previewIsMoving}, spinner over it: ${after.spinnerOverCircle} — while the ` +
      'send had not been acknowledged yet, and ' +
      (watch.playedAt ?
        `the circle stayed silent until the server answered ${ackedAfterMs}ms later; the first moving ` +
        `frame came ${playedAfterMs}ms after the press, on the far side of that answer.` :
        `it never moved at all within ${unackedPlaybackWindowMs}ms of the press (the server ` +
        (ackedAfterMs >= 0 ? `answered ${ackedAfterMs}ms after the press` : 'never answered at all') + ').'),
      'The recording is already on this machine — the circle is playing it as a preview — so the ' +
      'press must be answered from it. Waiting for the server means that when the answer is slow ' +
      'or lost the circle is dead for as long as the chat stays open: the board\'s report, where ' +
      'it only starts working after the notes around it are tapped and the user comes back.',
      '--- page state after the press ---',
      describeRoundClickProbe(after),
      '--- media lanes ---',
      describePlaybackFailure(diagnostics, relevant),
      '--- console around the press ---',
      session.formatConsoleTrailSince(pressedAt - 2_000)
    ].join('\n')
  };
}
