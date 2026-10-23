import type {Browser, BrowserContext, Page, Route} from '@playwright/test';

/*
 * The Centrifugo carriers of the client as the live lane sees them: whether an endpoint answers, which requests of a
 * context name a gateway gRPC-web method, and the counters of the fleets of a page.
 */

// The gateway's gRPC-web paths: /v1.{namespace}.{Service}/{Method}.
export const GRPC_WEB_ROUTE: RegExp = /\/v1\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/;

const WEBSOCKET_PATH: string = '/connection/websocket?cf_protocol=protobuf&cf_ws_frame_ping_pong=true';

const PROBE_TIMEOUT_MS: number = 5_000;
// Playwright's route API does not see the requests of a SharedWorker, and the client's API worker is one.
const WORKER_TARGET_TYPES: ReadonlySet<string> = new Set<string>(['shared_worker', 'worker', 'service_worker']);

export type GatewayRecorder = {
  /** The paths of the gateway gRPC-web requests seen from the pages and the workers of the recorded contexts. */
  calls: string[],
  /** The URLs of the worker targets the recorder watches: an empty list means the workers were not seen at all. */
  workers: string[],
  /** The worker targets the recorder could not attach to, with the reason: their requests are not recorded. */
  attachFailures: string[]
};

/** The update socket of a gateway origin. */
export function socketUrlOf(gatewayOrigin: string): string {
  return `${gatewayOrigin.replace(/^http/, 'ws')}${WEBSOCKET_PATH}`;
}

/** The media fleet endpoint a config publishes, on the scheme of the gateway origin. */
export function mediaUrlOf(gatewayOrigin: string, host: string, port: number): string {
  const origin = new URL(gatewayOrigin);
  return `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}${WEBSOCKET_PATH}`;
}

/** Whether a carrier answers its WebSocket within the probe timeout, from the test runner. */
export async function fleetAnswers(url: string): Promise<string | undefined> {
  const WebSocketClass = (globalThis as any).WebSocket;
  return new Promise<string | undefined>((resolve: (reason: string | undefined) => void): void => {
    const socket = new WebSocketClass(url);
    const timer = setTimeout((): void => {
      socket.close();
      resolve(`no answer within ${PROBE_TIMEOUT_MS} ms`);
    }, PROBE_TIMEOUT_MS);
    socket.onopen = (): void => {
      clearTimeout(timer);
      socket.close();
      resolve(undefined);
    };
    socket.onerror = (): void => {
      clearTimeout(timer);
      resolve('the connection was refused');
    };
  });
}

/** The fleet counters of the page's client: the calls its media fleet and its update socket answered. */
export async function fleetCountersOf(page: Page): Promise<{media: number, socket: number}> {
  return page.evaluate(() => (window as any).rootScope.managers.apiManager.getFleetCounters());
}

/**
 * Records the gateway gRPC-web requests of the page's context, from before anything is navigated: the pages' own through
 * the route API, the workers' through the browser's target discovery, which attaches to each worker of the context and
 * turns on its network events. A worker attached after it has issued its first request is missed.
 */
export async function recordGatewayCalls(page: Page, into: GatewayRecorder): Promise<void> {
  const context: BrowserContext = page.context();
  const browser: Browser | null = context.browser();
  if(browser === null) {
    throw new Error('the gateway recorder needs a context of a browser: its workers are watched through the browser');
  }

  await context.route(GRPC_WEB_ROUTE, (route: Route): Promise<void> => {
    into.calls.push(new URL(route.request().url()).pathname);
    return route.continue();
  });

  const pageSession = await context.newCDPSession(page);
  const pageInfo = await pageSession.send('Target.getTargetInfo');
  const contextId: string | undefined = pageInfo.targetInfo.browserContextId;
  if(contextId === undefined) {
    throw new Error('the page of the recorded context reports no browser context to watch');
  }

  const cdp = await browser.newBrowserCDPSession();
  let nextCommandId: number = 1;
  const watchWorker = async(targetId: string): Promise<void> => {
    const attached: {sessionId: string} = await cdp.send('Target.attachToTarget', {targetId, flatten: false});
    await cdp.send('Target.sendMessageToTarget', {
      sessionId: attached.sessionId,
      message: JSON.stringify({id: nextCommandId++, method: 'Network.enable', params: {}})
    });
  };
  cdp.on('Target.receivedMessageFromTarget', (event: {message: string}): void => {
    const frame: {method?: string, params?: {request?: {url: string}}} = JSON.parse(event.message);
    const url: string | undefined = frame.params?.request?.url;
    if(frame.method === 'Network.requestWillBeSent' && url !== undefined && GRPC_WEB_ROUTE.test(new URL(url).pathname)) {
      into.calls.push(new URL(url).pathname);
    }
  });
  cdp.on('Target.targetCreated', (event: {targetInfo: {targetId: string, type: string, url: string, browserContextId?: string}}): void => {
    const target = event.targetInfo;
    if(target.browserContextId !== contextId || !WORKER_TARGET_TYPES.has(target.type)) {
      return;
    }

    into.workers.push(target.url);
    watchWorker(target.targetId).catch((error: unknown): void => {
      into.attachFailures.push(`${target.url}: ${String(error)}`);
    });
  });
  await cdp.send('Target.setDiscoverTargets', {discover: true});
}
