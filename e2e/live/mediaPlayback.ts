import {Page} from '@playwright/test';

/*
 * Playback diagnostics for the B2 lane (the board's "video will not play at all" report).
 *
 * A playback red that only says "never started playing" is useless for localization: the
 * pipeline between a click and moving pixels has four distinct lanes that die differently —
 * the element never gets a src at all, the src it got is refused (a service-worker stream URL
 * answered by nobody, or a blob that was revoked), the bytes arrive but do not decode, or no
 * code path ever calls play() on the element. This module instruments EVERY media element on
 * the page from before app boot (init script, reload-proof) and, at failure time, captures
 * enough state to name the dead lane in the assertion message:
 *
 *   - every HTMLMediaElement.play() invocation, with the src and readyState at call time;
 *   - every media 'error' event, with the MediaError code/message and network/ready state;
 *   - the live state of every media element (DOM ones plus any detached element that was
 *     ever play()ed — appMediaPlaybackController's global media lives outside the DOM);
 *   - whether a service worker is controlling the page (the /stream/ URL lane depends on it);
 *   - a fetch() probe of every element's src, run in page context at capture time: for the
 *     board's exact signature (code 4, blob src, NETWORK_NO_SOURCE) the probe alone separates
 *     a REVOKED blob URL (fetch rejects) from content the browser refuses to decode (fetch
 *     resolves, and the blob's size and type say what the element was actually given);
 *   - the media viewer's own 'video failed to play' failure records (mediaViewer/base.ts logs
 *     them through console.error), captured structurally — the console text stream renders
 *     the record object as an opaque handle, so the init script keeps the JSON.
 */
export type MediaPlayCall = {
  elementId: number,
  tag: string,
  className: string,
  src: string,
  readyState: number,
  networkState: number,
  at: number
};

export type MediaErrorEvent = {
  elementId: number,
  tag: string,
  src: string,
  errorCode: number,
  errorMessage: string,
  readyState: number,
  networkState: number,
  at: number
};

export type MediaElementState = {
  elementId: number,
  tag: string,
  className: string,
  inDom: boolean,
  inMediaViewer: boolean,
  inRoundBubble: boolean,
  isPlaybackControllerMedia: boolean,
  srcAttribute: string,
  currentSrc: string,
  paused: boolean,
  ended: boolean,
  currentTime: number,
  readyState: number,
  networkState: number,
  errorCode: number,
  errorMessage: string,
  playCallCount: number
};

export type MediaSourceProbe = {
  src: string,
  fetchResolved: boolean,
  status: number,
  blobSize: number,
  blobType: string,
  fetchError: string
};

export type MediaDiagnostics = {
  playCalls: MediaPlayCall[],
  mediaErrors: MediaErrorEvent[],
  elements: MediaElementState[],
  sourceProbes: MediaSourceProbe[],
  viewerFailureRecords: string[],
  serviceWorkerControlling: boolean,
  serviceWorkerScriptUrl: string,
  serviceWorkerState: string,
  apiManagerProxySwOnline: boolean | undefined
};


/**
 * Must be installed BEFORE any navigation (Page.addInitScript), so the play() wrap is in
 * place before the app's own scripts run — and stays in place across reloads.
 */
export async function installMediaDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const diag = {
      playCalls: [] as any[],
      mediaErrors: [] as any[],
      trackedElements: [] as HTMLMediaElement[],
      viewerFailureRecords: [] as string[],
      nextElementId: 1
    };
    (window as any).__impulseMediaDiag = diag;

    // The media viewer logs its failure record ('video failed to play', {code, sourceKind,
    // networkState, readyState}) through console.error. Playwright's console text stream
    // renders the record object as an opaque handle, so keep the JSON here.
    const originalConsoleError = console.error;
    console.error = function(...args: any[]) {
      try {
        if(args.some((arg) => typeof arg === 'string' && arg.includes('video failed to play'))) {
          diag.viewerFailureRecords.push(args.map((arg) => {
            if(typeof arg === 'object' && arg !== null) {
              try {
                return JSON.stringify(arg);
              } catch(ignored) {
                return String(arg);
              }
            }
            return String(arg);
          }).join(' '));
        }
      } catch(ignored) {
        // diagnostics must never break the page's own logging
      }
      return originalConsoleError.apply(this, args);
    };

    const idOf = (element: any): number => {
      if(!element.__impulseMediaId) {
        element.__impulseMediaId = diag.nextElementId++;
        diag.trackedElements.push(element);
      }
      return element.__impulseMediaId;
    };
    (window as any).__impulseMediaIdOf = idOf;

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(this: HTMLMediaElement) {
      diag.playCalls.push({
        elementId: idOf(this),
        tag: this.tagName.toLowerCase(),
        className: String(this.className),
        src: this.currentSrc || this.getAttribute('src') || '',
        readyState: this.readyState,
        networkState: this.networkState,
        at: Date.now()
      });
      return originalPlay.apply(this, arguments as any);
    };

    // Media 'error' events do not bubble, but they DO propagate in the capture phase.
    window.addEventListener('error', (event) => {
      const target = event.target;
      if(!(target instanceof HTMLMediaElement)) {
        return;
      }

      diag.mediaErrors.push({
        elementId: idOf(target),
        tag: target.tagName.toLowerCase(),
        src: target.currentSrc || target.getAttribute('src') || '',
        errorCode: target.error?.code ?? 0,
        errorMessage: target.error?.message ?? '',
        readyState: target.readyState,
        networkState: target.networkState,
        at: Date.now()
      });
    }, true);
  });
}


export async function captureMediaDiagnostics(page: Page): Promise<MediaDiagnostics> {
  return page.evaluate(async() => {
    const w = window as any;
    const diag = w.__impulseMediaDiag ?? {playCalls: [], mediaErrors: [], trackedElements: []};
    const idOf = w.__impulseMediaIdOf ?? (() => 0);

    const seen = new Set<HTMLMediaElement>();
    const all: HTMLMediaElement[] = [];
    const collect = (element: HTMLMediaElement | undefined | null) => {
      if(element && !seen.has(element)) {
        seen.add(element);
        all.push(element);
      }
    };

    for(const element of Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))) {
      collect(element);
    }
    for(const element of diag.trackedElements as HTMLMediaElement[]) {
      collect(element);
    }
    const controllerMedia: HTMLMediaElement | undefined = w.appMediaPlaybackController?.playingMedia;
    collect(controllerMedia);

    const playCountByElement = new Map<number, number>();
    for(const call of diag.playCalls) {
      playCountByElement.set(call.elementId, (playCountByElement.get(call.elementId) ?? 0) + 1);
    }

    const elements = all.map((element) => {
      const elementId = idOf(element);
      return {
        elementId,
        tag: element.tagName.toLowerCase(),
        className: String(element.className),
        inDom: element.isConnected,
        inMediaViewer: element.isConnected && !!element.closest('.media-viewer-whole'),
        inRoundBubble: element.isConnected && !!element.closest('.media-round'),
        isPlaybackControllerMedia: element === controllerMedia,
        srcAttribute: element.getAttribute('src') || '',
        currentSrc: element.currentSrc || '',
        paused: element.paused,
        ended: element.ended,
        currentTime: element.currentTime,
        readyState: element.readyState,
        networkState: element.networkState,
        errorCode: element.error?.code ?? 0,
        errorMessage: element.error?.message ?? '',
        playCallCount: playCountByElement.get(elementId) ?? 0
      };
    });

    // Probe every distinct src the elements carry, from the page itself: a blob: URL whose
    // fetch rejects is REVOKED; one whose fetch resolves is alive, and its size/type say
    // whether the element was given real video bytes the browser then refused to decode.
    const distinctSrcs = [...new Set(
      all
        .map((element) => element.currentSrc || element.getAttribute('src') || '')
        .filter((src) => !!src)
    )];
    const sourceProbes = [];
    for(const src of distinctSrcs) {
      const probe = {src, fetchResolved: false, status: 0, blobSize: 0, blobType: '', fetchError: ''};
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('media source probe timed out after 5s'), 5_000);
        const response = await fetch(src, {signal: controller.signal});
        probe.fetchResolved = true;
        probe.status = response.status;
        const blob = await response.blob();
        clearTimeout(timer);
        probe.blobSize = blob.size;
        probe.blobType = blob.type;
      } catch(error) {
        probe.fetchError = error instanceof Error ? error.message : String(error);
      }
      sourceProbes.push(probe);
    }

    const registration = await navigator.serviceWorker?.getRegistration?.().catch((): undefined => undefined);
    const worker = navigator.serviceWorker?.controller ?? registration?.active ?? undefined;

    return {
      playCalls: diag.playCalls,
      mediaErrors: diag.mediaErrors,
      elements,
      sourceProbes,
      viewerFailureRecords: (diag.viewerFailureRecords ?? []) as string[],
      serviceWorkerControlling: !!navigator.serviceWorker?.controller,
      serviceWorkerScriptUrl: worker?.scriptURL ?? '',
      serviceWorkerState: worker?.state ?? 'none',
      apiManagerProxySwOnline: ((): boolean | undefined => {
        try {
          return w.apiManagerProxy?.isServiceWorkerOnline?.();
        } catch(ignored) {
          return undefined;
        }
      })()
    };
  });
}


function describeSrcLane(src: string): string {
  if(!src) {
    return 'NO SOURCE';
  }
  if(src.startsWith('blob:')) {
    return `blob URL (${src})`;
  }
  if(src.includes('/stream/')) {
    return `service-worker stream URL (${src})`;
  }
  return src;
}


function describeElement(state: MediaElementState): string {
  const error = state.errorCode > 0 ?
    `MediaError code=${state.errorCode} message="${state.errorMessage}"` :
    'no MediaError';
  return `#${state.elementId} <${state.tag} class="${state.className}"> ` +
    `${state.inDom ? 'in DOM' : 'DETACHED'}` +
    `${state.inMediaViewer ? ', in media viewer' : ''}` +
    `${state.inRoundBubble ? ', in round bubble' : ''}` +
    `${state.isPlaybackControllerMedia ? ', playback-controller media' : ''}: ` +
    `src=${describeSrcLane(state.currentSrc || state.srcAttribute)}, ` +
    `paused=${state.paused}, currentTime=${state.currentTime}, ` +
    `readyState=${state.readyState}, networkState=${state.networkState}, ` +
    `${error}, play() calls=${state.playCallCount}`;
}


/**
 * Names the lane that broke, from the captured state of the elements the scenario cares
 * about. `relevant` is the subset of captured elements the failed assertion was watching
 * (empty means "nothing matching even exists"); the classification looks at those first and
 * falls back to the global picture.
 */
export function describePlaybackFailure(diagnostics: MediaDiagnostics, relevant: MediaElementState[]): string {
  const lines: string[] = [];

  const swLine = `service worker: controlling=${diagnostics.serviceWorkerControlling}, ` +
    `state=${diagnostics.serviceWorkerState}, script=${diagnostics.serviceWorkerScriptUrl || 'none'}, ` +
    `apiManagerProxy.isServiceWorkerOnline=${String(diagnostics.apiManagerProxySwOnline)}`;

  const probeVerdict = (src: string): string => {
    const probe = diagnostics.sourceProbes.find((candidate) => candidate.src === src);
    if(!probe) {
      return '';
    }

    if(probe.fetchResolved) {
      return ` — yet fetch(src) from the page still resolves (status=${probe.status}, ` +
        `${probe.blobSize} bytes, type="${probe.blobType}"): the URL is alive and readable, ` +
        'so the refusal is about the CONTENT (a container/codec this browser will not play), ' +
        'not a revoked blob';
    }

    return ` — and fetch(src) from the page rejects ("${probe.fetchError}"): the URL itself ` +
      'is dead — for a blob: src that means a REVOKED object URL was handed to the element';
  };

  const classify = (state: MediaElementState): string => {
    const src = state.currentSrc || state.srcAttribute;
    if(state.playCallCount === 0 && state.paused) {
      return 'the element never received a play() call';
    }
    if(!src) {
      return 'no source: the element never received a src';
    }
    if(state.errorCode === 4 || (state.errorCode === 0 && state.networkState === 3)) {
      return `the src was refused (${state.errorCode === 4 ? 'MEDIA_ERR_SRC_NOT_SUPPORTED' : 'NETWORK_NO_SOURCE'}) — ${describeSrcLane(src)}${probeVerdict(src)}`;
    }
    if(state.errorCode === 2) {
      return `network error while fetching ${describeSrcLane(src)}`;
    }
    if(state.errorCode === 3) {
      return `decode error on ${describeSrcLane(src)}`;
    }
    if(state.errorCode === 1) {
      return `fetch aborted for ${describeSrcLane(src)}`;
    }
    if(state.readyState <= 2 && state.networkState === 2) {
      return `the download never produced playable data — stuck LOADING ${describeSrcLane(src)} at readyState=${state.readyState}`;
    }
    if(state.paused && state.readyState >= 3) {
      return `playable data arrived but the element stayed paused on ${describeSrcLane(src)}`;
    }
    return `unclassified: playing=${!state.paused}, currentTime=${state.currentTime}, readyState=${state.readyState} on ${describeSrcLane(src)}`;
  };

  if(relevant.length === 0) {
    lines.push('LANE: no media element matching the watched scope exists at all — the click never produced a video element');
  } else {
    for(const state of relevant) {
      lines.push(`LANE for element #${state.elementId}: ${classify(state)}`);
    }
  }

  lines.push(swLine);
  lines.push('media elements:');
  for(const state of diagnostics.elements) {
    lines.push(`  ${describeElement(state)}`);
  }
  lines.push('source probes (fetch(src) from the page):');
  if(diagnostics.sourceProbes.length === 0) {
    lines.push('  (no element carried a src to probe)');
  }
  for(const probe of diagnostics.sourceProbes) {
    lines.push(probe.fetchResolved ?
      `  ${probe.src} -> RESOLVED status=${probe.status}, ${probe.blobSize} bytes, type="${probe.blobType}"` :
      `  ${probe.src} -> REJECTED ("${probe.fetchError}")`
    );
  }
  lines.push('media viewer failure records (its own \'video failed to play\' log):');
  if(diagnostics.viewerFailureRecords.length === 0) {
    lines.push('  (the viewer logged no failure record)');
  }
  for(const record of diagnostics.viewerFailureRecords) {
    lines.push(`  ${record}`);
  }
  lines.push(`play() calls: ${JSON.stringify(diagnostics.playCalls)}`);
  lines.push(`media error events: ${JSON.stringify(diagnostics.mediaErrors)}`);

  return lines.join('\n');
}
