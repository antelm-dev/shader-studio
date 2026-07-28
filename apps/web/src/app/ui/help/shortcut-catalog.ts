import type { TranslationKey } from '../../i18n/keys';

/**
 * Declarative display catalog for the Keyboard Shortcuts dialog.
 *
 * This is intentionally not wired to keyboard event handling — `GlobalShortcuts`
 * (and Monaco for format) remain the behavioral sources of truth. Task 03 uses
 * this catalog as the review checklist when wiring Help menu actions.
 */
export type ShortcutSectionId = 'general' | 'editor' | 'preview' | 'navigation';

/** Where the chord is actually handled. */
export type ShortcutSource = 'app' | 'monaco';

export interface ShortcutChord {
  /** Visible key tokens rendered as `<kbd>` elements (Windows/Linux Ctrl style). */
  readonly keys: readonly string[];
  /** Accessible name for the whole chord, e.g. "Ctrl+S". */
  readonly ariaLabel: string;
}

export interface ShortcutEntry {
  readonly id: string;
  readonly labelKey: TranslationKey;
  readonly chord: ShortcutChord;
  readonly source: ShortcutSource;
}

export interface ShortcutSection {
  readonly id: ShortcutSectionId;
  readonly titleKey: TranslationKey;
  readonly entries: readonly ShortcutEntry[];
}

const chord = (keys: readonly string[], ariaLabel = keys.join('+')): ShortcutChord => ({
  keys,
  ariaLabel,
});

/**
 * Ordered sections and entries shown in the Help → Keyboard Shortcuts dialog.
 * Keep in sync with `GlobalShortcuts` plus Monaco-owned Format GLSL.
 */
export const SHORTCUT_CATALOG: readonly ShortcutSection[] = [
  {
    id: 'general',
    titleKey: 'help.shortcuts.section.general',
    entries: [
      {
        id: 'save-shader',
        labelKey: 'help.shortcuts.saveShader',
        chord: chord(['Ctrl', 'S']),
        source: 'app',
      },
      {
        id: 'full-screen',
        labelKey: 'help.shortcuts.fullScreen',
        chord: chord(['F11']),
        source: 'app',
      },
    ],
  },
  {
    id: 'editor',
    titleKey: 'help.shortcuts.section.editor',
    entries: [
      {
        id: 'new-source-file',
        labelKey: 'help.shortcuts.newSourceFile',
        chord: chord(['Ctrl', 'N']),
        source: 'app',
      },
      {
        id: 'compile-now',
        labelKey: 'help.shortcuts.compileNow',
        chord: chord(['Ctrl', 'Enter']),
        source: 'app',
      },
      {
        id: 'close-active-document',
        labelKey: 'help.shortcuts.closeActiveDocument',
        chord: chord(['Ctrl', 'W']),
        source: 'app',
      },
      {
        id: 'toggle-bottom-panel',
        labelKey: 'help.shortcuts.toggleBottomPanel',
        chord: chord(['Ctrl', 'J']),
        source: 'app',
      },
      {
        id: 'format-glsl',
        labelKey: 'help.shortcuts.formatGlsl',
        chord: chord(['Shift', 'Alt', 'F']),
        source: 'monaco',
      },
    ],
  },
  {
    id: 'preview',
    titleKey: 'help.shortcuts.section.preview',
    entries: [
      {
        id: 'pause-resume',
        labelKey: 'help.shortcuts.pauseResume',
        chord: chord(['Space']),
        source: 'app',
      },
      {
        id: 'toggle-controls',
        labelKey: 'help.shortcuts.toggleControls',
        chord: chord(['H']),
        source: 'app',
      },
      {
        id: 'capture-png',
        labelKey: 'help.shortcuts.capturePng',
        chord: chord(['S']),
        source: 'app',
      },
    ],
  },
  {
    id: 'navigation',
    titleKey: 'help.shortcuts.section.navigation',
    entries: [
      {
        id: 'previous-tab',
        labelKey: 'help.shortcuts.previousTab',
        chord: chord(['Ctrl', 'PageUp']),
        source: 'app',
      },
      {
        id: 'next-tab',
        labelKey: 'help.shortcuts.nextTab',
        chord: chord(['Ctrl', 'PageDown']),
        source: 'app',
      },
      {
        id: 'activate-tab',
        labelKey: 'help.shortcuts.activateTab',
        chord: chord(['Ctrl', '1…9'], 'Ctrl+1 through Ctrl+9'),
        source: 'app',
      },
    ],
  },
];

/** Flat list of every catalog entry in display order. */
export function listShortcutEntries(): readonly ShortcutEntry[] {
  return SHORTCUT_CATALOG.flatMap((section) => section.entries);
}

/** Stable entry ids in display order — useful for completeness assertions. */
export const SHORTCUT_ENTRY_IDS: readonly string[] = listShortcutEntries().map((entry) => entry.id);
