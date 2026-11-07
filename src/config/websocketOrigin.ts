/**
 * The websocket origin of an HTTP origin. It reads no build variable, so the live Playwright lane, which loads its
 * helpers outside Vite, can import it without loading a module that touches import.meta.
 */
export function backendWsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}
