/**
 * Single source of truth for the ImpulseM backend (gateway) origin.
 *
 * Set `VITE_IMPULSE_BACKEND_URL` in `.env`; Vite bakes it into the bundle at
 * build time. The gateway is reached DIRECTLY on its own subdomain — it is NOT
 * tunnelled through the frontend dev server. The cross-origin call
 * (frontend -> gateway) is allowed by the gateway's CORS policy and by
 * Centrifugo's `allowed_origins`.
 *
 * Three consumers share this origin:
 *   - gRPC-web transport   -> `{origin}` (unary RPC)
 *   - Centrifugo WebSocket -> `{wsOrigin}/connection/websocket`
 *   - Loki log push        -> `{origin}/loki/api/v1/push`
 */

const BACKEND_URL = import.meta.env.VITE_IMPULSE_BACKEND_URL || 'http://localhost:9045';

export function backendHttpOrigin(): string {
  return BACKEND_URL;
}

export function backendWsOrigin(): string {
  return BACKEND_URL.replace(/^http/, 'ws');
}
