/*
 * Gate for the B2 lane: the REAL web client in a REAL browser (Playwright/chromium) against
 * the LIVE dev backend.
 *
 * Skip discipline is the same as src/tests/liveharness/liveGate.ts (which mirrors the backend's
 * tests/ImpulseM.Smokes LiveGatewaySkip): when the live-gateway env is absent, every scenario
 * SKIPS with an explanatory reason — it never fake-passes, and the backend is NEVER mocked.
 * The playwright config also omits the webServer entirely in that case, so a gated run
 * resolves in milliseconds instead of booting a Vite server.
 *
 * Environment (identical names to the C# harness and the B1 lane):
 *
 *   IMPULSE_LIVE_GATEWAY     presence ENABLES the lane (native-gRPC endpoint of the dev
 *                            stack, default there http://localhost:5200 — used only as the
 *                            gate marker here).
 *   IMPULSE_LIVE_WS_GATEWAY  the HTTP/1.1-capable gateway endpoint (default
 *                            http://localhost:5100). The browser speaks Centrifugo over WebSocket,
 *                            which requires HTTP/1.1, so THIS is the origin baked into the client bundle via
 *                            VITE_IMPULSE_BACKEND_URL (src/config/backendOrigin.ts).
 *
 * Run against the local dev stack (deploy/docker-compose.dev.yaml in the backend repo):
 *
 *   IMPULSE_LIVE_GATEWAY=http://localhost:5200 pnpm run test:e2e:live
 *
 * One-time browser download (chromium only — the lane pins a single project):
 *
 *   pnpm exec playwright install chromium
 */
export type LiveLane = {
  enabled: boolean,
  /** The origin the client bundle's fleets and update socket point at. */
  gatewayOrigin: string,
  poolWsOrigin: string,
  skipReason: string
};

/**
 * The port this lane's OWN Vite dev server listens on. Deliberately distinct from the lottie
 * e2e lane (8099) and from any interactively running dev server — the harness never assumes
 * or reuses somebody else's client instance (reuseExistingServer is off in the config).
 */
export const clientPort = 8199;


export function resolveLiveLane(): LiveLane {
  const marker = process.env.IMPULSE_LIVE_GATEWAY;
  const gatewayOrigin = process.env.IMPULSE_LIVE_WS_GATEWAY || 'http://localhost:5100';
  const poolWsOrigin: string = process.env.IMPULSE_LIVE_POOL_WS ?? 'ws://localhost:5312';

  if(!marker) {
    return {
      enabled: false,
      gatewayOrigin,
      poolWsOrigin,
      skipReason: 'IMPULSE_LIVE_GATEWAY is not set — the B2 lane drives the REAL built web client ' +
        'in a real browser against the LIVE dev backend and cannot run without one. Start the stack ' +
        '(scripts/dev-up.ps1 in the backend repo) and run: ' +
        'IMPULSE_LIVE_GATEWAY=http://localhost:5200 pnpm run test:e2e:live'
    };
  }

  return {enabled: true, gatewayOrigin, poolWsOrigin, skipReason: ''};
}


export const liveLane = resolveLiveLane();
