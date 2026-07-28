import { DOCUMENT, Injectable, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { DEFAULT_CAPTURE, type CaptureSettings } from '@shader-studio/shared/model';
import { normalizeCapture } from '@shader-studio/shared/capture-plan';
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_WINDOW,
  sanitizeAppearance,
  sanitizeWindowState,
  type EditorAppearance,
  type EditorWindowState,
} from '@shader-studio/shared/editor-prefs';
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_BOTTOM_PANEL_OPEN,
  DEFAULT_BOTTOM_PANEL_TAB,
  DEFAULT_FILE_EXPLORER_OPEN,
  DEFAULT_FILE_EXPLORER_VIEW,
  DEFAULT_FILE_EXPLORER_WIDTH,
  DEFAULT_PANEL_WIDTHS,
  PANEL_LIMITS,
  clampBottomPanelHeight,
  clampFileExplorerWidth,
  clampPanelWidth,
  sanitizeBottomPanelTab,
  sanitizeFileExplorerView,
  sanitizeInspectorTab,
  type BottomPanelTab,
  type FileExplorerView,
  type InspectorTab,
} from '@shader-studio/shared/panel-prefs';
import {
  DEFAULT_PREVIEW_WINDOW,
  sanitizePreviewWindow,
  type PreviewWindowState,
} from '@shader-studio/shared/preview-prefs';
import {
  DEFAULT_EDITOR_GROUP_ID,
  editorSurfaceId,
  migrateLayoutFromPreferences,
  type LayoutPreferences,
} from '@shader-studio/shared/surfaces';
import type { AppLocale } from '../i18n/i18n';

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

export const COLOR_SCHEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'system', label: 'System', icon: 'contrast' },
] as const;

export type ColorScheme = (typeof COLOR_SCHEME_OPTIONS)[number]['value'];
export type ResolvedColorScheme = Exclude<ColorScheme, 'system'>;

export function colorSchemeIcon(scheme: ColorScheme): string {
  return COLOR_SCHEME_OPTIONS.find((option) => option.value === scheme)?.icon ?? 'dark_mode';
}

export interface WorkspacePreferences {
  language: AppLocale;
  lastShaderId: string | null;
  /** Remembered so importing from Shadertoy doesn't ask for it every time. */
  shadertoyApiKey: string | null;
  browserOpen: boolean;
  editorOpen: boolean;
  /** Whether the inspector rail is showing. Toggled by the H shortcut. */
  guiVisible: boolean;
  /** Width of the shader browser, in pixels. */
  browserWidth: number;
  /** Width of the inspector rail, in pixels. */
  inspectorWidth: number;
  /** Which inspector tab was last open. */
  inspectorTab: InspectorTab;
  /** Whether the bottom panel (Problems / Output) is showing. */
  bottomPanelOpen: boolean;
  /** Height of the bottom panel, in pixels. */
  bottomPanelHeight: number;
  /** Which bottom panel tab was last open. */
  bottomPanelTab: BottomPanelTab;
  /** Whether the editor-local file explorer column is showing. */
  fileExplorerOpen: boolean;
  /** Files or Pipeline view in the editor-local explorer. */
  fileExplorerView: FileExplorerView;
  /** Width of the editor-local explorer, in pixels. */
  fileExplorerWidth: number;
  resolutionScale: number;
  paused: boolean;
  autoRipples: boolean;
  colorScheme: ColorScheme;
  /** How the editor is dressed: font, size, theme, and the rest. */
  editorAppearance: EditorAppearance;
  /** Where the editor sits: docked, floating, maximized or collapsed. */
  editorWindow: EditorWindowState;
  /** Where the preview sits: the stage, or a window over it. @deprecated use surfacesLayout */
  previewWindow: PreviewWindowState;
  /** Versioned contained/native surface layout (Agent 06). */
  surfacesLayout: LayoutPreferences;
  /**
   * What the last export was set to. A capture is a form with eight fields, and
   * nobody fills it in twice — an export is almost always a re-export at a
   * slightly different length.
   */
  capture: CaptureSettings;
}

const DEFAULTS: WorkspacePreferences = {
  language: 'en',
  lastShaderId: null,
  shadertoyApiKey: null,
  browserOpen: true,
  editorOpen: false,
  guiVisible: true,
  browserWidth: DEFAULT_PANEL_WIDTHS.browser,
  inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
  inspectorTab: 'controls',
  bottomPanelOpen: DEFAULT_BOTTOM_PANEL_OPEN,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  bottomPanelTab: DEFAULT_BOTTOM_PANEL_TAB,
  fileExplorerOpen: DEFAULT_FILE_EXPLORER_OPEN,
  fileExplorerView: DEFAULT_FILE_EXPLORER_VIEW,
  fileExplorerWidth: DEFAULT_FILE_EXPLORER_WIDTH,
  resolutionScale: 1,
  paused: false,
  autoRipples: false,
  colorScheme: 'dark',
  editorAppearance: DEFAULT_EDITOR_APPEARANCE,
  editorWindow: DEFAULT_EDITOR_WINDOW,
  previewWindow: DEFAULT_PREVIEW_WINDOW,
  surfacesLayout: migrateLayoutFromPreferences({
    editorOpen: false,
    editorWindow: DEFAULT_EDITOR_WINDOW,
    previewWindow: DEFAULT_PREVIEW_WINDOW,
    browserOpen: true,
    guiVisible: true,
    browserWidth: DEFAULT_PANEL_WIDTHS.browser,
    inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
    bottomPanelOpen: DEFAULT_BOTTOM_PANEL_OPEN,
    bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  }),
  capture: DEFAULT_CAPTURE,
};

function sanitizeColorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEME_OPTIONS.some((option) => option.value === value)
    ? (value as ColorScheme)
    : DEFAULTS.colorScheme;
}

export function createDefaultWorkspacePreferences(): WorkspacePreferences {
  return { ...DEFAULTS };
}

function sanitizeLanguage(value: unknown): AppLocale {
  return value === 'fr' ? 'fr' : 'en';
}

@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly state = signal<WorkspacePreferences>(DEFAULTS);
  private readonly systemDark = signal(true);

  readonly value = this.state.asReadonly();

  /**
   * The light/dark scheme actually painted. When the preference is `system`,
   * this tracks the OS; otherwise it is the preference itself.
   */
  readonly resolved = computed<ResolvedColorScheme>(() => {
    const scheme = this.state().colorScheme;
    if (scheme !== 'system') return scheme;
    return this.systemDark() ? 'dark' : 'light';
  });

  constructor() {
    if (this.isBrowser) {
      this.state.set(this.load());

      const query = this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)');
      if (query) {
        this.systemDark.set(query.matches);
        query.addEventListener('change', (event) => this.systemDark.set(event.matches));
      }

      effect(() => this.persist(this.state()));

      // Every Material colour token is a `light-dark()` pair, so the whole
      // palette follows the root `color-scheme` — nothing else has to change.
      effect(() => {
        this.document.documentElement.style.colorScheme = this.resolved();
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
      const editorWindow = sanitizeWindowState(parsed.editorWindow);
      const previewWindow = sanitizePreviewWindow(parsed.previewWindow);
      const browserOpen = parsed.browserOpen ?? DEFAULTS.browserOpen;
      const editorOpenLegacy = parsed.editorOpen ?? DEFAULTS.editorOpen;
      const guiVisible = parsed.guiVisible ?? DEFAULTS.guiVisible;
      const browserWidth = clampPanelWidth(
        parsed.browserWidth,
        PANEL_LIMITS.browserWidth,
        DEFAULTS.browserWidth,
      );
      const inspectorWidth = clampPanelWidth(
        parsed.inspectorWidth,
        PANEL_LIMITS.inspectorWidth,
        DEFAULTS.inspectorWidth,
      );
      const bottomPanelOpen =
        typeof parsed.bottomPanelOpen === 'boolean'
          ? parsed.bottomPanelOpen
          : DEFAULTS.bottomPanelOpen;
      const bottomPanelHeight = clampBottomPanelHeight(
        parsed.bottomPanelHeight,
        DEFAULTS.bottomPanelHeight,
      );

      const surfacesLayout = migrateLayoutFromPreferences({
        ...parsed,
        editorOpen: editorOpenLegacy,
        editorWindow,
        previewWindow,
        browserOpen,
        guiVisible,
        browserWidth,
        inspectorWidth,
        bottomPanelOpen,
        bottomPanelHeight,
        bottomPanelTab: parsed.bottomPanelTab,
        inspectorTab: parsed.inspectorTab,
      });

      const editorSurface = surfacesLayout.surfaces.find(
        (surface) => surface.id === editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
      );
      const editorOpen = editorSurface?.open ?? editorOpenLegacy;

      return {
        language: sanitizeLanguage(parsed.language),
        lastShaderId:
          typeof parsed.lastShaderId === 'string' ? parsed.lastShaderId : DEFAULTS.lastShaderId,
        shadertoyApiKey:
          typeof parsed.shadertoyApiKey === 'string'
            ? parsed.shadertoyApiKey
            : DEFAULTS.shadertoyApiKey,
        browserOpen,
        editorOpen,
        guiVisible,
        browserWidth,
        inspectorWidth,
        inspectorTab: sanitizeInspectorTab(parsed.inspectorTab),
        bottomPanelOpen,
        bottomPanelHeight,
        bottomPanelTab: sanitizeBottomPanelTab(parsed.bottomPanelTab),
        fileExplorerOpen:
          typeof parsed.fileExplorerOpen === 'boolean'
            ? parsed.fileExplorerOpen
            : DEFAULTS.fileExplorerOpen,
        fileExplorerView: sanitizeFileExplorerView(parsed.fileExplorerView),
        fileExplorerWidth: clampFileExplorerWidth(
          parsed.fileExplorerWidth,
          DEFAULTS.fileExplorerWidth,
        ),
        resolutionScale:
          typeof parsed.resolutionScale === 'number' &&
          parsed.resolutionScale >= 0.25 &&
          parsed.resolutionScale <= 2
            ? parsed.resolutionScale
            : DEFAULTS.resolutionScale,
        paused: parsed.paused ?? DEFAULTS.paused,
        autoRipples: parsed.autoRipples ?? DEFAULTS.autoRipples,
        colorScheme: sanitizeColorScheme(parsed.colorScheme),
        editorAppearance: sanitizeAppearance(parsed.editorAppearance),
        editorWindow,
        previewWindow,
        surfacesLayout,
        capture: normalizeCapture(parsed.capture),
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
