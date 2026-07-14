import type { ShaderControl, ShaderParams } from './controls';
import type { RenderSettings } from './render';
import type {
  TextureChannelPayloads,
  TextureChannels,
  ThumbnailMeta,
  ThumbnailPayload,
} from './textures';
import type { ShaderProject } from '../project/types';

/** Format tag written into every exported bundle. Bump on a breaking change. */
export const BUNDLE_FORMAT = 'shader-studio/v2';

/**
 * The previous bundle format, from before a shader's project (its buffers,
 * Common pass, files and channel wiring) was part of the payload. Still
 * accepted on import — `validateShaderPayload` synthesizes a `project` for one
 * via `migrateLegacyProject`, the same way a pre-project shader on disk does.
 */
export const LEGACY_BUNDLE_FORMAT = 'shader-studio/v1';

export interface Preset {
  id: string;
  name: string;
  createdAt: string;
  values: ShaderParams;
  render?: RenderSettings;
}

export interface ShaderMeta {
  id: string;
  name: string;
  description: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  controls: ShaderControl[];
  render: RenderSettings;
  channels: TextureChannels;
  thumbnail: ThumbnailMeta | null;
}

export interface ShaderRecord extends ShaderMeta {
  fragment: string;
  vertex: string;
  presets: Preset[];
  /**
   * The multi-pass document this shader is: buffers, Common, plain files and
   * channel wiring. `fragment`/`vertex` above stay in sync with it — they are
   * the Image pass's source and the project's vertex shader, mirrored for
   * anything that still reads the old two-string shape.
   */
  project: ShaderProject;
}

export interface ShaderSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  controlCount: number;
  presetCount: number;
  thumbnail: ThumbnailMeta | null;
}

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
  channels: TextureChannelPayloads;
  thumbnail: ThumbnailPayload | null;
  /** Same role as `ShaderRecord.project` — what makes a bundle lossless. */
  project: ShaderProject;
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

export type ImportMode = 'rename' | 'overwrite';

export interface ImportResult {
  imported: { id: string; name: string; replaced: boolean }[];
}

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
    project: record.project,
  };
}
