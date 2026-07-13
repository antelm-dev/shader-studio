import { describe, expect, it } from 'vitest';

import { catalogToLocalizeTranslations, toLocalizeTarget } from './localize';

describe('localize catalog bridge', () => {
  it('converts {name} placeholders to the $localize {$name} form', () => {
    expect(toLocalizeTarget('Hello {name}')).toBe('Hello {$name}');
    expect(toLocalizeTarget('{count} items')).toBe('{$count} items');
  });

  it('maps a catalog for loadTranslations', () => {
    expect(
      catalogToLocalizeTranslations({
        'notice.shaderNotFound': 'Shader “{name}” was not found',
      }),
    ).toEqual({
      'notice.shaderNotFound': 'Shader “{$name}” was not found',
    });
  });
});
