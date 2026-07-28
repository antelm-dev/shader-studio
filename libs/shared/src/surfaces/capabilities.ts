/**
 * Explicit per-kind capability presets. No shared LCM base class — editor and
 * preview share geometry helpers only, never an impossible union of powers.
 *
 * Wave 1 coordinator: inspector / shader-browser / bottom-panel keep float:false
 * for MVP.
 */

import type { DockSide, SurfaceKind } from './types';

export interface SurfaceCapabilities {
  readonly stage: boolean;
  readonly dock: boolean;
  readonly float: boolean;
  readonly maximize: boolean;
  readonly minimize: boolean;
  readonly externalize: boolean;
  readonly return: boolean;
  readonly close: boolean;
  readonly singleton: boolean;
  readonly multiInstance: boolean;
  readonly ownsWritableDocs: boolean;
  readonly hostsGpuPreview: boolean;
  /** Empty when dock is false. */
  readonly allowedDockSides: readonly DockSide[];
}

const NONE: readonly DockSide[] = [];

export const PREVIEW_CAPABILITIES: SurfaceCapabilities = {
  stage: true,
  dock: false,
  float: true,
  maximize: true,
  minimize: true,
  externalize: true,
  return: true,
  close: false,
  singleton: true,
  multiInstance: false,
  ownsWritableDocs: false,
  hostsGpuPreview: true,
  allowedDockSides: NONE,
};

export const EDITOR_CAPABILITIES: SurfaceCapabilities = {
  stage: false,
  dock: true,
  float: true,
  maximize: true,
  minimize: true,
  externalize: true,
  return: true,
  close: true,
  singleton: false,
  multiInstance: true,
  ownsWritableDocs: true,
  hostsGpuPreview: false,
  allowedDockSides: ['bottom', 'left', 'right'],
};

export const INSPECTOR_CAPABILITIES: SurfaceCapabilities = {
  stage: false,
  dock: true,
  float: false,
  maximize: true,
  minimize: true,
  externalize: true,
  return: true,
  close: true,
  singleton: true,
  multiInstance: false,
  ownsWritableDocs: false,
  hostsGpuPreview: false,
  allowedDockSides: ['right'],
};

export const SHADER_BROWSER_CAPABILITIES: SurfaceCapabilities = {
  stage: false,
  dock: true,
  float: false,
  maximize: true,
  minimize: true,
  externalize: true,
  return: true,
  close: true,
  singleton: true,
  multiInstance: false,
  ownsWritableDocs: false,
  hostsGpuPreview: false,
  allowedDockSides: ['left'],
};

export const BOTTOM_PANEL_CAPABILITIES: SurfaceCapabilities = {
  stage: false,
  dock: true,
  float: false,
  maximize: true,
  minimize: true,
  externalize: true,
  return: true,
  close: true,
  singleton: true,
  multiInstance: false,
  ownsWritableDocs: false,
  hostsGpuPreview: false,
  allowedDockSides: ['bottom'],
};

/**
 * Native-only live preview satellite (today's `/output` window). Already native
 * so externalize is n/a; return hands authority back to contained preview.
 */
export const LIVE_PREVIEW_OUTPUT_CAPABILITIES: SurfaceCapabilities = {
  stage: false,
  dock: false,
  float: false,
  maximize: true,
  minimize: true,
  externalize: false,
  return: true,
  close: true,
  singleton: true,
  multiInstance: false,
  ownsWritableDocs: false,
  hostsGpuPreview: true,
  allowedDockSides: NONE,
};

export const CAPABILITY_PRESETS: Readonly<Record<SurfaceKind, SurfaceCapabilities>> = {
  preview: PREVIEW_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  inspector: INSPECTOR_CAPABILITIES,
  'shader-browser': SHADER_BROWSER_CAPABILITIES,
  'bottom-panel': BOTTOM_PANEL_CAPABILITIES,
  'live-preview-output': LIVE_PREVIEW_OUTPUT_CAPABILITIES,
};

export function capabilitiesFor(kind: SurfaceKind): SurfaceCapabilities {
  return CAPABILITY_PRESETS[kind];
}

export function can(kind: SurfaceKind, capability: keyof SurfaceCapabilities): boolean {
  const caps = CAPABILITY_PRESETS[kind];
  const value = caps[capability];
  return typeof value === 'boolean' ? value : value.length > 0;
}

export function allowsDockSide(kind: SurfaceKind, side: DockSide): boolean {
  return CAPABILITY_PRESETS[kind].allowedDockSides.includes(side);
}
