import {
  impulsemLinkHost,
  impulsemShareLink,
  impulsemSiteLink,
  impulsemSiteUrl,
  impulsemWebUrl
} from '@config/impulsemConfig';

describe('impulsemConfig normalisation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    ['o.example.org', 'o.example.org'],
    ['  O.Example.ORG  ', 'o.example.org'],
    ['https://o.example.org', 'o.example.org'],
    ['HTTP://O.Example.org/', 'o.example.org'],
    ['https://o.example.org///', 'o.example.org'],
    ['', ''],
    ['   ', '']
  ])('link host %j becomes %j', (raw: string, expected: string) => {
    vi.stubEnv('IMPULSEM_LINK_HOST', raw);
    expect(impulsemLinkHost()).toBe(expected);
  });

  test.each([
    ['https://example.org/', 'https://example.org'],
    ['  https://example.org//  ', 'https://example.org'],
    ['https://example.org', 'https://example.org'],
    ['', '']
  ])('site url %j becomes %j', (raw: string, expected: string) => {
    vi.stubEnv('IMPULSEM_SITE_URL', raw);
    expect(impulsemSiteUrl()).toBe(expected);
  });

  test('web url drops trailing slashes', () => {
    vi.stubEnv('IMPULSEM_WEB_URL', 'https://web.example.org/k/');
    expect(impulsemWebUrl()).toBe('https://web.example.org/k');
  });

  test('share links sit on the normalised link host', () => {
    vi.stubEnv('IMPULSEM_LINK_HOST', 'HTTPS://O.Example.org/');
    expect(impulsemShareLink('/durov')).toBe('https://o.example.org/durov');
  });

  test('share links are undefined without a link host', () => {
    vi.stubEnv('IMPULSEM_LINK_HOST', '');
    expect(impulsemShareLink('/durov')).toBeUndefined();
  });

  test('site links are SITE_URL + path, undefined without a site', () => {
    vi.stubEnv('IMPULSEM_SITE_URL', 'https://example.org/');
    expect(impulsemSiteLink('/dl')).toBe('https://example.org/dl');

    vi.stubEnv('IMPULSEM_SITE_URL', '');
    expect(impulsemSiteLink('/dl')).toBeUndefined();
  });
});
