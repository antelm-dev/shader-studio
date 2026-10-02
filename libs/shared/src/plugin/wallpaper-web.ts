/**
 * The `wallpaper-web/v1` export runtime's data schema.
 *
 * A `projectExporter` targeting this runtime returns `WallpaperWebData` as its
 * `data`. It is *data only*: GLSL strings, pass wiring, and Wallpaper Engine
 * user-property definitions. The host's runtime validates it here, then alone
 * writes `index.html` (its own fixed player script), `project.json` and the
 * texture files — a plugin never supplies HTML, JavaScript or a file path.
 */
import type { TextureFilterMode, TextureWrapMode } from '../model';
import type { ChannelBinding, ChannelIndex, PassResolution } from '../project';
import { RESOLUTION_LIMITS } from '../project/types';
import { LIMITS } from '../validate/limits';
import { isCleanString, isFiniteNumber, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';

export const WALLPAPER_WEB_RUNTIME = 'wallpaper-web/v1';

export const WALLPAPER_WEB_LIMITS = {
  passes: 5,
  properties: 64,
  comboOptions: LIMITS.selectOptionCount,
  /** A composed pass (Common + files + pass + generated uniforms). */
  fragmentLength: 400_000,
  textLength: 64,
} as const;

export interface WallpaperWebPass {
  id: string;
  name: string;
  kind: 'image' | 'buffer';
  /** A complete WebGL 1 fragment shader, ready to compile. */
  fragment: string;
  channels: ChannelBinding[];
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

interface PropertyBase {
  /** Wallpaper Engine property key: lowercase, unique. */
  key: string;
  /** The shader uniform it drives, without the `u_` prefix. */
  uniform: string;
  text: string;
  order: number;
}

export type WallpaperWebProperty = PropertyBase &
  (
    | { type: 'slider'; min: number; max: number; step: number; precision: number; value: number }
    | { type: 'bool'; value: boolean }
    /** `"r g b"`, each 0–1 — Wallpaper Engine's colour encoding. */
    | { type: 'color'; value: string }
    | { type: 'combo'; options: { label: string; value: string }[]; value: string }
  );

export interface WallpaperWebChannel {
  slot: ChannelIndex;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

export interface WallpaperWebData {
  title: string;
  author?: string;
  vertex: string;
  /** In render order; the last one is the Image pass. */
  passes: WallpaperWebPass[];
  properties: WallpaperWebProperty[];
  /** Sampling of the host's own textures, by slot. Only slots the host has are written. */
  channels: WallpaperWebChannel[];
}

const PASS_KEYS = ['id', 'name', 'kind', 'fragment', 'channels', 'resolution', 'filter', 'wrap'];
const PROPERTY_KEYS: Record<WallpaperWebProperty['type'], string[]> = {
  slider: ['key', 'uniform', 'text', 'order', 'type', 'min', 'max', 'step', 'precision', 'value'],
  bool: ['key', 'uniform', 'text', 'order', 'type', 'value'],
  color: ['key', 'uniform', 'text', 'order', 'type', 'value'],
  combo: ['key', 'uniform', 'text', 'order', 'type', 'options', 'value'],
};
const WRAPS = new Set(['repeat', 'clamp', 'mirror']);
const PROPERTY_KEY = /^[a-z][a-z0-9]{0,63}$/;
const UNIFORM_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const COLOR_VALUE =
  /^(?:0|1|0?\.\d{1,6}|1\.0{1,6}) (?:0|1|0?\.\d{1,6}|1\.0{1,6}) (?:0|1|0?\.\d{1,6}|1\.0{1,6})$/;

/** Validate runtime data from a Worker. Nothing partly valid is returned. */
export function validateWallpaperWebData(input: unknown): Result<WallpaperWebData> {
  if (!isRecord(input)) return fail('wallpaper data must be an object');
  const unknownKey = unknown(input, [
    'title',
    'author',
    'vertex',
    'passes',
    'properties',
    'channels',
  ]);
  if (unknownKey) return fail(`wallpaper.${unknownKey} is not a known field`);

  const title = text(input['title'], 'wallpaper.title');
  if (!title.ok) return title;
  let author: string | undefined;
  if (input['author'] !== undefined) {
    const parsed = text(input['author'], 'wallpaper.author');
    if (!parsed.ok) return parsed;
    author = parsed.value;
  }
  const vertex = input['vertex'];
  if (typeof vertex !== 'string' || vertex.length > LIMITS.sourceLength) {
    return fail('wallpaper.vertex must be GLSL text');
  }

  const rawPasses = input['passes'];
  if (
    !Array.isArray(rawPasses) ||
    rawPasses.length === 0 ||
    rawPasses.length > WALLPAPER_WEB_LIMITS.passes
  ) {
    return fail(`wallpaper.passes must have 1 to ${WALLPAPER_WEB_LIMITS.passes} entries`);
  }
  const passes: WallpaperWebPass[] = [];
  for (const [index, raw] of rawPasses.entries()) {
    const pass = validatePass(raw, `wallpaper.passes[${index}]`);
    if (!pass.ok) return pass;
    passes.push(pass.value);
  }
  const ids = new Set(passes.map((pass) => pass.id));
  if (ids.size !== passes.length) return fail('wallpaper.passes ids must be unique');
  const images = passes.filter((pass) => pass.kind === 'image');
  if (images.length !== 1 || passes.at(-1)!.kind !== 'image') {
    return fail('wallpaper.passes must end with its one Image pass');
  }
  const buffers = new Set(passes.filter((pass) => pass.kind === 'buffer').map((pass) => pass.id));
  for (const pass of passes) {
    for (const binding of pass.channels) {
      if (binding.kind === 'buffer' && !buffers.has(binding.passId)) {
        return fail(`wallpaper pass "${pass.id}" samples a buffer that is not exported`);
      }
    }
  }

  const rawProperties = input['properties'];
  if (!Array.isArray(rawProperties) || rawProperties.length > WALLPAPER_WEB_LIMITS.properties) {
    return fail(
      `wallpaper.properties must have at most ${WALLPAPER_WEB_LIMITS.properties} entries`,
    );
  }
  const properties: WallpaperWebProperty[] = [];
  const keys = new Set<string>();
  const uniforms = new Set<string>();
  for (const [index, raw] of rawProperties.entries()) {
    const property = validateProperty(raw, `wallpaper.properties[${index}]`);
    if (!property.ok) return property;
    if (keys.has(property.value.key))
      return fail(`wallpaper property "${property.value.key}" is duplicated`);
    if (uniforms.has(property.value.uniform)) {
      return fail(`wallpaper uniform "${property.value.uniform}" has two properties`);
    }
    keys.add(property.value.key);
    uniforms.add(property.value.uniform);
    properties.push(property.value);
  }

  const rawChannels = input['channels'];
  if (!Array.isArray(rawChannels) || rawChannels.length > 4) {
    return fail('wallpaper.channels must have at most 4 entries');
  }
  const channels: WallpaperWebChannel[] = [];
  const slots = new Set<number>();
  for (const raw of rawChannels) {
    if (
      !isRecord(raw) ||
      unknown(raw, ['slot', 'wrap', 'filter', 'flipY']) ||
      ![0, 1, 2, 3].includes(raw['slot'] as number) ||
      slots.has(raw['slot'] as number) ||
      !WRAPS.has(raw['wrap'] as string) ||
      (raw['filter'] !== 'linear' && raw['filter'] !== 'nearest') ||
      typeof raw['flipY'] !== 'boolean'
    ) {
      return fail('wallpaper.channels entries must be { slot, wrap, filter, flipY }');
    }
    slots.add(raw['slot'] as number);
    channels.push({
      slot: raw['slot'] as ChannelIndex,
      wrap: raw['wrap'] as TextureWrapMode,
      filter: raw['filter'],
      flipY: raw['flipY'],
    });
  }

  return ok({
    title: title.value,
    ...(author === undefined ? {} : { author }),
    vertex,
    passes,
    properties,
    channels,
  });
}

function validatePass(input: unknown, at: string): Result<WallpaperWebPass> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = unknown(input, PASS_KEYS);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  const { id, kind, fragment, channels, resolution, filter, wrap } = input;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    return fail(`${at}.id is invalid`);
  const name = text(input['name'], `${at}.name`);
  if (!name.ok) return name;
  if (kind !== 'image' && kind !== 'buffer') return fail(`${at}.kind must be image or buffer`);
  if (
    typeof fragment !== 'string' ||
    fragment.trim() === '' ||
    fragment.length > WALLPAPER_WEB_LIMITS.fragmentLength
  ) {
    return fail(`${at}.fragment must be GLSL text`);
  }
  if (!Array.isArray(channels) || channels.length !== 4)
    return fail(`${at}.channels must have 4 entries`);
  const bindings: ChannelBinding[] = [];
  for (const binding of channels) {
    const parsed = validateBinding(binding);
    if (!parsed) return fail(`${at}.channels has an invalid binding`);
    bindings.push(parsed);
  }
  const parsedResolution = validateResolution(resolution);
  if (!parsedResolution) return fail(`${at}.resolution is invalid`);
  if (filter !== 'linear' && filter !== 'nearest') return fail(`${at}.filter is invalid`);
  if (typeof wrap !== 'string' || !WRAPS.has(wrap)) return fail(`${at}.wrap is invalid`);
  return ok({
    id,
    name: name.value,
    kind,
    fragment,
    channels: bindings,
    resolution: parsedResolution,
    filter,
    wrap: wrap as TextureWrapMode,
  });
}

function validateBinding(input: unknown): ChannelBinding | null {
  if (!isRecord(input)) return null;
  if (input['kind'] === 'none' && Object.keys(input).length === 1) return { kind: 'none' };
  if (
    input['kind'] === 'texture' &&
    [0, 1, 2, 3].includes(input['slot'] as number) &&
    Object.keys(input).length === 2
  ) {
    return { kind: 'texture', slot: input['slot'] as ChannelIndex };
  }
  if (
    input['kind'] === 'buffer' &&
    typeof input['passId'] === 'string' &&
    typeof input['feedback'] === 'boolean' &&
    Object.keys(input).length === 3
  ) {
    return { kind: 'buffer', passId: input['passId'], feedback: input['feedback'] };
  }
  return null;
}

function validateResolution(input: unknown): PassResolution | null {
  if (!isRecord(input) || unknown(input, ['mode', 'scale', 'width', 'height'])) return null;
  const { mode, scale, width, height } = input;
  if (mode !== 'viewport' && mode !== 'scaled' && mode !== 'fixed') return null;
  const { scale: s, size } = RESOLUTION_LIMITS;
  if (!isFiniteNumber(scale) || scale < s.min || scale > s.max) return null;
  for (const value of [width, height]) {
    if (!Number.isInteger(value) || (value as number) < size.min || (value as number) > size.max) {
      return null;
    }
  }
  return { mode, scale, width: width as number, height: height as number };
}

function validateProperty(input: unknown, at: string): Result<WallpaperWebProperty> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const type = input['type'];
  if (type !== 'slider' && type !== 'bool' && type !== 'color' && type !== 'combo') {
    return fail(`${at}.type must be slider, bool, color or combo`);
  }
  const unknownKey = unknown(input, PROPERTY_KEYS[type]);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  const { key, uniform, order, value } = input;
  if (typeof key !== 'string' || !PROPERTY_KEY.test(key)) return fail(`${at}.key is invalid`);
  if (typeof uniform !== 'string' || !UNIFORM_KEY.test(uniform))
    return fail(`${at}.uniform is invalid`);
  const label = text(input['text'], `${at}.text`);
  if (!label.ok) return label;
  if (!Number.isInteger(order) || (order as number) < 0 || (order as number) > 10_000) {
    return fail(`${at}.order is invalid`);
  }
  const base = { key, uniform, text: label.value, order: order as number };

  switch (type) {
    case 'slider': {
      const { min, max, step, precision } = input;
      if (
        !isFiniteNumber(min) ||
        !isFiniteNumber(max) ||
        !isFiniteNumber(step) ||
        !isFiniteNumber(value) ||
        min >= max ||
        step <= 0 ||
        value < min ||
        value > max ||
        !Number.isInteger(precision) ||
        (precision as number) < 0 ||
        (precision as number) > 6
      ) {
        return fail(`${at} slider needs min < max, step > 0, precision 0–6 and a value in range`);
      }
      return ok({ ...base, type, min, max, step, precision: precision as number, value });
    }
    case 'bool':
      if (typeof value !== 'boolean') return fail(`${at}.value must be a boolean`);
      return ok({ ...base, type, value });
    case 'color':
      if (typeof value !== 'string' || !COLOR_VALUE.test(value)) {
        return fail(`${at}.value must be "r g b" with each 0–1`);
      }
      return ok({ ...base, type, value });
    case 'combo': {
      const options = input['options'];
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.length > WALLPAPER_WEB_LIMITS.comboOptions
      ) {
        return fail(`${at}.options must have 1 to ${WALLPAPER_WEB_LIMITS.comboOptions} entries`);
      }
      const parsed: { label: string; value: string }[] = [];
      for (const option of options) {
        if (
          !isRecord(option) ||
          unknown(option, ['label', 'value']) ||
          typeof option['value'] !== 'string' ||
          !/^-?\d{1,9}(?:\.\d{1,6})?$/.test(option['value'])
        ) {
          return fail(`${at}.options entries must be { label, value } with a numeric value`);
        }
        const optionLabel = text(option['label'], `${at}.options label`);
        if (!optionLabel.ok) return optionLabel;
        parsed.push({ label: optionLabel.value, value: option['value'] });
      }
      if (typeof value !== 'string' || !parsed.some((option) => option.value === value)) {
        return fail(`${at}.value must be one of its options`);
      }
      return ok({ ...base, type, options: parsed, value });
    }
  }
}

function text(input: unknown, at: string): Result<string> {
  if (
    !isCleanString(input) ||
    input.trim() === '' ||
    input.length > WALLPAPER_WEB_LIMITS.textLength
  ) {
    return fail(`${at} must be 1–${WALLPAPER_WEB_LIMITS.textLength} characters of plain text`);
  }
  return ok(input);
}

function unknown(input: Record<string, unknown>, known: readonly string[]): string | undefined {
  return Object.keys(input).find((key) => !known.includes(key));
}
