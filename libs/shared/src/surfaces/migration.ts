/**
 * Deterministic, idempotent migration from legacy Preferences fields into a
 * versioned layout model. Does not delete legacy keys — dual-read until Agent 06.
 */

import { flag, type Size } from '../geometry';
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_BOTTOM_PANEL_OPEN,
  DEFAULT_BOTTOM_PANEL_TAB,
  DEFAULT_PANEL_WIDTHS,
  clampBottomPanelHeight,
  clampPanelWidth,
  PANEL_LIMITS,
  sanitizeBottomPanelTab,
  sanitizeInspectorTab,
} from '../prefs/panel';
import {
  DEFAULT_EDITOR_WINDOW,
  sanitizeWindowState,
  type EditorWindowState,
} from '../prefs/editor';
import {
  DEFAULT_PREVIEW_WINDOW,
  sanitizePreviewWindow,
  type PreviewWindowState,
} from '../prefs/preview';
import { createDefaultSurface, sanitizeLayoutPreferences, sanitizeSurfaceRecord } from './sanitize';
import {
  asSurfaceId,
  DEFAULT_EDITOR_GROUP_ID,
  editorSurfaceId,
  LAYOUT_VERSION,
  WELL_KNOWN_SURFACE_IDS,
  type ContainedPlacement,
  type LayoutPreferences,
  type RestorePoint,
  type SurfacePlacement,
  type SurfaceRecord,
} from './types';

/** Persisted key for the versioned layout document inside preferences JSON. */
export const SURFACES_LAYOUT_KEY = 'surfacesLayout';

export interface LegacyPreferenceFields {
  editorOpen?: unknown;
  editorWindow?: unknown;
  previewWindow?: unknown;
  browserOpen?: unknown;
  browserWidth?: unknown;
  guiVisible?: unknown;
  inspectorWidth?: unknown;
  inspectorTab?: unknown;
  bottomPanelOpen?: unknown;
  bottomPanelHeight?: unknown;
  bottomPanelTab?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function editorPlacementFromLegacy(state: EditorWindowState): SurfacePlacement {
  switch (state.mode) {
    case 'docked':
      return {
        host: 'contained',
        mode: 'docked',
        side: state.dockSide,
        size: state.dockSide === 'bottom' ? state.dockedHeight : state.dockedWidth,
      };
    case 'floating':
      return { host: 'contained', mode: 'floating', rect: { ...state.floating } };
    case 'maximized':
      return {
        host: 'contained',
        mode: 'maximized',
        restore: editorRestoreFromLegacy(state),
      };
    case 'minimized':
      return {
        host: 'contained',
        mode: 'minimized',
        restore: editorRestoreFromLegacy(state),
      };
  }
}

function editorRestoreFromLegacy(state: EditorWindowState): RestorePoint {
  if (state.restoreMode === 'floating') {
    return { mode: 'floating', rect: { ...state.floating } };
  }
  return {
    mode: 'docked',
    side: state.dockSide,
    size: state.dockSide === 'bottom' ? state.dockedHeight : state.dockedWidth,
  };
}

function previewPlacementFromLegacy(state: PreviewWindowState): ContainedPlacement {
  switch (state.mode) {
    case 'stage':
      return { host: 'contained', mode: 'stage' };
    case 'floating':
      return { host: 'contained', mode: 'floating', rect: { ...state.floating } };
    case 'maximized':
      return {
        host: 'contained',
        mode: 'maximized',
        restore: previewRestoreFromLegacy(state),
      };
    case 'minimized':
      return {
        host: 'contained',
        mode: 'minimized',
        restore: previewRestoreFromLegacy(state),
        point: { ...state.minimized },
      };
  }
}

function previewRestoreFromLegacy(state: PreviewWindowState): RestorePoint {
  if (state.restoreMode === 'stage') return { mode: 'stage' };
  return { mode: 'floating', rect: { ...state.floating } };
}

function migrateEditor(raw: LegacyPreferenceFields): SurfaceRecord {
  const window = sanitizeWindowState(raw.editorWindow ?? DEFAULT_EDITOR_WINDOW);
  const open = flag(raw.editorOpen, false);
  return {
    id: editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
    kind: 'editor',
    open,
    placement: editorPlacementFromLegacy(window),
    chrome: { kind: 'editor', editorGroupId: DEFAULT_EDITOR_GROUP_ID },
  };
}

function migratePreview(raw: LegacyPreferenceFields): SurfaceRecord {
  const window = sanitizePreviewWindow(raw.previewWindow ?? DEFAULT_PREVIEW_WINDOW);
  return {
    id: WELL_KNOWN_SURFACE_IDS.preview,
    kind: 'preview',
    open: true,
    placement: previewPlacementFromLegacy(window),
    chrome: { kind: 'preview' },
  };
}

function migrateShaderBrowser(raw: LegacyPreferenceFields): SurfaceRecord {
  const width = clampPanelWidth(
    raw.browserWidth,
    PANEL_LIMITS.browserWidth,
    DEFAULT_PANEL_WIDTHS.browser,
  );
  return {
    id: WELL_KNOWN_SURFACE_IDS.shaderBrowser,
    kind: 'shader-browser',
    open: flag(raw.browserOpen, true),
    placement: { host: 'contained', mode: 'docked', side: 'left', size: width },
    chrome: { kind: 'shader-browser' },
  };
}

function migrateInspector(raw: LegacyPreferenceFields): SurfaceRecord {
  const width = clampPanelWidth(
    raw.inspectorWidth,
    PANEL_LIMITS.inspectorWidth,
    DEFAULT_PANEL_WIDTHS.inspector,
  );
  return {
    id: WELL_KNOWN_SURFACE_IDS.inspector,
    kind: 'inspector',
    open: flag(raw.guiVisible, true),
    placement: { host: 'contained', mode: 'docked', side: 'right', size: width },
    chrome: { kind: 'inspector', tab: sanitizeInspectorTab(raw.inspectorTab) },
  };
}

function migrateBottomPanel(raw: LegacyPreferenceFields): SurfaceRecord {
  const height = clampBottomPanelHeight(raw.bottomPanelHeight, DEFAULT_BOTTOM_PANEL_HEIGHT);
  return {
    id: WELL_KNOWN_SURFACE_IDS.bottomPanel,
    kind: 'bottom-panel',
    open: flag(raw.bottomPanelOpen, DEFAULT_BOTTOM_PANEL_OPEN),
    placement: { host: 'contained', mode: 'docked', side: 'bottom', size: height },
    chrome: {
      kind: 'bottom-panel',
      tab: sanitizeBottomPanelTab(raw.bottomPanelTab ?? DEFAULT_BOTTOM_PANEL_TAB),
    },
  };
}

function buildLayoutFromLegacy(
  raw: LegacyPreferenceFields,
  options: { viewport?: Size; workArea?: Size } = {},
): LayoutPreferences {
  const surfaces = [
    migratePreview(raw),
    migrateEditor(raw),
    migrateShaderBrowser(raw),
    migrateInspector(raw),
    migrateBottomPanel(raw),
  ];

  return sanitizeLayoutPreferences(
    {
      version: LAYOUT_VERSION,
      surfaces,
      zOrder: surfaces.map((s) => s.id),
    },
    options,
  );
}

function isMigratedLayout(value: unknown): boolean {
  const input = asRecord(value);
  return finiteVersion(input['version']) >= 1 && Array.isArray(input['surfaces']);
}

function finiteVersion(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Migrate unknown preferences JSON into a sanitized LayoutPreferences.
 *
 * Idempotent: if `surfacesLayout` is already present and versioned, it is
 * sanitized and returned (legacy fields are ignored for layout geometry).
 */
export function migrateLayoutFromPreferences(
  raw: unknown,
  options: { viewport?: Size; workArea?: Size } = {},
): LayoutPreferences {
  const prefs = asRecord(raw);
  const existing = prefs[SURFACES_LAYOUT_KEY];

  if (isMigratedLayout(existing)) {
    return sanitizeLayoutPreferences(existing, options);
  }

  return buildLayoutFromLegacy(prefs, options);
}

/**
 * Merge a layout document into preferences JSON without removing legacy fields.
 * Unknown future keys on `raw` are preserved.
 */
export function mergeLayoutIntoPreferences(
  raw: unknown,
  layout: LayoutPreferences,
): Record<string, unknown> {
  const prefs = { ...asRecord(raw) };
  prefs[SURFACES_LAYOUT_KEY] = layout;
  return prefs;
}

/**
 * Full migration pass: returns updated preferences (legacy retained) and the
 * layout model. Safe to run repeatedly.
 */
export function migratePreferences(
  raw: unknown,
  options: { viewport?: Size; workArea?: Size } = {},
): { preferences: Record<string, unknown>; layout: LayoutPreferences } {
  const layout = migrateLayoutFromPreferences(raw, options);
  return {
    layout,
    preferences: mergeLayoutIntoPreferences(raw, layout),
  };
}

/** Round-trip: serialize layout → JSON → sanitize. */
export function roundTripLayout(
  layout: LayoutPreferences,
  options: { viewport?: Size; workArea?: Size } = {},
): LayoutPreferences {
  return sanitizeLayoutPreferences(JSON.parse(JSON.stringify(layout)), options);
}

/**
 * Apply live-preview-output return onto the preview singleton record.
 * Thin adapter until Agent 07 unifies externalized preview.
 */
export function applyLiveOutputReturnToPreview(
  layout: LayoutPreferences,
  previewPlacement: ContainedPlacement,
): LayoutPreferences {
  const surfaces = layout.surfaces.map((surface) => {
    if (surface.kind !== 'preview') return surface;
    return {
      ...surface,
      open: true,
      placement: previewPlacement,
    };
  });

  if (!surfaces.some((s) => s.kind === 'preview')) {
    surfaces.unshift({
      ...createDefaultSurface('preview'),
      placement: previewPlacement,
    });
  }

  return sanitizeLayoutPreferences({ ...layout, surfaces });
}

/** Find a surface by id after migration/sanitize. */
export function findSurface(layout: LayoutPreferences, id: string): SurfaceRecord | undefined {
  const target = asSurfaceId(id);
  return layout.surfaces.find((s) => s.id === target);
}

/** Re-sanitize a single unknown surface payload (for session hydration). */
export function hydrateSurfaceRecord(
  value: unknown,
  options: { viewport?: Size; workArea?: Size } = {},
): SurfaceRecord | null {
  return sanitizeSurfaceRecord(value, options);
}
