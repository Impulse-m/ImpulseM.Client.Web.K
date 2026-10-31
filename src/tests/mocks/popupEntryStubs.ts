import {vi} from 'vitest';

export type SilentLogger = ((...args: unknown[]) => void) & {
  warn: (...args: unknown[]) => void,
  info: (...args: unknown[]) => void,
  error: (...args: unknown[]) => void,
  trace: (...args: unknown[]) => void,
  debug: (...args: unknown[]) => void,
  assert: (...args: unknown[]) => void,
  group: (...args: unknown[]) => void,
  groupCollapsed: (...args: unknown[]) => void,
  groupEnd: (...args: unknown[]) => void,
  setPrefix: (...args: unknown[]) => void,
  setLevel: (...args: unknown[]) => void,
  bindPrefix: () => SilentLogger
};

class IntersectionObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

function stubPopupBrowserGlobals(): void {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}}));
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, {status: 204}))));
}

stubPopupBrowserGlobals();

export function silentLoggerModule(actual: Record<string, unknown>): Record<string, unknown> {
  const silent = (): void => {};
  const silentLogger: SilentLogger = Object.assign(silent, {
    warn: silent,
    info: silent,
    error: silent,
    trace: silent,
    debug: silent,
    assert: silent,
    group: silent,
    groupCollapsed: silent,
    groupEnd: silent,
    setPrefix: silent,
    setLevel: silent,
    bindPrefix: () => silentLogger
  });

  return {...actual, logger: () => silentLogger};
}
