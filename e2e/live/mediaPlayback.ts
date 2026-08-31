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
 *   - whether a service worker is controlling the page (the /stream/ URL lane depends on it).
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

export type MediaDiagnostics = {
  playCalls: MediaPlayCall[],
  mediaErrors: MediaErrorEvent[],
  elements: MediaElementState[],
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
      nextElementId: 1
    };
    (window as any).__impulseMediaDiag = diag;

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

    const registration = await navigator.serviceWorker?.getRegistration?.().catch((): undefined => undefined);
    const worker = navigator.serviceWorker?.controller ?? registration?.active ?? undefined;

    return {
      playCalls: diag.playCalls,
      mediaErrors: diag.mediaErrors,
      elements,
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

  const classify = (state: MediaElementState): string => {
    const src = state.currentSrc || state.srcAttribute;
    if(state.playCallCount === 0 && state.paused) {
      return 'the element never received a play() call';
    }
    if(!src) {
      return 'no source: the element never received a src';
    }
    if(state.errorCode === 4 || (state.errorCode === 0 && state.networkState === 3)) {
      return `the src was refused (${state.errorCode === 4 ? 'MEDIA_ERR_SRC_NOT_SUPPORTED' : 'NETWORK_NO_SOURCE'}) — ${describeSrcLane(src)}`;
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
  lines.push(`play() calls: ${JSON.stringify(diagnostics.playCalls)}`);
  lines.push(`media error events: ${JSON.stringify(diagnostics.mediaErrors)}`);

  return lines.join('\n');
}
