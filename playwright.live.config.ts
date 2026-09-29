import {defineConfig, devices} from '@playwright/test';

import {clientPort, liveLane} from './e2e/live/lane';

// B2 lane: the REAL web client, served by this lane's OWN Vite instance on a dedicated port,
// driven in real chromium against the LIVE dev backend (see e2e/live/lane.ts for the env gate
// and endpoint discipline). Never points at — or reuses — an interactively running dev server:
// the CEO's session must survive a test run untouched, and a stale server carrying a different
// VITE_IMPULSE_BACKEND_URL would poison every scenario, so reuseExistingServer stays off.
//
// Without IMPULSE_LIVE_GATEWAY the webServer block is omitted entirely and every scenario
// skips at collection time — the gated run costs milliseconds, not a Vite boot.
export default defineConfig({
  testDir: './e2e/live',
  fullyParallel: false,
  // One worker: scenarios share one live backend; serial execution keeps every failure
  // attributable to its own scenario instead of a neighbour's traffic.
  workers: 1,
  timeout: 300_000,
  expect: {timeout: 30_000},
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${clientPort}/`,
    headless: true,
    viewport: {width: 1280, height: 800},
    // A red on this lane is a finding that must be diagnosable from artifacts alone.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']},
      // archive120Upload targets Firefox against the actual public ingress on purpose (the
      // reported incident's own browser/route) — it belongs to firefox-archive120 below only,
      // so this line is what keeps the ordinary chromium live suite provably unchanged rather
      // than silently gaining a second, unrelated 120 MiB-over-the-network test.
      testIgnore: '**/archive120Upload.live.spec.ts'
    },
    {
      // Selected explicitly with --project=firefox-archive120; never picked up by a bare
      // `pnpm run test:e2e:live` run of the rest of the suite because testMatch below is the
      // only spec file this project ever collects. The scenario itself carries a second,
      // narrower env gate (IMPULSE_LIVE_ARCHIVE120) so even an explicit --project run skips
      // unless that is also set on purpose.
      name: 'firefox-archive120',
      use: {...devices['Desktop Firefox']},
      testMatch: '**/archive120Upload.live.spec.ts'
    }
  ],
  webServer: liveLane.enabled ? {
    command: `pnpm exec vite --port ${clientPort} --strictPort`,
    url: `http://localhost:${clientPort}/`,
    env: {
      // Same knob the lottie e2e lane uses: plain-HTTP/1.1 dev server, dev-checks off.
      TWEB_PREVIEW: '1',
      // Bakes the live gateway into the served bundle (src/config/backendOrigin.ts). A real
      // process-env value takes precedence over the repo's .env, so the lane always points at
      // the stack the gate named, not at whatever .env happens to contain.
      VITE_IMPULSE_BACKEND_URL: liveLane.gatewayOrigin
    },
    reuseExistingServer: false,
    timeout: 180_000
  } : undefined
});
