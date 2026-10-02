import { afterEach, describe, expect, it, vi } from 'vitest';

import { isOutputWindow } from './output-mode';

/**
 * The secondary Electron output window is detected by pathname, not by a
 * dedicated Angular route. Native surface bootstraps must keep an equivalent
 * lightweight entry check.
 */

describe('isOutputWindow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when window is undefined (SSR / module evaluation)', () => {
    vi.stubGlobal('window', undefined);
    expect(isOutputWindow()).toBe(false);
  });

  it('is true for /output and /output/ pathnames', () => {
    vi.stubGlobal('window', { location: { pathname: '/output' } });
    expect(isOutputWindow()).toBe(true);

    vi.stubGlobal('window', { location: { pathname: '/output/' } });
    expect(isOutputWindow()).toBe(true);
  });

  it('is false for the main workspace routes', () => {
    vi.stubGlobal('window', { location: { pathname: '/' } });
    expect(isOutputWindow()).toBe(false);

    vi.stubGlobal('window', { location: { pathname: '/shaders/abc' } });
    expect(isOutputWindow()).toBe(false);

    vi.stubGlobal('window', { location: { pathname: '/output-extra' } });
    expect(isOutputWindow()).toBe(false);
  });
});
