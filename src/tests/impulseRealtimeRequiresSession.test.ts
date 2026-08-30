import {afterEach, describe, expect, it, vi} from 'vitest';

import {fetchCentrifugoToken} from '@lib/impulse/realtime';
import {setGrpcSessionToken} from '@lib/impulse/grpc/transport';

describe('Impulse realtime authentication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request a Centrifugo token without a gRPC session token', async() => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setGrpcSessionToken(undefined);

    await expect(fetchCentrifugoToken()).rejects.toThrow('Impulse session is not ready');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
