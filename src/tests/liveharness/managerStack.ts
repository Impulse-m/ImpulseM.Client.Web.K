import {vi} from 'vitest';

import {WireInvariants} from './invariants';


/*
 * ============================================================================================
 * B1 live harness — the REAL worker manager stack, headless in node, against the LIVE backend
 * ============================================================================================
 *
 * This is THE lane convention (issue #92 step 1). What it does and does not fake:
 *
 *   REAL      the fork's own modules, uninstrumented: the gRPC-web adapter
 *             (src/lib/impulse/grpc/adapter.ts), transport, session, apiManager,
 *             apiFileManager, appMessagesManager, apiUpdatesManager, createManagers — the
 *             exact code the mtproto worker runs in the browser.
 *   REAL      the backend: a live dev stack gateway (gRPC-web + Centrifugo WS through the same
 *             origin), real accounts registered through the real client auth path
 *             (auth.sendCode -> auth.signIn -> auth.signUp), real uploads, real history.
 *   SHIM      fake-indexeddb + jsdom + the node polyfills in ../api/nodeEnv.ts — the allowed
 *             CLIENT-LOCAL runtime shims. The backend is NEVER mocked, no RPC is ever stubbed.
 *
 * Boot fidelity: each bootLiveManagerStack call replays the production boot contract —
 *   main thread: loadStateForAllAccountsOnce() (@appManagers/utils/state/loadState)
 *   worker:      the 'state' handler of src/lib/mainWorker/index.worker.ts (replicated here
 *                verbatim), then createManagers(...) exactly as appManagersManager does.
 *
 * Reload semantics: every boot starts with vi.resetModules(), so a second boot in the same
 * test is a page refresh — a FRESH module graph (fresh session.ts gate, fresh manager
 * singletons) over the SAME persisted client state (fake-indexeddb databases and
 * localStorage survive module resets; they are process-global). That is precisely what a
 * browser reload gives the real client.
 *
 * RULE for live scenarios: import src modules only DYNAMICALLY and only AFTER boot — a static
 * import at the top of a test file freezes the pre-reset module graph and your handles will
 * not see the booted stack. Graph-bound helpers every scenario needs are handed back on the
 * stack object instead.
 *
 * Session-gate note: whenImpulseSessionReady(accountNumber) (src/lib/impulse/session.ts) is one
 * gate per account slot (#436) — slot 1's gate opens once slot 1's own restoreImpulseSession(1)
 * has run, which createManagers already triggers through ApiManager.after() below. This stack
 * only instantiates managers for slot 1, and does not need to touch slots 2-4 at all: their
 * gates are simply never asked.
 *
 * Run:  IMPULSE_LIVE_GATEWAY=http://localhost:5200 npx vitest run src/tests/liveharness
 * (endpoint discipline documented in ./liveGate.ts).
 */
export type BootOptions = {
  /**
   * Runs synchronously right after installNodeEnv() and before ANY src module of the new
   * graph loads. installNodeEnv OVERWRITES global shims (WebSocket included) on every boot,
   * so this hook is the only race-free spot to wrap a global for wire observation
   * (RealtimeWireObserver) — installing after boot returns would race the realtime spin-up
   * that after() kicks off during createManagers.
   */
  afterEnvInstalled?: () => void
};

export type LiveStack = {
  managers: any,
  accountNumber: 1,
  wire: WireInvariants,
  /** The userId loadState found persisted at boot — undefined on a first (pre-auth) boot. */
  userIdAtBoot: UserId | undefined,
  /** Graph-bound helpers (see the RULE above). */
  helpers: {
    makeMediaSize(width: number, height: number): any,
    getServerMessageId(messageId: number): number,
    accountController: any,
    appConfig: {id: number, hash: string}
  },
  dispose(): Promise<void>
};


export async function bootLiveManagerStack(gatewayOrigin: string, options?: BootOptions): Promise<LiveStack> {
  // A boot IS a page load: fresh module graph over the same persisted client state.
  vi.resetModules();

  // The transport reads this at module init (src/config/backendOrigin.ts). Must be stubbed
  // before ANY src import below pulls the config in.
  vi.stubEnv('VITE_IMPULSE_BACKEND_URL', gatewayOrigin);

  const {installNodeEnv} = await import('../api/nodeEnv');
  installNodeEnv();
  options?.afterEnvInstalled?.();

  await import('@lib/polyfill');
  await import('@helpers/peerIdPolyfill');

  const DeferredIsUsingPasscode = (await import('@lib/passcode/deferredIsUsingPasscode')).default;
  DeferredIsUsingPasscode.resolveDeferred(false);

  const {setEnvironment} = await import('@environment/utils');
  setEnvironment(browserParityEnvironment() as any);

  const MTProtoMessagePort = (await import('@lib/mainWorker/mainMessagePort')).default;
  new MTProtoMessagePort<false>(false);

  // ---- main-thread half of the boot contract: the real reload-state pipeline ----
  const loadStateForAllAccountsOnce = (await import('@appManagers/utils/state/loadState')).default;
  const states = await loadStateForAllAccountsOnce();
  const loaded = states[1];

  // ---- worker half: the 'state' handler of src/lib/mainWorker/index.worker.ts, verbatim ----
  const AppStateManager = (await import('@appManagers/appStateManager')).default;
  const stateManager = new AppStateManager(1);
  stateManager.userId = loaded.userId;
  stateManager.newVersion = loaded.newVersion;
  stateManager.oldVersion = loaded.oldVersion;

  if(loaded.userId && loaded.resetStorages.has('users')) {
    loaded.resetStorages.set('users', [loaded.userId]);
  }

  stateManager.resetStoragesPromise.resolve({
    storages: loaded.resetStorages,
    refetch: loaded.refetchStorages,
    callback: async() => {
      const map: Map<string, any> = new Map();
      const pushedKeysCombined: string[] = [...loaded.pushedKeys];
      for(const key in loaded.common) {
        map.set(key, (loaded.common as any)[key]);
        pushedKeysCombined.push(key);
      }

      for(const key in loaded.state) {
        map.set(key, (loaded.state as any)[key]);
      }

      const promises: Promise<any>[] = [];
      for(const [key, value] of map) {
        promises.push(stateManager.pushToState(key as any, value, true, !pushedKeysCombined.includes(key)));
      }

      await Promise.all(promises);
    }
  });

  const {AppStoragesManager} = await import('@appManagers/appStoragesManager');
  const appStoragesManager = new AppStoragesManager(1, stateManager.resetStoragesPromise);
  await appStoragesManager.loadStorages();

  // Wire invariants observe from the PROTOTYPE so the boot storm createManagers fires is
  // covered too, with the serialize proof running the same adapter stages of this graph.
  const wire = new WireInvariants();
  const {ApiManager} = await import('@appManagers/apiManager');
  const adapter = await import('@lib/impulse/grpc/adapter');
  const serviceMap = await import('@lib/impulse/grpc/serviceMap');
  wire.attachToPrototype(ApiManager.prototype, {
    getServiceAndMethod: serviceMap.getServiceAndMethod,
    buildProtoInit: adapter.buildProtoInit
  });

  const createManagers = (await import('@appManagers/createManagers')).default;
  const managers = await createManagers(appStoragesManager, stateManager, 1, loaded.userId);

  const {makeMediaSize} = await import('@helpers/mediaSize');
  const getServerMessageId = (await import('@appManagers/utils/messageId/getServerMessageId')).default;
  const accountController = (await import('@lib/accounts/accountController')).default;
  const appConfig = (await import('@config/app')).default;

  return {
    managers,
    accountNumber: 1,
    wire,
    userIdAtBoot: loaded.userId || undefined,
    helpers: {makeMediaSize, getServerMessageId, accountController, appConfig},
    dispose: async() => {
      try {
        const realtime = await import('@lib/impulse/realtime');
        realtime.stopImpulseRealtime?.();
      } catch{
        // The realtime module may never have connected on a pre-auth stack; nothing to stop.
      }
    }
  };
}


/**
 * Everything the send/history path reads off getEnvironment(), valued the way a Chromium
 * browser values it — mirrors src/environment/*.ts. The api-harness stub left every MIME set
 * EMPTY, which silently reclassifies a WebM round note as a plain document
 * (appMessagesManager.makeDocumentAndMetaForSendingFile branches on
 * VIDEO_MIME_TYPES_SUPPORTED); a live lane must classify exactly like the browser.
 */
function browserParityEnvironment() {
  const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/bmp', 'image/webp']);
  const videoMimeTypes = new Set(['image/gif', 'video/mp4', 'video/webm']);

  return {
    IS_APPLE: false,
    IS_APPLE_MOBILE: false,
    IS_APPLE_MX: false,
    IS_ANDROID: false,
    IS_CHROMIUM: true,
    IS_CHROMIUM_92_OR_OLDER: false,
    CHROMIUM_VERSION: 124,
    IS_SAFARI: false,
    IS_FIREFOX: false,
    IS_MOBILE: false,
    IS_MOBILE_SAFARI: false,
    USER_AGENT: 'impulsem-b1-live-harness/1.0',
    IS_CALL_SUPPORTED: false,
    IS_CANVAS_FILTER_SUPPORTED: false,
    IS_EMOJI_SUPPORTED: true,
    IS_GEOLOCATION_SUPPORTED: false,
    IS_GROUP_CALL_SUPPORTED: false,
    IS_PARALLAX_SUPPORTED: false,
    IS_SCREEN_SHARING_SUPPORTED: false,
    IS_TOUCH_SUPPORTED: false,
    IS_VIBRATE_SUPPORTED: false,
    IS_OPUS_SUPPORTED: true,
    IS_SHARED_WORKER_SUPPORTED: false,
    IS_WEBP_SUPPORTED: true,
    IS_WEBM_SUPPORTED: true,
    IS_WEBRTC_SUPPORTED: false,
    IS_LIVE_STREAM_SUPPORTED: false,
    IS_VIDEO_SUPPORTED: true,
    IS_H264_SUPPORTED: true,
    IS_H265_SUPPORTED: false,
    IMAGE_MIME_TYPES_SUPPORTED: imageMimeTypes,
    MEDIA_MIME_TYPES_SUPPORTED: new Set([...imageMimeTypes, ...videoMimeTypes]),
    VIDEO_MIME_TYPES_SUPPORTED: videoMimeTypes
  };
}
