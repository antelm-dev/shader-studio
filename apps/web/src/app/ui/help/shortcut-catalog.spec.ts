import { describe, expect, it } from 'vitest';

import {
  SHORTCUT_CATALOG,
  SHORTCUT_ENTRY_IDS,
  listShortcutEntries,
  type ShortcutSectionId,
} from './shortcut-catalog';

/** Display order: General → Editor → Preview → Navigation. */
const EXPECTED_DISPLAY_ORDER = [
  'save-shader',
  'full-screen',
  'new-source-file',
  'compile-now',
  'close-active-document',
  'toggle-bottom-panel',
  'format-glsl',
  'pause-resume',
  'toggle-controls',
  'capture-png',
  'previous-tab',
  'next-tab',
  'activate-tab',
] as const;

const EXPECTED_SECTION_ORDER: readonly ShortcutSectionId[] = [
  'general',
  'editor',
  'preview',
  'navigation',
];

describe('SHORTCUT_CATALOG', () => {
  it('keeps the General → Editor → Preview → Navigation section order', () => {
    expect(SHORTCUT_CATALOG.map((section) => section.id)).toEqual([...EXPECTED_SECTION_ORDER]);
  });

  it('lists every GlobalShortcuts shortcut plus Format GLSL exactly once', () => {
    const ids = listShortcutEntries().map((entry) => entry.id);
    expect(ids).toEqual([...EXPECTED_DISPLAY_ORDER]);
    expect(new Set(ids).size).toBe(EXPECTED_DISPLAY_ORDER.length);
  });

  it('exposes a stable id list matching display order', () => {
    expect(SHORTCUT_ENTRY_IDS).toEqual([...EXPECTED_DISPLAY_ORDER]);
  });

  it('uses Windows/Linux Ctrl chords and visible key tokens', () => {
    const byId = Object.fromEntries(listShortcutEntries().map((entry) => [entry.id, entry]));

    expect(byId['save-shader']?.chord.keys).toEqual(['Ctrl', 'S']);
    expect(byId['new-source-file']?.chord.keys).toEqual(['Ctrl', 'N']);
    expect(byId['compile-now']?.chord.keys).toEqual(['Ctrl', 'Enter']);
    expect(byId['close-active-document']?.chord.keys).toEqual(['Ctrl', 'W']);
    expect(byId['toggle-bottom-panel']?.chord.keys).toEqual(['Ctrl', 'J']);
    expect(byId['previous-tab']?.chord.keys).toEqual(['Ctrl', 'PageUp']);
    expect(byId['next-tab']?.chord.keys).toEqual(['Ctrl', 'PageDown']);
    expect(byId['activate-tab']?.chord.keys).toEqual(['Ctrl', '1…9']);
    expect(byId['activate-tab']?.chord.ariaLabel).toBe('Ctrl+1 through Ctrl+9');
    expect(byId['full-screen']?.chord.keys).toEqual(['F11']);
    expect(byId['pause-resume']?.chord.keys).toEqual(['Space']);
    expect(byId['toggle-controls']?.chord.keys).toEqual(['H']);
    expect(byId['capture-png']?.chord.keys).toEqual(['S']);
    expect(byId['format-glsl']?.chord.keys).toEqual(['Shift', 'Alt', 'F']);
  });

  it('marks Format GLSL as Monaco-owned and the rest as app-owned', () => {
    for (const entry of listShortcutEntries()) {
      expect(entry.source).toBe(entry.id === 'format-glsl' ? 'monaco' : 'app');
    }
  });

  it('places preview bare-letter shortcuts under Preview and editor chords under Editor', () => {
    const sectionOf = (id: string): ShortcutSectionId | undefined =>
      SHORTCUT_CATALOG.find((section) => section.entries.some((entry) => entry.id === id))?.id;

    expect(sectionOf('pause-resume')).toBe('preview');
    expect(sectionOf('toggle-controls')).toBe('preview');
    expect(sectionOf('capture-png')).toBe('preview');
    expect(sectionOf('format-glsl')).toBe('editor');
    expect(sectionOf('compile-now')).toBe('editor');
    expect(sectionOf('activate-tab')).toBe('navigation');
    expect(sectionOf('save-shader')).toBe('general');
    expect(sectionOf('full-screen')).toBe('general');
  });
});
