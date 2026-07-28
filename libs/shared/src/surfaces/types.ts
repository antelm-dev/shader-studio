/**
 * Framework-free surface identity and layout model for contained and native
 * windows. No Angular, Electron, DOM, or Monaco — pure serializable types.
 */

import type { Point, Rect } from '../geometry';
import type { BottomPanelTab, InspectorTab } from '../prefs/panel';

/** Stable layout identity. Survives relaunch; never an Electron window id. */
export type SurfaceId = string & { readonly __brand: 'SurfaceId' };

/** Stable editor-group identity (session + layout). Not a BrowserWindow id. */
export type EditorGroupId = string & { readonly __brand: 'EditorGroupId' };

export type SurfaceKind =
  | 'preview'
  | 'editor'
  | 'inspector'
  | 'shader-browser'
  | 'bottom-panel'
  | 'live-preview-output';

export const SURFACE_KINDS: readonly SurfaceKind[] = [
  'preview',
  'editor',
  'inspector',
  'shader-browser',
  'bottom-panel',
  'live-preview-output',
] as const;

/** Dock edges a contained surface may pin to. */
export type DockSide = 'bottom' | 'left' | 'right' | 'top';

export const DOCK_SIDES: readonly DockSide[] = ['bottom', 'left', 'right', 'top'];

/**
 * Durable contained modes only. Maximize/minimize are transient and must never
 * appear as a restore target.
 */
export type RestorePoint =
  | { mode: 'stage' }
  | { mode: 'docked'; side: DockSide; size: number }
  | { mode: 'floating'; rect: Rect };

export type ContainedPlacement =
  | { host: 'contained'; mode: 'stage' }
  | { host: 'contained'; mode: 'docked'; side: DockSide; size: number }
  | { host: 'contained'; mode: 'floating'; rect: Rect }
  | { host: 'contained'; mode: 'maximized'; restore: RestorePoint }
  | { host: 'contained'; mode: 'minimized'; restore: RestorePoint; point?: Point };

/**
 * Native (Electron BrowserWindow) placement. OS maximize/fullscreen are
 * orthogonal chrome flags; durable identity remains SurfaceId.
 */
export type NativePlacement = {
  host: 'native';
  bounds: Rect;
  displayId?: string;
  maximized?: boolean;
  fullscreen?: boolean;
};

export type SurfacePlacement = ContainedPlacement | NativePlacement;

/** Kind-specific chrome that travels with the layout record. */
export type SurfaceChrome =
  | { kind: 'preview' }
  | { kind: 'editor'; editorGroupId: EditorGroupId }
  | { kind: 'inspector'; tab: InspectorTab }
  | { kind: 'shader-browser' }
  | { kind: 'bottom-panel'; tab: BottomPanelTab }
  | { kind: 'live-preview-output' };

/**
 * One surface instance in the workspace layout.
 *
 * `open` hides UI without discarding drafts. `returnPoint` is the contained
 * durable placement used when returning from native (or when live-preview-output
 * hands authority back to the contained preview).
 */
export interface SurfaceRecord {
  id: SurfaceId;
  kind: SurfaceKind;
  open: boolean;
  placement: SurfacePlacement;
  chrome: SurfaceChrome;
  /**
   * Contained restore target after externalize / live-output return.
   * Only durable modes.
   */
  returnPoint?: RestorePoint;
}

/** Versioned layout preferences persisted beside legacy preference keys. */
export const LAYOUT_VERSION = 1 as const;

export interface LayoutPreferences {
  version: typeof LAYOUT_VERSION;
  surfaces: SurfaceRecord[];
  /** Contained activation order; last entry is foreground. */
  zOrder: SurfaceId[];
}

/** Well-known singleton surface ids (deterministic migration targets). */
export const WELL_KNOWN_SURFACE_IDS = {
  preview: 'surface:preview' as SurfaceId,
  inspector: 'surface:inspector' as SurfaceId,
  shaderBrowser: 'surface:shader-browser' as SurfaceId,
  bottomPanel: 'surface:bottom-panel' as SurfaceId,
  livePreviewOutput: 'surface:live-preview-output' as SurfaceId,
} as const;

export const DEFAULT_EDITOR_GROUP_ID = 'editor-group:default' as EditorGroupId;

export function asSurfaceId(value: string): SurfaceId {
  return value as SurfaceId;
}

export function asEditorGroupId(value: string): EditorGroupId {
  return value as EditorGroupId;
}

export function editorSurfaceId(groupId: EditorGroupId): SurfaceId {
  return `surface:editor:${groupId}` as SurfaceId;
}

export function isSurfaceKind(value: unknown): value is SurfaceKind {
  return typeof value === 'string' && (SURFACE_KINDS as readonly string[]).includes(value);
}

export function isDockSide(value: unknown): value is DockSide {
  return typeof value === 'string' && (DOCK_SIDES as readonly string[]).includes(value);
}
