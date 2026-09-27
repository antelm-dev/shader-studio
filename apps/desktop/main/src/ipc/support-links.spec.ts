import { describe, expect, it } from 'vitest';

import { resolveSupportLinkUrl } from './support-links';

describe('resolveSupportLinkUrl', () => {
  it('maps allowlisted destinations to the approved HTTPS URLs', () => {
    expect(resolveSupportLinkUrl('documentation')).toBe(
      'https://github.com/antelm-dev/shadergrove#using-shadergrove',
    );
    expect(resolveSupportLinkUrl('issues')).toBe(
      'https://github.com/antelm-dev/shadergrove/issues/new',
    );
  });

  it('rejects unknown destinations and non-allowlisted strings', () => {
    expect(resolveSupportLinkUrl('')).toBeNull();
    expect(resolveSupportLinkUrl('docs')).toBeNull();
    expect(resolveSupportLinkUrl('https://evil.example')).toBeNull();
    expect(resolveSupportLinkUrl('documentation/../issues')).toBeNull();
    expect(resolveSupportLinkUrl('Documentation')).toBeNull();
  });
});
