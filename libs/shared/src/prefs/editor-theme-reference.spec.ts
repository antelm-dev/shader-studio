import { describe, expect, it } from 'vitest';

import {
  BUILTIN_EDITOR_THEME_IDS,
  DEFAULT_EDITOR_APPEARANCE,
  EDITOR_THEME_IDS,
  isBuiltinEditorThemeId,
  sanitizeAppearance,
  sanitizeEditorThemeId,
} from './editor';

describe('editor theme references', () => {
  it('keeps auto and every built-in id that was ever stored', () => {
    expect(EDITOR_THEME_IDS).toEqual([
      'auto',
      'studio-dark',
      'studio-light',
      'midnight',
      'parchment',
      'contrast-dark',
      'contrast-light',
    ]);
    for (const id of EDITOR_THEME_IDS) expect(sanitizeEditorThemeId(id)).toBe(id);
    expect(BUILTIN_EDITOR_THEME_IDS.every(isBuiltinEditorThemeId)).toBe(true);
    expect(isBuiltinEditorThemeId('auto')).toBe(false);
    expect(isBuiltinEditorThemeId('plugin:pack/dark')).toBe(false);
  });

  it('keeps a well-formed plugin reference without a catalogue to check it against', () => {
    expect(sanitizeEditorThemeId('plugin:dev.example.themes/amber-dark')).toBe(
      'plugin:dev.example.themes/amber-dark',
    );
  });

  it('turns a malformed or overlong reference into auto', () => {
    for (const value of [
      'plugin:pack',
      'plugin:Pack/dark',
      `plugin:${'a'.repeat(65)}/dark`,
      `plugin:pack/${'b'.repeat(49)}`,
      'shader-studio-midnight',
      'solarized',
      '',
      7,
      null,
    ]) {
      expect(sanitizeEditorThemeId(value)).toBe('auto');
    }
  });

  it('sanitizes the theme without touching the other fields', () => {
    const stored = { ...DEFAULT_EDITOR_APPEARANCE, fontSize: 18, minimap: true, theme: 'plugin:' };
    expect(sanitizeAppearance(stored)).toEqual({ ...stored, theme: 'auto' });

    const kept = { ...stored, theme: 'plugin:pack/dark' };
    expect(sanitizeAppearance(kept)).toEqual(kept);

    const legacy = { ...stored, theme: 'parchment' };
    expect(sanitizeAppearance(legacy)).toEqual(legacy);
  });
});
