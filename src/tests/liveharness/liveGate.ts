import {describe} from 'vitest';


/*
 * Gate for the B1 lane: REAL client managers, headless, against the LIVE dev backend.
 *
 * Skip discipline mirrors tests/ImpulseM.Smokes/Fixtures/LiveGatewaySkip.cs in the backend
 * repo: when the live-gateway env is absent, every live scenario SKIPS with an explanatory
 * message — it never fake-passes, and the backend is NEVER mocked (fake-indexeddb is the only
 * allowed client-local runtime shim). This is also what keeps the default unit lane fast:
 * `pnpm test` / `npx vitest run` resolves this gate at collection time and each live file
 * skips in milliseconds.
 *
 * Environment (the same variables the C# live harness reads — LiveStackFixture.cs):
 *
 *   IMPULSE_LIVE_GATEWAY     presence ENABLES the lane. Points at the native-gRPC gateway
 *                            endpoint of the dev stack (default there: http://localhost:5200).
 *   IMPULSE_LIVE_WS_GATEWAY  the HTTP/1.1-capable gateway endpoint (default
 *                            http://localhost:5100). The browser client speaks gRPC-web over
 *                            fetch and Centrifugo over WebSocket; BOTH require HTTP/1.1, so
 *                            this — not the pure-HTTP/2 5200 port — is the origin the manager
 *                            stack is pointed at. The gateway itself serves gRPC-web
 *                            (ImpulseM.Gateway/Program.cs: UseGrpcWeb, DefaultEnabled).
 *
 * Run the lane against the local dev stack (deploy/docker-compose.dev.yaml):
 *
 *   IMPULSE_LIVE_GATEWAY=http://localhost:5200 npx vitest run src/tests/liveharness
 */
export type LiveLane = {
  enabled: boolean,
  /** The origin the client's gRPC-web transport and Centrifugo WebSocket are pointed at. */
  gatewayOrigin: string,
  skipReason?: string
};


export function resolveLiveLane(): LiveLane {
  const marker = process.env.IMPULSE_LIVE_GATEWAY;
  const gatewayOrigin = process.env.IMPULSE_LIVE_WS_GATEWAY || 'http://localhost:5100';

  if(!marker) {
    return {
      enabled: false,
      gatewayOrigin,
      skipReason: 'IMPULSE_LIVE_GATEWAY is not set — the B1 live lane runs the REAL manager stack ' +
        'against the LIVE dev backend and cannot run without one. Start the stack ' +
        '(scripts/dev-up.ps1 in the backend repo) and run: ' +
        'IMPULSE_LIVE_GATEWAY=http://localhost:5200 npx vitest run src/tests/liveharness'
    };
  }

  return {enabled: true, gatewayOrigin};
}


export const liveLane = resolveLiveLane();

if(!liveLane.enabled) {
  // The explanatory message the skip discipline requires: visible in the run log, so a
  // skipped lane is never mistaken for a passed one.
  console.warn(`[liveharness] SKIPPING live scenarios: ${liveLane.skipReason}`);
}

export const describeLive = liveLane.enabled ? describe : describe.skip;
