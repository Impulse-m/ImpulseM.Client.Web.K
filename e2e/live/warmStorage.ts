import {expect, Page} from '@playwright/test';

/*
 * Empirical proof that a reload/restart really preserved the browser profile's IndexedDB
 * (issue #108). A warm-cache scenario whose reload silently wiped storage would assert
 * fidelity on a FRESH cache and be a lie — so survival is proven, not assumed, by three
 * independent signals:
 *
 *   1. A sentinel record in a lane-owned IndexedDB database (written before the reload, read
 *      back verbatim after it). If chromium dropped the origin's storage, the sentinel is
 *      gone — a named failure.
 *   2. Every IndexedDB database name that existed before the reload still exists after it —
 *      including the app's own databases (the snapshot refuses to run if the app created
 *      none, so the check can never pass vacuously on an empty origin).
 *   3. The app itself boots AUTHORIZED, straight into the chat list, without the auth pages —
 *      the app-level consequence of its persisted session surviving.
 */
const sentinelDatabase = 'b2-warm-cache-proof';
const sentinelStore = 'proof';

export type StorageSnapshot = {
  databaseNames: string[],
  localStorageKeys: string[],
  stamp: string
};


export async function stampStorageSentinel(page: Page, side: string, stamp: string): Promise<StorageSnapshot> {
  const snapshot = await page.evaluate(async({sentinelDatabase, sentinelStore, stamp}) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(sentinelDatabase, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(sentinelStore);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(sentinelStore, 'readwrite');
        tx.objectStore(sentinelStore).put(stamp, 'stamp');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    const databases = await indexedDB.databases();
    return {
      databaseNames: databases.map((database) => database.name).filter(Boolean).sort(),
      // Key NAMES only — the app keeps its account session data in localStorage
      // (src/lib/sessionStorage.ts is localStorage-backed), so survival must cover it too;
      // values never leave the page (they hold tokens).
      localStorageKeys: Object.keys(localStorage).sort()
    };
  }, {sentinelDatabase, sentinelStore, stamp});
  const databaseNames = snapshot.databaseNames;

  const appDatabases = databaseNames.filter((name) => name !== sentinelDatabase);
  expect(
    appDatabases.length,
    `warm-cache sentinel sanity on the ${side} side: the app created ZERO IndexedDB databases ` +
    'before the reload, so "IndexedDB survived" would be vacuously true — the warm-cache ' +
    'scenario refuses to measure an origin the app never persisted anything into'
  ).toBeGreaterThan(0);

  return {databaseNames, localStorageKeys: snapshot.localStorageKeys, stamp};
}


export async function assertStorageSurvived(page: Page, side: string, before: StorageSnapshot, context: string): Promise<void> {
  const after = await page.evaluate(async({sentinelDatabase, sentinelStore}) => {
    const readStamp = await new Promise<string | undefined>((resolve, reject) => {
      const request = indexedDB.open(sentinelDatabase, 1);
      request.onupgradeneeded = () => {
        // The database did not exist any more — the upgrade path IS the wipe signal; still
        // create the store so the read below resolves (to undefined) instead of throwing.
        request.result.createObjectStore(sentinelStore);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(sentinelStore, 'readonly');
        const get = tx.objectStore(sentinelStore).get('stamp');
        get.onsuccess = () => {
          db.close();
          resolve(get.result as string | undefined);
        };
        get.onerror = () => reject(get.error);
      };
    });

    const databases = await indexedDB.databases();
    return {
      stamp: readStamp,
      databaseNames: databases.map((database) => database.name).filter(Boolean).sort(),
      localStorageKeys: Object.keys(localStorage).sort()
    };
  }, {sentinelDatabase, sentinelStore});

  expect(
    after.stamp,
    `IndexedDB did NOT survive on the ${side} side (${context}): the sentinel record written ` +
    'before the reload is gone, so the profile\'s storage was wiped and every "warm cache" ' +
    'assertion after this point would run against a cold cache — the scenario would be a lie'
  ).toBe(before.stamp);

  const missing = before.databaseNames.filter((name) => !after.databaseNames.includes(name));
  expect(
    missing,
    `IndexedDB databases vanished across the reload on the ${side} side (${context}) — the ` +
    'received array names every database that existed before and is gone now; the warm state ' +
    'under test did not actually persist'
  ).toEqual([]);

  const missingKeys = before.localStorageKeys.filter((key) => !after.localStorageKeys.includes(key));
  expect(
    missingKeys,
    `localStorage keys vanished across the reload on the ${side} side (${context}) — the app ` +
    'keeps its account session data in localStorage (src/lib/sessionStorage.ts), so a vanished ' +
    'key is warm state the user\'s browser would have kept and this profile lost; the received ' +
    'array names every lost key'
  ).toEqual([]);
}


/**
 * Named authorized-boot gate for a freshly restarted profile: waits until the app commits to
 * either the chat UI or the auth pages, and fails BY NAME on the auth pages instead of letting
 * a generic im-ready timeout swallow the real story (the session did not survive the restart).
 */
export async function assertBootedAuthorized(page: Page, side: string, context: string): Promise<void> {
  const landing = await page.waitForFunction(() => {
    const w = window as any;
    // body.has-auth-pages is the DEFAULT boot state (baked into index.html and removed late
    // in bootstrapIm), so it cannot distinguish "still booting" from "landed on auth". The
    // POSITIVE auth signal is the mounted auth flow host (#auth-pages, mountAuthFlow.tsx);
    // the positive authorized signal is bootstrapIm having removed the class with the im
    // surfaces up.
    if(document.getElementById('auth-pages')) {
      return 'auth';
    }
    if(!document.body.classList.contains('has-auth-pages') && !!w.appImManager && !!w.rootScope?.managers) {
      return 'im';
    }
    return undefined;
  }, undefined, {timeout: 180_000});

  expect(
    await landing.jsonValue(),
    `the ${side} side landed on the AUTH pages after ${context} — the persisted session did ` +
    'not survive the profile reload, so the browser is signing up from scratch instead of ' +
    'living in the warm state the scenario exists to test'
  ).toBe('im');
}
