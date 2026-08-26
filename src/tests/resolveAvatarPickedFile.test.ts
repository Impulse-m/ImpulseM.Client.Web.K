vi.mock('@helpers/gifToVideo', () => ({
  default: vi.fn(),
  canConvertGifToVideo: vi.fn(),
  canConvertGifToVideoSync: vi.fn()
}));

import resolveAvatarPickedFile from '@helpers/resolveAvatarPickedFile';
import gifToVideo, {canConvertGifToVideo} from '@helpers/gifToVideo';

function gifFile(name = 'party.gif') {
  return new File([new Uint8Array([0x47, 0x49, 0x46])], name, {type: 'image/gif'});
}

describe('resolveAvatarPickedFile — a gif picked as an avatar routes to the video (mp4) arm', () => {
  beforeEach(() => {
    vi.mocked(gifToVideo).mockReset();
    vi.mocked(canConvertGifToVideo).mockReset();
  });

  it('converts a picked gif to an mp4 File via gifToVideo, flipping the downstream video-branch decision', async() => {
    const source = gifFile();
    const mp4Blob = new Blob([new Uint8Array([1, 2, 3])], {type: 'video/mp4'});
    vi.mocked(canConvertGifToVideo).mockResolvedValue(true);
    vi.mocked(gifToVideo).mockResolvedValue({blob: mp4Blob, width: 100, height: 100, duration: 1});

    const result = await resolveAvatarPickedFile(source, true);

    // The SAME converter used for outgoing message gifs must be reused — no
    // second converter — called with exactly the picked gif.
    expect(gifToVideo).toHaveBeenCalledWith(source);
    expect(result.type).toBe('video/mp4');
    expect(result.name).toBe('party.mp4');

    // This is the observable routing decision getFileAndOpenEditor makes off
    // the resolved file (`const isVideo = avatarFile.type.startsWith('video/')`):
    // a gif must now take the video arm, not the image arm.
    expect(result.type.startsWith('video/')).toBe(true);
  });

  it('falls back to the static image (first-frame) path when the browser cannot convert gif to video', async() => {
    const source = gifFile();
    vi.mocked(canConvertGifToVideo).mockResolvedValue(false);

    const result = await resolveAvatarPickedFile(source, true);

    expect(gifToVideo).not.toHaveBeenCalled();
    expect(result).toBe(source);
    expect(result.type.startsWith('video/')).toBe(false);
  });

  it('leaves non-avatar callers of the shared picker untouched, even for a picked gif', async() => {
    const source = gifFile();
    vi.mocked(canConvertGifToVideo).mockResolvedValue(true);

    const result = await resolveAvatarPickedFile(source, false);

    expect(gifToVideo).not.toHaveBeenCalled();
    expect(result).toBe(source);
  });

  it('leaves a non-gif avatar file (e.g. a picked photo) untouched', async() => {
    const source = new File([new Uint8Array([1])], 'photo.png', {type: 'image/png'});
    vi.mocked(canConvertGifToVideo).mockResolvedValue(true);

    const result = await resolveAvatarPickedFile(source, true);

    expect(gifToVideo).not.toHaveBeenCalled();
    expect(result).toBe(source);
  });
});
