import { describe, expect, it } from 'vitest';

import { DesktopPlatform } from './desktop-platform';

describe('DesktopPlatform support bridge', () => {
  it('does not touch Electron at module evaluation', async () => {
    await expect(import('./desktop-platform')).resolves.toBeDefined();
  });

  it('toggleDevTools and openSupportLink are harmless without Electron', () => {
    const platform = new DesktopPlatform();

    expect(platform.available).toBe(false);
    expect(() => platform.toggleDevTools()).not.toThrow();
    expect(() => platform.openSupportLink('documentation')).not.toThrow();
    expect(() => platform.openSupportLink('issues')).not.toThrow();
  });
});
