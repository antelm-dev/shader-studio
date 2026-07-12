import { DOCUMENT, Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_WINDOW,
  sanitizeAppearance,
  sanitizeWindowState,
  type EditorAppearance,
  type EditorWindowState,
} from './editor-prefs';

/**
 * UI state that should survive a reload: which shader was open, which panels
 * were showing, how hard the GPU was being pushed, and how the source editor is
 * dressed and arranged.
 *
 * Kept deliberately separate from the shader documents themselves — this is
 * about the workspace, not the content, and it never leaves the browser.
 *
 * On the server every value stays at its default, which is also what the very
 * first client render uses, so hydration matches.
 */

const STORAGE_KEY = 'shader-studio.preferences';

export type ColorScheme = 'dark' | 'light';

export interface WorkspacePreferences {
  lastShaderId: string | null;
  browserOpen: boolean;
  editorOpen: boolean;
  guiVisible: boolean;
  resolutionScale: number;
  paused: boolean;
  autoRipples: boolean;
  colorScheme: ColorScheme;
  /** How the editor is dressed: font, size, theme, and the rest. */
  editorAppearance: EditorAppearance;
  /** Where the editor sits: docked, floating, maximized or collapsed. */
  editorWindow: EditorWindowState;
}

const DEFAULTS: WorkspacePreferences = {
  lastShaderId: null,
  browserOpen: true,
  editorOpen: false,
  guiVisible: true,
  resolutionScale: 1,
  paused: false,
  autoRipples: false,
  colorScheme: 'dark',
  editorAppearance: DEFAULT_EDITOR_APPEARANCE,
  editorWindow: DEFAULT_EDITOR_WINDOW,
};

@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly state = signal<WorkspacePreferences>(DEFAULTS);

  readonly value = this.state.asReadonly();

  constructor() {
    if (this.isBrowser) {
      this.state.set(this.load());
      effect(() => this.persist(this.state()));

      // Every Material colour token is a `light-dark()` pair, so the whole
      // palette follows the root `color-scheme` — nothing else has to change.
      effect(() => {
        this.document.documentElement.style.colorScheme = this.state().colorScheme;
      });
    }
  }

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }

  private get storage(): Storage | null {
    try {
      // Private-browsing modes expose `localStorage` but throw on access.
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private load(): WorkspacePreferences {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return DEFAULTS;

      const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
      return {
        lastShaderId:
          typeof parsed.lastShaderId === 'string' ? parsed.lastShaderId : DEFAULTS.lastShaderId,
        browserOpen: parsed.browserOpen ?? DEFAULTS.browserOpen,
        editorOpen: parsed.editorOpen ?? DEFAULTS.editorOpen,
        guiVisible: parsed.guiVisible ?? DEFAULTS.guiVisible,
        resolutionScale:
          typeof parsed.resolutionScale === 'number' &&
          parsed.resolutionScale >= 0.25 &&
          parsed.resolutionScale <= 2
            ? parsed.resolutionScale
            : DEFAULTS.resolutionScale,
        paused: parsed.paused ?? DEFAULTS.paused,
        autoRipples: parsed.autoRipples ?? DEFAULTS.autoRipples,
        colorScheme:
          parsed.colorScheme === 'light' || parsed.colorScheme === 'dark'
            ? parsed.colorScheme
            : DEFAULTS.colorScheme,
        // These two are structures rather than scalars, and everything inside
        // them ends up in a Monaco option or a CSS length. They get sanitized
        // field by field, and a value that cannot be salvaged falls back to its
        // default rather than to whatever was in storage.
        editorAppearance: sanitizeAppearance(parsed.editorAppearance),
        editorWindow: sanitizeWindowState(parsed.editorWindow),
      };
    } catch {
      return DEFAULTS;
    }
  }

  private persist(value: WorkspacePreferences): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // A full or unavailable quota must never break the app.
    }
  }
}
