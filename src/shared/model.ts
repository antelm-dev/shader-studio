/**
 * The shader document model.
 *
 * Everything in this file is plain data, shared verbatim between the Express
 * API and the Angular client. It must stay free of Node and DOM imports so
 * that both bundles can pull it in.
 */

/** Format tag written into every exported bundle. Bump on a breaking change. */
export const BUNDLE_FORMAT = 'shader-studio/v1';

/** Ripple slots the engine reserves in `u_clickData`. Mirrors `__MAX_WAVES__`. */
export const MAX_WAVES = 24;

/**
 * A shader parameter's uniform is always its control key prefixed with `u_`:
 * a control keyed `warpIntensity` feeds `uniform float u_warpIntensity`.
 */
export const UNIFORM_PREFIX = 'u_';

export type ControlType = 'number' | 'boolean' | 'color' | 'select';

interface ControlBase {
  /** Identifier of the parameter; the uniform is `u_<key>`. */
  key: string;
  /** Human label shown in the GUI. Defaults to a prettified `key`. */
  label?: string;
  /** Optional lil-gui folder to group the control under. */
  folder?: string;
}

/** `uniform float u_<key>` driven by a slider. */
export interface NumberControl extends ControlBase {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
}

/** `uniform bool u_<key>` driven by a checkbox. */
export interface BooleanControl extends ControlBase {
  type: 'boolean';
  default: boolean;
}

/** `uniform vec3 u_<key>` driven by a color picker. Value is `#rrggbb`. */
export interface ColorControl extends ControlBase {
  type: 'color';
  default: string;
}

/** `uniform float u_<key>` driven by a dropdown of named numeric values. */
export interface SelectControl extends ControlBase {
  type: 'select';
  default: number;
  /** Label -> value. The uniform receives the value. */
  options: Record<string, number>;
}

export type ShaderControl = NumberControl | BooleanControl | ColorControl | SelectControl;

/** A parameter value, matching the control type that declared it. */
export type ParamValue = number | boolean | string;

/** Every parameter of a shader, keyed by control key (not uniform name). */
export type ShaderParams = Record<string, ParamValue>;

/** Post-processing, stored with the shader rather than with its presets. */
export interface BloomSettings {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}

export interface RenderSettings {
  bloom: BloomSettings;
}

export const DEFAULT_BLOOM: BloomSettings = {
  enabled: false,
  strength: 0.3,
  radius: 0.5,
  threshold: 0.85,
};

export const DEFAULT_RENDER: RenderSettings = { bloom: { ...DEFAULT_BLOOM } };

/** A named capture of a shader's parameter values. */
export interface Preset {
  id: string;
  name: string;
  createdAt: string;
  values: ShaderParams;
}

/** `meta.json` on disk. */
export interface ShaderMeta {
  id: string;
  name: string;
  description: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  controls: ShaderControl[];
  render: RenderSettings;
}

/** A complete shader as served by `GET /api/shaders/:id`. */
export interface ShaderRecord extends ShaderMeta {
  fragment: string;
  vertex: string;
  presets: Preset[];
}

/** The lightweight shape listed by `GET /api/shaders`. */
export interface ShaderSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  controlCount: number;
  presetCount: number;
}

/** The unit of import/export: one shader, its config and its presets. */
export interface ShaderPayload {
  id: string;
  name: string;
  description: string;
  author?: string;
  controls: ShaderControl[];
  render: RenderSettings;
  fragment: string;
  vertex: string;
  presets: Preset[];
}

export interface ShaderBundle {
  format: typeof BUNDLE_FORMAT;
  kind: 'shader';
  exportedAt: string;
  shader: ShaderPayload;
}

export interface CollectionBundle {
  format: typeof BUNDLE_FORMAT;
  kind: 'collection';
  exportedAt: string;
  shaders: ShaderPayload[];
}

export type Bundle = ShaderBundle | CollectionBundle;

/** What happens when an imported shader's id already exists. */
export type ImportMode = 'rename' | 'overwrite';

export interface ImportResult {
  imported: { id: string; name: string; replaced: boolean }[];
}

/** Shape of every non-2xx response body from the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

export function toSummary(record: ShaderRecord): ShaderSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    updatedAt: record.updatedAt,
    controlCount: record.controls.length,
    presetCount: record.presets.length,
  };
}

export function toPayload(record: ShaderRecord): ShaderPayload {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    ...(record.author ? { author: record.author } : {}),
    controls: record.controls,
    render: record.render,
    fragment: record.fragment,
    vertex: record.vertex,
    presets: record.presets,
  };
}
