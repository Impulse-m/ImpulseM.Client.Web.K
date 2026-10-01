import {ApiFileManager} from '@appManagers/apiFileManager';

type ApiErrorShape = {type: string, code: number};

function makeManager(refreshed: Uint8Array) {
  const manager = Object.create(ApiFileManager.prototype) as ApiFileManager;
  (manager as any).requestFilePartReferences = new Map();
  (manager as any).refreshReferencePromises = {};
  (manager as any).referencesStorage = {
    refreshReference: vi.fn(async() => refreshed)
  };
  return manager;
}

function collectUnhandledRejections() {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', listener);
  return {
    reasons,
    dispose: () => {
      process.off('unhandledRejection', listener);
    }
  };
}

async function settleMicrotasksAndTimers() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ApiFileManager file reference refresh', () => {
  it('refetches an expired reference and retries without leaking an unhandled rejection', async() => {
    const expired: ApiErrorShape = {type: 'FILE_REFERENCE_EXPIRED', code: 400};
    const refreshed = new Uint8Array([2, 2, 2]);
    const manager = makeManager(refreshed);
    const context = {
      _: 'inputPhotoFileLocation',
      id: 98484925513728,
      file_reference: new Uint8Array([1, 1, 1])
    };
    const callback = vi.fn()
    .mockRejectedValueOnce(expired)
    .mockResolvedValueOnce('bytes');
    const unhandled = collectUnhandledRejections();

    try {
      const result = await manager.invokeApiWithReference({
        context: context as any,
        callback
      });
      await settleMicrotasksAndTimers();

      expect(result).toBe('bytes');
      expect(callback).toHaveBeenCalledTimes(2);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it('surfaces a non-reference error to its caller only, never as an unhandled rejection', async() => {
    const invalid: ApiErrorShape = {type: 'LOCATION_INVALID', code: 400};
    const manager = makeManager(new Uint8Array([2]));
    const context = {
      _: 'inputDocumentFileLocation',
      id: 1,
      file_reference: new Uint8Array([1])
    };
    const unhandled = collectUnhandledRejections();

    try {
      await expect(manager.invokeApiWithReference({
        context: context as any,
        callback: () => Promise.reject(invalid)
      })).rejects.toBe(invalid);
      await settleMicrotasksAndTimers();

      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });
});
