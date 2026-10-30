import getWebViewTgLink from '@helpers/getWebViewTgLink';

describe('getWebViewTgLink', () => {
  beforeEach(() => {
    vi.stubEnv('IMPULSEM_LINK_HOST', 'o.example.org');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('builds a link on the configured link host from the path the frame sent', () => {
    expect(getWebViewTgLink('/durov')).toBe('https://o.example.org/durov');
    expect(getWebViewTgLink('/durov/123?comment=1')).toBe('https://o.example.org/durov/123?comment=1');
  });

  // `path_full` is frame-authored: concatenated onto the bare host, a leading dot walks out of the
  // registrable domain ('https://o.example.org' + '.evil.com/x')
  test('keeps a path that does not start with a slash inside the link host', () => {
    expect(new URL(getWebViewTgLink('.evil.com/x')).host).toBe('o.example.org');
    expect(new URL(getWebViewTgLink('@evil.com/x')).host).toBe('o.example.org');
    expect(new URL(getWebViewTgLink('//evil.com/x')).host).toBe('o.example.org');
  });

  test('survives an empty path', () => {
    expect(getWebViewTgLink('')).toBe('https://o.example.org/');
    expect(getWebViewTgLink(undefined)).toBe('https://o.example.org/');
  });

  test('builds no link when no link host is configured', () => {
    vi.stubEnv('IMPULSEM_LINK_HOST', '');
    expect(getWebViewTgLink('/durov')).toBeUndefined();
  });
});
