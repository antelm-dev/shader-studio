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

/** Post-processing. Belongs to the shader; a preset may also capture a copy. */
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

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** What a capture is written out as. */
export type CaptureFormat = 'webm' | 'png';

/**
 * How a shader is filmed.
 *
 * Every field is a *request*: the numbers a user typed, not the numbers the
 * capture will run at. `planCapture` is what turns one of these into a frame
 * timetable, and it clamps and rounds along the way — an odd width is not a
 * width a video encoder will accept, and 0.7 of a frame is not a frame.
 */
export interface CaptureSettings {
  format: CaptureFormat;
  width: number;
  height: number;
  fps: number;
  /** Seconds of footage in one pass of the loop. */
  duration: number;
  /**
   * How many times the loop is written out. The frames are rendered *once* and
   * repeated — a loop is the same period played again, not more shader time.
   */
  loops: number;
  /** The `iTime` the first frame is taken at: how far in the shader has settled. */
  startTime: number;
  /** Instants averaged into each frame. 1 is no motion blur. */
  subframes: number;
  /** Fraction of the frame interval the shutter stays open. Ignored when `subframes` is 1. */
  shutter: number;
  /** Render scale. Frames are drawn this much larger, then downsampled — supersampled AA. */
  supersample: number;
}

export const DEFAULT_CAPTURE: CaptureSettings = {
  format: 'webm',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 8,
  loops: 1,
  startTime: 0,
  subframes: 1,
  shutter: 0.5,
  supersample: 1,
};

// ---------------------------------------------------------------------------
// Texture channels (iChannel0…3)
// ---------------------------------------------------------------------------

export type TextureWrapMode = 'repeat' | 'clamp' | 'mirror';
export type TextureFilterMode = 'linear' | 'nearest';

/**
 * One `iChannel` slot. `ext === null` means nothing is assigned, in which
 * case `width`/`height` are meaningless and the engine binds a 1×1
 * transparent placeholder instead.
 */
export interface TextureChannel {
  ext: string | null;
  width: number;
  height: number;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

/** Always exactly four slots: iChannel0 through iChannel3. */
export type TextureChannels = readonly [
  TextureChannel,
  TextureChannel,
  TextureChannel,
  TextureChannel,
];

export const DEFAULT_TEXTURE_CHANNEL: TextureChannel = {
  ext: null,
  width: 0,
  height: 0,
  wrap: 'clamp',
  filter: 'linear',
  flipY: true,
};

export const DEFAULT_CHANNELS: TextureChannels = [
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
];

/** Settings-only patch: never carries `ext`/`width`/`height`. */
export type TextureChannelSettingsPatch = Partial<
  Pick<TextureChannel, 'wrap' | 'filter' | 'flipY'>
>;

/** A texture channel as it travels inside an import/export bundle: the image bytes, base64-encoded. */
export interface TextureChannelPayload extends TextureChannel {
  /** Base64 body of the image file. Present iff `ext !== null`. */
  data: string | null;
}

export type TextureChannelPayloads = readonly [
  TextureChannelPayload,
  TextureChannelPayload,
  TextureChannelPayload,
  TextureChannelPayload,
];

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** The size the client encodes a preview to. 16:9, like the render surface. */
export const THUMBNAIL_WIDTH = 480;
export const THUMBNAIL_HEIGHT = 270;

/**
 * A shader's preview image, captured from the renderer when the shader is
 * saved. `ext` is whatever the browser managed to encode (`webp`, falling back
 * to `png`), and `updatedAt` doubles as the cache-buster on the image URL.
 */
export interface ThumbnailMeta {
  ext: string;
  updatedAt: string;
}

/** A thumbnail as it travels inside an import/export bundle: the image bytes, base64-encoded. */
export interface ThumbnailPayload extends ThumbnailMeta {
  data: string;
}

/** A named capture of a shader's parameter values. */
export interface Preset {
  id: string;
  name: string;
  createdAt: string;
  values: ShaderParams;
  /**
   * The render settings captured alongside the values. Optional, and absent on
   * every preset saved before this existed: bloom stays the shader's, and
   * applying such a preset leaves it exactly as it was.
   */
  render?: RenderSettings;
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
  /** Metadata only — no pixel bytes. The files live under `textures/`. */
  channels: TextureChannels;
  /** Metadata only — the image lives next to `meta.json`. `null` until the shader is first saved. */
  thumbnail: ThumbnailMeta | null;
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
  /** Enough to build the preview's URL, without ever putting pixels in the listing. */
  thumbnail: ThumbnailMeta | null;
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
  /** Texture images inlined as base64 — this is what makes a bundle portable. */
  channels: TextureChannelPayloads;
  /** The preview, inlined as base64. `null` on a shader that has never been saved with one. */
  thumbnail: ThumbnailPayload | null;
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
    thumbnail: record.thumbnail,
  };
}

/**
 * Metadata-only conversion — `channels[n].data` and `thumbnail` are always
 * `null` here since this function never touches the filesystem. Callers that
 * need the actual image bytes (export, or a same-process copy) fill them in
 * afterwards.
 */
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
    channels: record.channels.map((channel) => ({
      ...channel,
      data: null,
    })) as unknown as TextureChannelPayloads,
    thumbnail: null,
  };
}
