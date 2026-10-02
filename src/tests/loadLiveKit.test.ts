import {describe, expect, it, vi} from 'vitest';

vi.mock('livekit-client', () => ({marker: 'livekit'}));

describe('loadLiveKit', () => {
  it('imports the SDK once and returns the cached promise afterwards', async() => {
    const {loadLiveKit} = await import('@lib/calls/livekit/loadLiveKit');
    const first: Promise<unknown> = loadLiveKit();
    const second: Promise<unknown> = loadLiveKit();
    expect(second).toBe(first);
    expect(((await first) as {marker: string}).marker).toBe('livekit');
  });
});
