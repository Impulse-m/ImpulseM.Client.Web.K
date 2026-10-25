import {beforeEach, describe, expect, test, vi} from 'vitest';

import deferredPromise from '@helpers/cancellablePromise';
import type {ResetStoragesPromise} from '@appManagers/appStateManager';

const controls = vi.hoisted(() => ({
  loadStorages: (): Promise<unknown> => new Promise<unknown>(() => {})
}));

vi.mock('@appManagers/appStoragesManager', () => ({
  AppStoragesManager: class {
    public loadStorages(): Promise<unknown> {
      return controls.loadStorages();
    }
  }
}));

vi.mock('@appManagers/createManagers', () => ({
  default: async(): Promise<Record<string, never>> => ({})
}));

type LoadStorages = typeof import('@appManagers/utils/storages/loadStorages').default;
type AppManagersManager = typeof import('@appManagers/appManagersManager').default;

let loadStorages: LoadStorages;
let appManagersManager: AppManagersManager;
let captured: string[];

async function flushMicrotasks(): Promise<void> {
  for(let turn = 0; turn < 50; ++turn) {
    await Promise.resolve();
  }
}

function stageLines(): string[] {
  return captured.filter((line) => line.includes(' stage '));
}

function withoutDuration(line: string): string {
  return line.replace(/ done in \d+ms$/, ' done');
}

beforeEach(async() => {
  vi.resetModules();

  loadStorages = (await import('@appManagers/utils/storages/loadStorages')).default;
  appManagersManager = (await import('@appManagers/appManagersManager')).default;

  // * loaded after the manager graph, which installs the production Loki sink on import
  const logsBuffer = await import('@lib/debug/logsBuffer');
  captured = [];
  logsBuffer.setLogSink((_level, _prefix, args) => {
    captured.push(args.join(' '));
  });

  controls.loadStorages = () => new Promise<unknown>(() => {});
});

describe('loadStorages stage logs', () => {
  test('a state wait that never resolves logs its start and no finish', async() => {
    const resetStoragesPromise: ResetStoragesPromise = deferredPromise();
    void loadStorages(1, {} as Parameters<LoadStorages>[1], resetStoragesPromise);
    await flushMicrotasks();

    expect(
      stageLines().filter((line) => line.includes('resetStorages')),
      'a parked state wait must log its start and no done line, so a stall names resetStorages'
    ).toEqual(['loadStorages stage resetStorages start']);
  });

  test('an IDB read that never resolves stops before the state wait starts', async() => {
    const stuckStorages = {
      users: {getAll: () => new Promise<unknown[]>(() => {})}
    } as unknown as Parameters<LoadStorages>[1];
    const resetStoragesPromise: ResetStoragesPromise = deferredPromise();
    void loadStorages(1, stuckStorages, resetStoragesPromise);
    await flushMicrotasks();

    expect(
      stageLines(),
      'a stalled IDB read must be named idbRead, and the state wait must not have started'
    ).toEqual(['loadStorages stage idbRead start']);
  });

  test('every stage that starts logs its finish once its dependency resolves', async() => {
    const resetStoragesPromise: ResetStoragesPromise = deferredPromise();
    resetStoragesPromise.resolve({storages: new Map(), callback: async() => {}});
    await loadStorages(1, {} as Parameters<LoadStorages>[1], resetStoragesPromise);

    expect(
      stageLines().map(withoutDuration),
      'each stage must log start and then done, in order'
    ).toEqual([
      'loadStorages stage idbRead start',
      'loadStorages stage idbRead done',
      'loadStorages stage resetStorages start',
      'loadStorages stage resetStorages done'
    ]);
  });
});

describe('createManagers stage logs', () => {
  test('a loadStorages that never resolves parks every account on that stage', async() => {
    void appManagersManager.getManagersByAccount();
    await flushMicrotasks();

    expect(
      stageLines().filter((line) => line.includes('stage loadStorages')),
      'every account must log a loadStorages start and no loadStorages done while it is parked'
    ).toEqual(Array(4).fill('createManagers stage loadStorages start'));
  });

  test('every stage that starts logs its finish once its dependencies resolve', async() => {
    controls.loadStorages = async() => ({});
    const threadedWorkers = appManagersManager['threadedSharedWorkers'];
    threadedWorkers.crypto.promise?.resolve?.();

    await appManagersManager.getManagersByAccount();
    await flushMicrotasks();

    const starts = stageLines().filter((line) => line.endsWith(' start'));
    const finishes = stageLines().filter((line) => / done in \d+ms$/.test(line));
    expect(
      starts,
      'the managers, storages, crypto and accounts stages must all log'
    ).toHaveLength(13);
    expect(
      finishes.map(withoutDuration).sort(),
      'every start must have exactly one done with the same stage name'
    ).toEqual(starts.map((line) => line.replace(/ start$/, ' done')).sort());
  });
});
