import {ApiFileManager} from '@appManagers/apiFileManager';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const CANON_PART_SIZE = 512 * KIB;

function makeManager(): ApiFileManager {
  const manager = Object.create(ApiFileManager.prototype) as ApiFileManager;
  (manager as any).maxUploadParts = 4000;
  (manager as any).uploadPromises = {};
  (manager as any).tempId = 0;
  return manager;
}

function getLimitPart(manager: ApiFileManager, size: number): number {
  return (manager as any).getLimitPart(size);
}

function startUpload(manager: ApiFileManager, file: Blob): number {
  const downloadRequest = vi.spyOn(manager as any, 'downloadRequest').mockReturnValue(new Promise(() => {}));
  manager.upload({file, fileName: 'document.bin'});
  return downloadRequest.mock.calls.length;
}

describe('ApiFileManager part size', () => {
  it.each([
    ['1 MiB', MIB],
    ['20 MiB', 20 * MIB],
    ['100 MiB', 100 * MIB],
    ['1.9 GiB', Math.floor(1.9 * GIB)]
  ])('uses 512 KiB parts for a %s file', (_label: string, size: number) => {
    const manager = makeManager();

    expect(getLimitPart(manager, size)).toBe(CANON_PART_SIZE);
  });

  it('keeps a file below 512 KiB in one part of its own length', () => {
    const manager = makeManager();

    expect(getLimitPart(manager, 300 * KIB)).toBe(300 * KIB);
  });

  it('sends a 300 KiB upload as a single part', () => {
    const manager = makeManager();
    const file = new Blob([new Uint8Array(300 * KIB)]);

    expect(startUpload(manager, file)).toBe(1);
  });

  it('cuts a 20 MiB upload into 512 KiB parts', () => {
    const manager = makeManager();
    const file = new Blob([new Uint8Array(20 * MIB)]);

    expect(startUpload(manager, file)).toBe(40);
  });

  it('cuts a 1.9 GiB upload into 512 KiB parts', () => {
    const manager = makeManager();
    const size: number = Math.floor(1.9 * GIB);
    const file = {size, type: ''} as unknown as Blob;

    expect(startUpload(manager, file)).toBe(Math.ceil(size / CANON_PART_SIZE));
  });
});
