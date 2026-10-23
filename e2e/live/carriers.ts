import type {Page, Route} from '@playwright/test';

/*
 * The Centrifugo carriers of the client as the live lane sees them: whether an endpoint answers, and which requests of a
 * page name a gateway gRPC-web method.
 */

// The gateway's gRPC-web paths: /v1.{namespace}.{Service}/{Method}.
export const GRPC_WEB_ROUTE: RegExp = /\/v1\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/;

const PROBE_TIMEOUT_MS: number = 5_000;

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

/** Records the path of every request of the page that names a gateway gRPC-web method, and lets the request through. */
export async function recordGatewayCalls(page: Page, into: string[]): Promise<void> {
  await page.route(GRPC_WEB_ROUTE, (route: Route): Promise<void> => {
    into.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
}
