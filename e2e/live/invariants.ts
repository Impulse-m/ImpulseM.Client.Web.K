import {expect, Page} from '@playwright/test';


/*
 * The two universal invariants of the B2 lane (issue #92). Both are applied to EVERY scenario
 * by the persona-pair fixture (pair.ts) — a scenario author cannot forget them.
 *
 *   1. CONSOLE CLEAN — no error-level console entries, no uncaught page errors, no unhandled
 *      promise rejections anywhere in the scenario, on either persona's page. Issue #91's
 *      finalize crash announced itself as exactly one console error line while every other
 *      test lane stayed green; this invariant makes that line a named failure, verbatim.
 *      Warn-level noise (NOTIFICATIONS/lifecycle logs) is deliberately NOT counted.
 *
 *   2. RENDER COMPLETENESS — after a reload, every message id the SERVER returns for the open
 *      dialog must have a bubble in the DOM. Issue #93's vanish (server truth intact, bubble
 *      gone) is precisely the class this catches; the assert names every missing mid.
 *
 * Server-truth seam (documented honestly): messages.getHistory is invoked RAW through the
 * page's OWN apiManager proxy (window.rootScope.managers.apiManager.invokeApi) — the same
 * worker, session and gRPC-web transport the app itself uses, but bypassing
 * appMessagesManager's message cache, so the returned ids are the server's answer, not an
 * echo of whatever local state the bug under test may have corrupted. Server ids are compared
 * after mapping DOM mids through the app's own getServerMessageId
 * (src/lib/appManagers/utils/messageId/getServerMessageId.ts), dynamically imported into the
 * page off the same Vite module graph.
 */
export class ConsoleCleanInvariant {
  public failures: string[] = [];

  private readonly label: string;


  private constructor(label: string) {
    this.label = label;
  }


  public static async attach(page: Page, label: string): Promise<ConsoleCleanInvariant> {
    const invariant = new ConsoleCleanInvariant(label);

    page.on('console', (message) => {
      if(message.type() !== 'error') {
        return;
      }

      const location = message.location();
      const where = location.url ? ` (${location.url}:${location.lineNumber})` : '';
      invariant.failures.push(`[console.error]${where} ${message.text()}`);
    });

    page.on('pageerror', (error) => {
      invariant.failures.push(`[pageerror] ${error.message}\n${error.stack ?? ''}`);
    });

    // Belt over the pageerror braces: an explicit in-page unhandledrejection listener, reported
    // through a binding that survives navigations (a reload mid-scenario must not open a
    // blind spot). Chromium usually surfaces these as pageerror too; duplicates are collapsed
    // in assertClean by message text.
    await page.exposeBinding(`impulseReportUnhandled${ConsoleCleanInvariant.bindingSuffix(label)}`, (source, rendered: string) => {
      invariant.failures.push(`[unhandledrejection] ${rendered}`);
    });
    await page.addInitScript((bindingName: string) => {
      window.addEventListener('unhandledrejection', (event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        const rendered = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
        (window as any)[bindingName]?.(rendered);
      });
    }, `impulseReportUnhandled${ConsoleCleanInvariant.bindingSuffix(label)}`);

    return invariant;
  }


  public assertClean(context: string): void {
    const unique = [...new Set(this.failures)];
    expect(
      unique,
      `CONSOLE CLEAN violated on the ${this.label} page during "${context}" — every entry below ` +
      'is an error the real user\'s console showed while every RPC-level lane stayed green ' +
      '(the #91/#93 class: a main-thread throw that silently loses a send, a render, or ' +
      'persisted state). Each entry is verbatim'
    ).toEqual([]);
  }


  private static bindingSuffix(label: string): string {
    return label.replace(/[^a-zA-Z0-9]/g, '');
  }
}


type RenderCompletenessSnapshot = {
  peerId: string,
  serverIds: string[],
  renderedServerIds: string[],
  missingServerIds: string[]
};


async function renderCompletenessSnapshot(page: Page): Promise<RenderCompletenessSnapshot> {
  return page.evaluate(async() => {
    // Kept out of the Playwright transpiler's reach so the dynamic import stays a native
    // browser import against the page's own Vite module graph.
    const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

    const w = window as any;
    const chat = w.appImManager?.chat;
    if(!chat?.peerId) {
      throw new Error('render-completeness snapshot requested with no open dialog — the scenario must open the peer first');
    }

    const peerId = chat.peerId;
    const inputPeer = await w.rootScope.managers.appPeersManager.getInputPeerById(peerId);
    // RAW server call through the page's own connection — see the seam note in the header.
    const history = await w.rootScope.managers.apiManager.invokeApi('messages.getHistory', {
      peer: inputPeer,
      offset_id: 0,
      offset_date: 0,
      add_offset: 0,
      limit: 100,
      max_id: 0,
      min_id: 0,
      hash: 0
    });

    const serverIds: string[] = (history.messages ?? [])
      .filter((message: any) => message._ !== 'messageEmpty')
      .map((message: any) => String(message.id));

    const {default: getServerMessageId} = await dynamicImport('/src/lib/appManagers/utils/messageId/getServerMessageId.ts');

    const renderedServerIds = new Set<string>();
    const container: HTMLElement = chat.bubbles?.container;
    if(container) {
      // Every element carrying a mid inside the active chat counts as that message's render:
      // the bubble itself, and .grouped-item entries of an album bubble (each album member has
      // its own mid and must be individually present — a half-rendered album is a loss).
      for(const element of Array.from(container.querySelectorAll<HTMLElement>('[data-mid]'))) {
        const mid = +element.dataset.mid;
        if(!Number.isFinite(mid)) {
          continue;
        }

        const serverId = getServerMessageId(mid);
        if(serverId > 0) {
          renderedServerIds.add(String(serverId));
        }
      }
    }

    return {
      peerId: String(peerId),
      serverIds,
      renderedServerIds: [...renderedServerIds],
      missingServerIds: serverIds.filter((id) => !renderedServerIds.has(id))
    };
  });
}


export async function assertRenderCompleteness(page: Page, side: string, context: string): Promise<void> {
  let last: RenderCompletenessSnapshot | undefined;

  await expect
    .poll(async() => {
      last = await renderCompletenessSnapshot(page);
      return last.missingServerIds;
    }, {
      timeout: 45_000,
      message: `RENDER COMPLETENESS violated on the ${side} side during "${context}": the server's ` +
        'messages.getHistory (queried through this very page\'s own connection) returned message ids ' +
        'that never got a bubble in the DOM after the reload — the user-visible shape of issue #93 ' +
        '(the message exists on the server, the chat renders without it). The ids listed in the ' +
        'received array are the missing server message ids'
    })
    .toEqual([]);

  // A dialog the scenario just filled cannot legitimately be empty — an empty server answer
  // here means the snapshot measured the wrong peer or the wrong account, and a green run on
  // top of that would be a fake pass.
  expect(
    last.serverIds.length,
    `render-completeness sanity on the ${side} side during "${context}": messages.getHistory ` +
    'returned ZERO messages for the open dialog although the scenario sent into it — the ' +
    'invariant would be vacuously green, which the lane forbids'
  ).toBeGreaterThan(0);
}
