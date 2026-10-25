import {vi} from 'vitest';

import type {ActiveAccountNumber} from '@lib/accounts/types';
import {WireInvariants} from './invariants';
import {liveLane} from './liveGate';


/*
 * ============================================================================================
 * B1 live harness — the REAL worker manager stack, headless in node, against the LIVE backend
 * ============================================================================================
 *
 * This is THE lane convention (issue #92 step 1). What it does and does not fake:
 *
 *   REAL      the fork's own modules, uninstrumented: the TL adapter
 *             (src/lib/impulse/grpc/adapter.ts), fleet lanes, session, apiManager,
 *             apiFileManager, appMessagesManager, apiUpdatesManager, createManagers — the
 *             exact code the mtproto worker runs in the browser.
 *   REAL      the backend: the live dev stack (the Centrifugo RPC and media fleets and the update
 *             socket, through the same origin), real accounts registered through the real client auth path
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
 * has run, which createManagers already triggers through ApiManager.after() below. The
 * single-slot bootLiveManagerStack only instantiates managers for slot 1, and does not need to
 * touch slots 2-4 at all: their gates are simply never asked. bootLiveMultiAccountStack (below)
 * instantiates SEVERAL slots side by side in ONE module graph — which is exactly what the real
 * SharedWorker does (createManagers builds one manager set per slot), and what #436 made safe by
 * keying every credential, gate and transport by account number.
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
  afterEnvInstalled?: () => void,
  /**
   * Overrides of the browser-parity environment (browserParityEnvironment). The default leaves the
   * call managers off (IS_CALL_SUPPORTED / IS_GROUP_CALL_SUPPORTED false), so a scenario that drives
   * calls turns them on here, before the managers read the flags in their `after()`.
   */
  environment?: Record<string, unknown>
};

export type LiveHelpers = {
  makeMediaSize(width: number, height: number): any,
  getServerMessageId(messageId: number): number,
  accountController: any,
  appConfig: {id: number, hash: string}
};

export type LiveStack = {
  managers: any,
  accountNumber: 1,
  wire: WireInvariants,
  /** The userId loadState found persisted at boot — undefined on a first (pre-auth) boot. */
  userIdAtBoot: UserId | undefined,
  /** Graph-bound helpers (see the RULE above). */
  helpers: LiveHelpers,
  dispose(): Promise<void>
};

/** One account slot inside a bootLiveMultiAccountStack — the same handle signInHeadless drives. */
export type LiveAccountSlot = {
  accountNumber: ActiveAccountNumber,
  managers: any,
  userIdAtBoot: UserId | undefined,
  helpers: LiveHelpers
};

export type MultiAccountLiveStack = {
  /** One WebSocket-prototype observer covers every slot's socket — it is graph-wide, not per slot. */
  wire: WireInvariants,
  slots: Map<ActiveAccountNumber, LiveAccountSlot>,
  helpers: LiveHelpers,
  slot(accountNumber: ActiveAccountNumber): LiveAccountSlot,
  dispose(): Promise<void>
};


/**
 * The once-per-graph half of the boot contract: reset the module graph, install the node env
 * (and the caller's wire hook), replay the main-thread reload-state pipeline. Returns the raw
 * per-account state map loadState produced, ready to hand a slot at a time to buildManagerSlot.
 */
async function installBootPrelude(gatewayOrigin: string, options?: BootOptions): Promise<any> {
  // A boot IS a page load: fresh module graph over the same persisted client state.
  vi.resetModules();

  // The transport reads this at module init (src/config/backendOrigin.ts). Must be stubbed
  // before ANY src import below pulls the config in.
  vi.stubEnv('VITE_IMPULSE_BACKEND_URL', gatewayOrigin);
  vi.stubEnv('VITE_IMPULSE_UPDATE_WS', liveLane.updateWsOrigin ?? '');
  vi.stubEnv('VITE_IMPULSE_POOL_WS', liveLane.poolWsOrigin ?? '');

  const {installNodeEnv} = await import('../api/nodeEnv');
  installNodeEnv();
  options?.afterEnvInstalled?.();

  await import('@lib/polyfill');
  await import('@helpers/peerIdPolyfill');

  const DeferredIsUsingPasscode = (await import('@lib/passcode/deferredIsUsingPasscode')).default;
  DeferredIsUsingPasscode.resolveDeferred(false);

  const {setEnvironment} = await import('@environment/utils');
  setEnvironment({...browserParityEnvironment(), ...options?.environment} as any);

  const MTProtoMessagePort = (await import('@lib/mainWorker/mainMessagePort')).default;
  new MTProtoMessagePort<false>(false);

  // ---- main-thread half of the boot contract: the real reload-state pipeline ----
  const loadStateForAllAccountsOnce = (await import('@appManagers/utils/state/loadState')).default;
  return loadStateForAllAccountsOnce();
}


/**
 * The per-slot half of the boot contract: the 'state' handler of
 * src/lib/mainWorker/index.worker.ts (replicated verbatim) followed by createManagers, for ONE
 * account slot. Called once per slot; several slots share ONE module graph, exactly as the real
 * SharedWorker hosts all four account slots at once.
 */
async function buildManagerSlot(
  states: any,
  accountNumber: ActiveAccountNumber
): Promise<{managers: any, userIdAtBoot: UserId | undefined}> {
  const loaded = states[accountNumber];

  const AppStateManager = (await import('@appManagers/appStateManager')).default;
  const stateManager = new AppStateManager(accountNumber);
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
  const appStoragesManager = new AppStoragesManager(accountNumber, stateManager.resetStoragesPromise);
  await appStoragesManager.loadStorages();

  const createManagers = (await import('@appManagers/createManagers')).default;
  const managers = await createManagers(appStoragesManager, stateManager, accountNumber, loaded.userId);

  return {managers, userIdAtBoot: loaded.userId || undefined};
}


/** Attaches the wire invariants to the shared ApiManager prototype and loads the graph-bound helpers. */
async function loadWireAndHelpers(): Promise<{wire: WireInvariants, helpers: LiveHelpers}> {
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

  const {makeMediaSize} = await import('@helpers/mediaSize');
  const getServerMessageId = (await import('@appManagers/utils/messageId/getServerMessageId')).default;
  const accountController = (await import('@lib/accounts/accountController')).default;
  const appConfig = (await import('@config/app')).default;

  return {wire, helpers: {makeMediaSize, getServerMessageId, accountController, appConfig}};
}


export async function bootLiveManagerStack(gatewayOrigin: string, options?: BootOptions): Promise<LiveStack> {
  const states = await installBootPrelude(gatewayOrigin, options);
  const {wire, helpers} = await loadWireAndHelpers();
  const {managers, userIdAtBoot} = await buildManagerSlot(states, 1);

  return {
    managers,
    accountNumber: 1,
    wire,
    userIdAtBoot,
    helpers,
    dispose: async() => {
      try {
        const realtime = await import('@lib/impulse/realtime');
        realtime.stopImpulseRealtime?.(1);
      } catch{
        // The realtime module may never have connected on a pre-auth stack; nothing to stop.
      }
    }
  };
}


/**
 * Boots MULTIPLE account slots inside ONE module graph — the harness form of the real
 * SharedWorker, which hosts all four slots at once. Every slot gets its own AppStateManager,
 * AppStoragesManager and full manager set (via buildManagerSlot), over the same fake-indexeddb
 * that the real client's slots share; #436 keyed credentials, the session gate and the gRPC
 * transport by account number, so the slots do not collide.
 *
 * The single WireInvariants and the caller's RealtimeWireObserver are graph-wide: one observer
 * sees the sockets of every slot, so a per-account assertion filters by channel, not by observer.
 */
export async function bootLiveMultiAccountStack(
  gatewayOrigin: string,
  accountNumbers: ActiveAccountNumber[],
  options?: BootOptions
): Promise<MultiAccountLiveStack> {
  const states = await installBootPrelude(gatewayOrigin, options);
  const {wire, helpers} = await loadWireAndHelpers();

  const slots = new Map<ActiveAccountNumber, LiveAccountSlot>();
  // Sequential on purpose: buildManagerSlot's createManagers runs each slot's ApiManager.after(),
  // and building them one at a time keeps the boot deterministic and mirrors the single-slot path.
  for(const accountNumber of accountNumbers) {
    const {managers, userIdAtBoot} = await buildManagerSlot(states, accountNumber);
    slots.set(accountNumber, {accountNumber, managers, userIdAtBoot, helpers});
  }

  return {
    wire,
    slots,
    helpers,
    slot(accountNumber: ActiveAccountNumber): LiveAccountSlot {
      const found = slots.get(accountNumber);
      if(!found) {
        throw new Error(`bootLiveMultiAccountStack: slot ${accountNumber} was not booted`);
      }

      return found;
    },
    dispose: async() => {
      try {
        const realtime = await import('@lib/impulse/realtime');
        // Every booted slot's socket, not one — the whole point of this stack is that each slot
        // owns its own connection now.
        for(const accountNumber of slots.keys()) {
          realtime.stopImpulseRealtime?.(accountNumber);
        }
      } catch{
        // The realtime module may never have connected; nothing to stop.
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
