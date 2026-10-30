import deferredPromise from '@helpers/cancellablePromise';
import readBlobAsUint8Array from '@helpers/blob/readBlobAsUint8Array';
import {ApiFileManager, DownloadOptions} from '@appManagers/apiFileManager';

const KIB = 1024;
const MIB = 1024 * KIB;
const PART_SIZE = 512 * KIB;

type RunDownloadOptions = {
  source: Uint8Array,
  size?: number,
  heldOffsets: Set<number>
};

type RunDownloadResult = {
  blob: Blob,
  requestedOffsets: number[]
};

function makeSource(length: number): Uint8Array {
  const source = new Uint8Array(length);
  for(let index = 0; index < length; ++index) {
    source[index] = (index * 31 + (index >> 8)) & 0xff;
  }

  return source;
}

function lastThreeOffsets(size: number): Set<number> {
  const lastPartOffset = Math.ceil(size / PART_SIZE) - 1;
  return new Set([lastPartOffset - 2, lastPartOffset - 1, lastPartOffset].map((index: number): number => index * PART_SIZE));
}

function makeWriter() {
  const chunks = new Map<number, Uint8Array>();
  let trimmedTo: number | undefined;

  return {
    write: vi.fn(async(bytes: Uint8Array, offset: number) => {
      chunks.set(offset, bytes.slice());
    }),
    trim: vi.fn((length: number) => {
      trimmedTo = length;
    }),
    finalize: vi.fn(() => {
      let written = 0;
      for(const [offset, bytes] of chunks) {
        written = Math.max(written, offset + bytes.byteLength);
      }

      const total = trimmedTo ?? written;
      const out = new Uint8Array(total);
      for(const [offset, bytes] of chunks) {
        const length = Math.min(bytes.byteLength, total - offset);
        if(length > 0) {
          out.set(bytes.subarray(0, length), offset);
        }
      }

      return new Blob([out]);
    })
  };
}

function settleTimers(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
  .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

async function runDownload({
  source,
  size,
  heldOffsets
}: RunDownloadOptions): Promise<RunDownloadResult> {
  const requestedOffsets: number[] = [];
  const releases: Array<() => void> = [];

  const manager = Object.create(ApiFileManager.prototype) as ApiFileManager;
  const log = Object.assign(vi.fn(), {bindPrefix: () => vi.fn(), error: vi.fn()});
  (manager as any).log = log;
  (manager as any).tempId = 0;
  (manager as any).downloadPromises = {};
  (manager as any).rootScope = {dispatchEvent: vi.fn()};
  (manager as any).cacheStorage = {
    getFile: vi.fn(() => Promise.reject(new Error('NO_ENTRY_FOUND'))),
    prepareWriting: vi.fn(() => {
      const writer = makeWriter();
      return {
        deferred: deferredPromise<Blob>(),
        getWriter: () => writer
      };
    })
  };
  (manager as any).requestFilePart = vi.fn(({offset, limit}: {offset: number, limit: number}) => {
    requestedOffsets.push(offset);
    const bytes = new Uint8Array(source.subarray(
      Math.min(offset, source.byteLength),
      Math.min(offset + limit, source.byteLength)
    ));
    const result = {_: 'upload.file', bytes, type: {_: 'storage.fileUnknown'}};
    if(!heldOffsets.has(offset)) {
      return Promise.resolve(result);
    }

    return new Promise((resolve) => releases.push(() => resolve(result)));
  });

  const options: DownloadOptions = {
    dcId: 2,
    location: {
      _: 'inputDocumentFileLocation',
      id: 1,
      access_hash: 1,
      file_reference: new Uint8Array([1]),
      thumb_size: ''
    } as unknown as DownloadOptions['location'],
    size,
    mimeType: 'application/pdf'
  };

  const download = manager.download(options);
  await settleTimers();
  for(const release of releases) {
    release();
  }

  const blob = await download;
  return {blob, requestedOffsets};
}

describe('ApiFileManager download parts', () => {
  it('assembles a 20 MiB download whose last three parts answer last into exactly the source bytes', async() => {
    const source = makeSource(20 * MIB);
    const {blob} = await runDownload({source, size: source.byteLength, heldOffsets: lastThreeOffsets(source.byteLength)});
    const bytes = await readBlobAsUint8Array(blob);

    expect(bytes.byteLength).toBe(source.byteLength);
    expect(bytes.every((byte: number, index: number): boolean => byte === source[index])).toBe(true);
  });

  it('requests a 20 MiB download as exactly 40 parts at offsets below its size', async() => {
    const source = makeSource(20 * MIB);
    const {requestedOffsets} = await runDownload({source, size: source.byteLength, heldOffsets: lastThreeOffsets(source.byteLength)});
    const expectedOffsets = Array.from({length: 40}, (_: unknown, index: number): number => index * PART_SIZE);

    expect([...requestedOffsets].sort((a: number, b: number): number => a - b)).toEqual(expectedOffsets);
    expect(requestedOffsets.filter((offset: number): boolean => offset >= source.byteLength)).toEqual([]);
  });

  it('keeps a size-0 download answered by one 300 KiB part to a single request of those 300 KiB', async() => {
    const source = makeSource(300 * KIB);
    const {blob, requestedOffsets} = await runDownload({source, heldOffsets: new Set()});
    const bytes = await readBlobAsUint8Array(blob);

    expect(requestedOffsets).toEqual([0]);
    expect(bytes.byteLength).toBe(source.byteLength);
    expect(bytes.every((byte: number, index: number): boolean => byte === source[index])).toBe(true);
  });
});
