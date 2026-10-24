/**
 * Single source of truth for the ImpulseM backend (gateway) origin.
 *
 * Set `VITE_IMPULSE_BACKEND_URL` in `.env`; Vite bakes it into the bundle at
 * build time. The gateway is reached DIRECTLY on its own subdomain — it is NOT
 * tunnelled through the frontend dev server. The cross-origin call
 * (frontend -> gateway) is allowed by the gateway's CORS policy and by
 * Centrifugo's `allowed_origins`.
 *
 * Two consumers share this origin:
 *   - Centrifugo fleets (RPC and media) and the update socket -> `{wsOrigin}` + CENTRIFUGO_CONNECTION_PATH (fleet/fleetPath.ts)
 *   - Loki log push                                           -> `{origin}/loki/api/v1/push`
 */

export function backendHttpOrigin(): string {
  // Read at call time: e2e/live imports backendWsOrigin, and import.meta.env is undefined outside Vite.
  return import.meta.env.VITE_IMPULSE_BACKEND_URL || 'http://localhost:9045';
}

export function backendWsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}

export function backendUpdateWsOrigin(): string {
  return import.meta.env.VITE_IMPULSE_UPDATE_WS || backendWsOrigin(backendHttpOrigin());
}

export function backendPoolWsOrigin(): string | undefined {
  return import.meta.env.VITE_IMPULSE_POOL_WS || undefined;
}
