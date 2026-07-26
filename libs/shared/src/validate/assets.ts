import {
  DEFAULT_TEXTURE_CHANNEL,
  type TextureChannel,
  type TextureChannelPayload,
  type TextureChannelPayloads,
  type TextureChannelSettingsPatch,
  type TextureChannels,
  type TextureFilterMode,
  type TextureWrapMode,
  type ThumbnailMeta,
  type ThumbnailPayload,
} from '../model';
import { LIMITS, TEXTURE_EXTENSIONS } from './limits';
import { isFiniteNumber, isRecord } from './primitives';

const TEXTURE_WRAP_MODES = new Set(['repeat', 'clamp', 'mirror']);
const TEXTURE_FILTER_MODES = new Set(['linear', 'nearest']);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function wrapMode(value: unknown, fallback: TextureWrapMode): TextureWrapMode {
  return typeof value === 'string' && TEXTURE_WRAP_MODES.has(value)
    ? (value as TextureWrapMode)
    : fallback;
}

function filterMode(value: unknown, fallback: TextureFilterMode): TextureFilterMode {
  return typeof value === 'string' && TEXTURE_FILTER_MODES.has(value)
    ? (value as TextureFilterMode)
    : fallback;
}

function positiveInt(value: unknown, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= max ? rounded : fallback;
}

function validateChannel(input: unknown): TextureChannel {
  if (!isRecord(input)) return { ...DEFAULT_TEXTURE_CHANNEL };

  const ext =
    typeof input['ext'] === 'string' && TEXTURE_EXTENSIONS.has(input['ext']) ? input['ext'] : null;
  if (ext === null) {
    return {
      ...DEFAULT_TEXTURE_CHANNEL,
      wrap: wrapMode(input['wrap'], DEFAULT_TEXTURE_CHANNEL.wrap),
      filter: filterMode(input['filter'], DEFAULT_TEXTURE_CHANNEL.filter),
      flipY: typeof input['flipY'] === 'boolean' ? input['flipY'] : DEFAULT_TEXTURE_CHANNEL.flipY,
    };
  }

  return {
    ext,
    width: positiveInt(input['width'], LIMITS.textureDimension, 0),
    height: positiveInt(input['height'], LIMITS.textureDimension, 0),
    wrap: wrapMode(input['wrap'], DEFAULT_TEXTURE_CHANNEL.wrap),
    filter: filterMode(input['filter'], DEFAULT_TEXTURE_CHANNEL.filter),
    flipY: typeof input['flipY'] === 'boolean' ? input['flipY'] : DEFAULT_TEXTURE_CHANNEL.flipY,
  };
}

export function validateChannels(input: unknown): TextureChannels {
  const list = Array.isArray(input) ? input : [];
  return [0, 1, 2, 3].map((index) => validateChannel(list[index])) as unknown as TextureChannels;
}

export function validateChannelSettingsPatch(input: unknown): TextureChannelSettingsPatch[] {
  const list = Array.isArray(input) ? input : [];
  return [0, 1, 2, 3].map((index) => {
    const entry = list[index];
    if (!isRecord(entry)) return {};
    const patch: TextureChannelSettingsPatch = {};
    if (typeof entry['wrap'] === 'string' && TEXTURE_WRAP_MODES.has(entry['wrap'])) {
      patch.wrap = entry['wrap'] as TextureWrapMode;
    }
    if (typeof entry['filter'] === 'string' && TEXTURE_FILTER_MODES.has(entry['filter'])) {
      patch.filter = entry['filter'] as TextureFilterMode;
    }
    if (typeof entry['flipY'] === 'boolean') {
      patch.flipY = entry['flipY'];
    }
    return patch;
  });
}

function validateChannelPayload(input: unknown): TextureChannelPayload {
  const channel = validateChannel(input);
  const data = isRecord(input) ? input['data'] : undefined;

  if (channel.ext === null) return { ...channel, data: null };
  if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) {
    return { ...DEFAULT_TEXTURE_CHANNEL, data: null };
  }
  if (data.length > (LIMITS.textureBytes * 4) / 3 + 1024) {
    return { ...DEFAULT_TEXTURE_CHANNEL, data: null };
  }
  return { ...channel, data };
}

export function validateChannelPayloads(input: unknown): TextureChannelPayloads {
  const list = Array.isArray(input) ? input : [];
  return [0, 1, 2, 3].map((index) =>
    validateChannelPayload(list[index]),
  ) as unknown as TextureChannelPayloads;
}

export function validateThumbnailMeta(input: unknown): ThumbnailMeta | null {
  if (!isRecord(input)) return null;

  const ext = typeof input['ext'] === 'string' ? input['ext'].toLowerCase() : null;
  const updatedAt = input['updatedAt'];
  if (ext === null || !TEXTURE_EXTENSIONS.has(ext)) return null;
  if (typeof updatedAt !== 'string' || updatedAt.length === 0) return null;

  return { ext, updatedAt };
}

export function validateThumbnailPayload(input: unknown): ThumbnailPayload | null {
  const meta = validateThumbnailMeta(input);
  if (!meta || !isRecord(input)) return null;

  const data = input['data'];
  if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) return null;
  if (data.length > (LIMITS.thumbnailBytes * 4) / 3 + 1024) return null;

  return { ...meta, data };
}
