/**
 * Validation for everything that crosses a trust boundary: HTTP payloads,
 * imported bundles, and files already sitting on disk.
 *
 * The server treats this module as authoritative — nothing is written until it
 * has passed through here. The client reuses it to give the config editor the
 * same diagnostics the API would return, before a round trip.
 *
 * Every validator returns a `Result` rather than throwing, so a caller can
 * collect and show all the problems at once instead of only the first.
 */

import {
  BUNDLE_FORMAT,
  DEFAULT_BLOOM,
  DEFAULT_TEXTURE_CHANNEL,
  type Bundle,
  type ImportMode,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type ShaderPayload,
  type TextureChannel,
  type TextureChannelPayload,
  type TextureChannelPayloads,
  type TextureChannelSettingsPatch,
  type TextureChannels,
  type TextureFilterMode,
  type TextureWrapMode,
} from './model';

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(...errors: string[]): Result<T> {
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  idLength: 64,
  nameLength: 64,
  descriptionLength: 500,
  authorLength: 64,
  /** Roughly 200k of GLSL. Far beyond any hand-written shader. */
  sourceLength: 200_000,
  controlCount: 200,
  keyLength: 48,
  labelLength: 64,
  folderLength: 48,
  selectOptionCount: 64,
  presetCount: 200,
  /** Bundles are capped by Express's body limit too; this guards the contents. */
  bundleShaderCount: 200,
  /** Per image, raw bytes (before any base64 inflation in a bundle). */
  textureBytes: 4 * 1024 * 1024,
  /** Max width or height, in pixels. Comfortably above any hand-authored channel image. */
  textureDimension: 4096,
} as const;

/** The only raster formats the engine will load a channel image from. */
export const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

const TEXTURE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** The MIME type a texture upload/download travels under, given its extension. */
export function mimeFromExt(ext: string): string {
  return TEXTURE_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** The extension a texture is stored under, given the MIME type it arrived with. Shared between the client (upload) and the server (routing). */
export function extFromMime(mime: string | undefined | null): string | null {
  const clean = (mime ?? '').split(';')[0]?.trim().toLowerCase();
  if (clean === 'image/png') return 'png';
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/webp') return 'webp';
  return null;
}

const TEXTURE_WRAP_MODES = new Set(['repeat', 'clamp', 'mirror']);
const TEXTURE_FILTER_MODES = new Set(['linear', 'nearest']);

/**
 * Shader ids are also directory names. Lowercase alphanumerics and inner
 * hyphens only: no dots (which rules out `.` and `..`), no separators, no
 * whitespace, nothing that needs escaping on any filesystem we support.
 */
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Legal by ID_PATTERN but unusable as a directory name on Windows, where these
 * are reserved device names regardless of extension.
 */
const RESERVED_IDS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Control keys become GLSL identifiers, so they follow GLSL's rules. */
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Provided by the engine for every shader; a control may not shadow them. */
const RESERVED_KEYS = new Set([
  'clickData',
  'time',
  'resolution',
  'mouse',
  'mouseVel',
  'channel0',
  'channel1',
  'channel2',
  'channel3',
]);

const CONTROL_TYPES = new Set(['number', 'boolean', 'color', 'select']);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Rejects control characters, which have no business in a name or a path. */
function isCleanString(value: unknown): value is string {
  // oxlint-disable-next-line no-control-regex
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.idLength &&
    ID_PATTERN.test(value) &&
    !RESERVED_IDS.has(value)
  );
}

/** Guards every route that takes an `:id`, before it ever reaches the filesystem. */
export function validateId(value: unknown): Result<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('id is required');
  }
  if (value.length > LIMITS.idLength) {
    return fail(`id must be at most ${LIMITS.idLength} characters`);
  }
  if (!ID_PATTERN.test(value)) {
    return fail(`id "${value}" is invalid: use lowercase letters, digits and inner hyphens only`);
  }
  if (RESERVED_IDS.has(value)) {
    return fail(`id "${value}" is a reserved device name`);
  }
  return ok(value);
}

export function validateName(value: unknown, field = 'name'): Result<string> {
  if (!isCleanString(value)) {
    return fail(`${field} must be a string without control characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fail(`${field} must not be empty`);
  }
  if (trimmed.length > LIMITS.nameLength) {
    return fail(`${field} must be at most ${LIMITS.nameLength} characters`);
  }
  return ok(trimmed);
}

function validateOptionalText(value: unknown, field: string, maxLength: number): Result<string> {
  if (value === undefined || value === null) return ok('');
  if (!isCleanString(value)) {
    return fail(`${field} must be a string without control characters`);
  }
  if (value.length > maxLength) {
    return fail(`${field} must be at most ${maxLength} characters`);
  }
  return ok(value.trim());
}

export function validateDescription(value: unknown): Result<string> {
  return validateOptionalText(value, 'description', LIMITS.descriptionLength);
}

export function validateSource(value: unknown, field: string): Result<string> {
  if (typeof value !== 'string') {
    return fail(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    return fail(`${field} must not be empty`);
  }
  if (value.length > LIMITS.sourceLength) {
    return fail(`${field} exceeds the ${LIMITS.sourceLength} character limit`);
  }
  if (value.includes('\u0000')) {
    return fail(`${field} must not contain null bytes`);
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Best-effort id from a display name. Always returns something legal. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  if (slug.length === 0 || !ID_PATTERN.test(slug) || RESERVED_IDS.has(slug)) {
    return `shader-${Date.now().toString(36)}`;
  }
  return slug;
}

/** `uniqueId('waves', ['waves', 'waves-2'])` -> `waves-3`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base.slice(0, LIMITS.idLength - 6)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function validateControl(input: unknown, index: number): Result<ShaderControl> {
  const at = `controls[${index}]`;
  if (!isRecord(input)) return fail(`${at} must be an object`);

  const { key, type, label, folder } = input;

  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    return fail(`${at}.key must start with a letter and contain only letters, digits and _`);
  }
  if (key.length > LIMITS.keyLength) {
    return fail(`${at}.key must be at most ${LIMITS.keyLength} characters`);
  }
  if (RESERVED_KEYS.has(key)) {
    return fail(`${at}.key "${key}" is reserved by the engine`);
  }
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) {
    return fail(`${at}.type must be one of ${[...CONTROL_TYPES].join(', ')}`);
  }

  const labelResult = validateOptionalText(label, `${at}.label`, LIMITS.labelLength);
  if (!labelResult.ok) return labelResult;
  const folderResult = validateOptionalText(folder, `${at}.folder`, LIMITS.folderLength);
  if (!folderResult.ok) return folderResult;

  const common = {
    key,
    ...(labelResult.value ? { label: labelResult.value } : {}),
    ...(folderResult.value ? { folder: folderResult.value } : {}),
  };

  switch (type) {
    case 'number': {
      const { default: def, min, max, step } = input;
      if (!isFiniteNumber(min) || !isFiniteNumber(max)) {
        return fail(`${at}.min and ${at}.max must be finite numbers`);
      }
      if (min >= max) {
        return fail(`${at}.min (${min}) must be less than ${at}.max (${max})`);
      }
      if (!isFiniteNumber(def)) {
        return fail(`${at}.default must be a finite number`);
      }
      if (def < min || def > max) {
        return fail(`${at}.default (${def}) must lie within [${min}, ${max}]`);
      }
      if (step !== undefined && (!isFiniteNumber(step) || step <= 0)) {
        return fail(`${at}.step must be a positive number when present`);
      }
      return ok({
        ...common,
        type: 'number',
        default: def,
        min,
        max,
        ...(step === undefined ? {} : { step }),
      });
    }

    case 'boolean': {
      const def = input['default'];
      if (typeof def !== 'boolean') {
        return fail(`${at}.default must be a boolean`);
      }
      return ok({ ...common, type: 'boolean', default: def });
    }

    case 'color': {
      const def = input['default'];
      if (typeof def !== 'string' || !HEX_COLOR_PATTERN.test(def)) {
        return fail(`${at}.default must be a #rrggbb color`);
      }
      return ok({ ...common, type: 'color', default: def.toLowerCase() });
    }

    case 'select': {
      const { default: def, options } = input;
      if (!isRecord(options)) {
        return fail(`${at}.options must be an object mapping labels to numbers`);
      }
      const entries = Object.entries(options);
      if (entries.length === 0) {
        return fail(`${at}.options must not be empty`);
      }
      if (entries.length > LIMITS.selectOptionCount) {
        return fail(`${at}.options must have at most ${LIMITS.selectOptionCount} entries`);
      }
      const parsed: Record<string, number> = {};
      for (const [optionLabel, optionValue] of entries) {
        if (!isFiniteNumber(optionValue)) {
          return fail(`${at}.options["${optionLabel}"] must be a finite number`);
        }
        parsed[optionLabel] = optionValue;
      }
      if (!isFiniteNumber(def) || !Object.values(parsed).includes(def)) {
        return fail(`${at}.default must be one of the option values`);
      }
      return ok({ ...common, type: 'select', default: def, options: parsed });
    }

    default:
      return fail(`${at}.type "${type}" is not supported`);
  }
}

export function validateControls(input: unknown): Result<ShaderControl[]> {
  if (!Array.isArray(input)) {
    return fail('controls must be an array');
  }
  if (input.length > LIMITS.controlCount) {
    return fail(`controls must have at most ${LIMITS.controlCount} entries`);
  }

  const errors: string[] = [];
  const controls: ShaderControl[] = [];
  const seen = new Set<string>();

  input.forEach((entry, index) => {
    const result = validateControl(entry, index);
    if (!result.ok) {
      errors.push(...result.errors);
      return;
    }
    if (seen.has(result.value.key)) {
      errors.push(`controls[${index}].key "${result.value.key}" is duplicated`);
      return;
    }
    seen.add(result.value.key);
    controls.push(result.value);
  });

  return errors.length ? { ok: false, errors } : ok(controls);
}

// ---------------------------------------------------------------------------
// Params & presets
// ---------------------------------------------------------------------------

/** The value a control takes when nothing overrides it. */
export function defaultParams(controls: readonly ShaderControl[]): ShaderParams {
  const params: ShaderParams = {};
  for (const control of controls) {
    params[control.key] = control.default;
  }
  return params;
}

function coerce(control: ShaderControl, value: unknown): ParamOrNull {
  switch (control.type) {
    case 'number':
      if (!isFiniteNumber(value)) return null;
      // Clamp rather than reject: a preset saved before the slider's range was
      // narrowed is still worth keeping, just pulled back into bounds.
      return Math.min(Math.max(value, control.min), control.max);
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'color':
      return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
        ? value.toLowerCase()
        : null;
    case 'select':
      return isFiniteNumber(value) && Object.values(control.options).includes(value) ? value : null;
    default:
      return null;
  }
}

type ParamOrNull = number | boolean | string | null;

/**
 * Project arbitrary values onto a control schema: defaults for anything missing
 * or unusable, unknown keys dropped. This is what keeps a preset meaningful
 * after its shader's schema has been edited underneath it.
 */
export function sanitizeParams(controls: readonly ShaderControl[], input: unknown): ShaderParams {
  const params = defaultParams(controls);
  if (!isRecord(input)) return params;

  for (const control of controls) {
    if (!(control.key in input)) continue;
    const coerced = coerce(control, input[control.key]);
    if (coerced !== null) {
      params[control.key] = coerced;
    }
  }
  return params;
}

export function validatePreset(
  input: unknown,
  controls: readonly ShaderControl[],
  id: string,
): Result<Preset> {
  if (!isRecord(input)) return fail('preset must be an object');

  const nameResult = validateName(input['name'], 'preset.name');
  if (!nameResult.ok) return nameResult;

  const createdAt =
    typeof input['createdAt'] === 'string' && input['createdAt'].length <= 40
      ? input['createdAt']
      : new Date().toISOString();

  return ok({
    id,
    name: nameResult.value,
    createdAt,
    values: sanitizeParams(controls, input['values']),
  });
}

// ---------------------------------------------------------------------------
// Render settings
// ---------------------------------------------------------------------------

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Tolerant by design: bloom is cosmetic, so bad values fall back rather than fail. */
export function validateRender(input: unknown): RenderSettings {
  const bloomInput = isRecord(input) && isRecord(input['bloom']) ? input['bloom'] : {};
  return {
    bloom: {
      enabled:
        typeof bloomInput['enabled'] === 'boolean' ? bloomInput['enabled'] : DEFAULT_BLOOM.enabled,
      strength: clamp(bloomInput['strength'], 0, 3, DEFAULT_BLOOM.strength),
      radius: clamp(bloomInput['radius'], 0, 1, DEFAULT_BLOOM.radius),
      threshold: clamp(bloomInput['threshold'], 0, 1, DEFAULT_BLOOM.threshold),
    },
  };
}

// ---------------------------------------------------------------------------
// Texture channels (iChannel0…3)
// ---------------------------------------------------------------------------

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

/**
 * Tolerant, like `validateRender`: a channel slot with a bad or missing
 * shape falls back to "empty" rather than failing the whole shader. The
 * `ext`/`width`/`height` triple is only ever trusted together — if the
 * extension is not one we serve, the slot is treated as empty regardless of
 * what width/height claimed.
 */
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

/** Always returns exactly four slots, padding or truncating as needed. */
export function validateChannels(input: unknown): TextureChannels {
  const list = Array.isArray(input) ? input : [];
  return [0, 1, 2, 3].map((index) => validateChannel(list[index])) as unknown as TextureChannels;
}

/**
 * Strict counterpart used only by the general `PUT /shaders/:id` patch path:
 * settings only. It can never smuggle in `ext`/`width`/`height`, so a client
 * cannot point metadata at a texture file that was never actually uploaded —
 * that only ever happens through the dedicated upload endpoint, which carries
 * real bytes.
 */
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

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A channel as carried inside a bundle: same tolerant shape as
 * `validateChannel`, plus a base64 `data` payload that must actually be
 * present (and look like base64) whenever `ext` is set — otherwise the slot
 * is dropped back to empty rather than trusting metadata with no bytes.
 */
function validateChannelPayload(input: unknown): TextureChannelPayload {
  const channel = validateChannel(input);
  const data = isRecord(input) ? input['data'] : undefined;

  if (channel.ext === null) return { ...channel, data: null };
  if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) {
    return { ...DEFAULT_TEXTURE_CHANNEL, data: null };
  }
  // Roughly 4 bytes of base64 per 3 bytes of data; reject absurdly large payloads up front.
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

// ---------------------------------------------------------------------------
// Bundles (import / export)
// ---------------------------------------------------------------------------

export function validateImportMode(input: unknown): Result<ImportMode> {
  if (input === undefined || input === null) return ok('rename');
  if (input === 'rename' || input === 'overwrite') return ok(input);
  return fail('mode must be "rename" or "overwrite"');
}

/**
 * Validate one shader payload. `index` only shapes the error messages, so a
 * failure inside a collection points at the shader that caused it.
 */
export function validateShaderPayload(input: unknown, label = 'shader'): Result<ShaderPayload> {
  if (!isRecord(input)) return fail(`${label} must be an object`);

  const errors: string[] = [];

  const idResult = validateId(input['id']);
  const nameResult = validateName(input['name'], `${label}.name`);
  const descriptionResult = validateDescription(input['description']);
  const authorResult = validateOptionalText(
    input['author'],
    `${label}.author`,
    LIMITS.authorLength,
  );
  const fragmentResult = validateSource(input['fragment'], `${label}.fragment`);
  const vertexResult = validateSource(input['vertex'], `${label}.vertex`);
  const controlsResult = validateControls(input['controls'] ?? []);

  // An id that fails validation is recoverable — we can derive one from the
  // name — but only if the name itself is sound.
  let id: string | undefined = idResult.ok ? idResult.value : undefined;
  if (!idResult.ok && nameResult.ok) {
    id = slugify(nameResult.value);
  }

  if (!nameResult.ok) errors.push(...nameResult.errors);
  if (!descriptionResult.ok) errors.push(...descriptionResult.errors);
  if (!authorResult.ok) errors.push(...authorResult.errors);
  if (!fragmentResult.ok) errors.push(...fragmentResult.errors);
  if (!vertexResult.ok) errors.push(...vertexResult.errors);
  if (!controlsResult.ok) errors.push(...controlsResult.errors);
  if (id === undefined) errors.push(`${label}.id is missing and cannot be derived from the name`);

  // Every result has to be named here, not just counted: this is what narrows
  // each one to its `ok: true` branch for the return below.
  if (
    errors.length > 0 ||
    id === undefined ||
    !nameResult.ok ||
    !descriptionResult.ok ||
    !authorResult.ok ||
    !fragmentResult.ok ||
    !vertexResult.ok ||
    !controlsResult.ok
  ) {
    return { ok: false, errors };
  }

  const controls = controlsResult.value;
  const rawPresets = Array.isArray(input['presets']) ? input['presets'] : [];
  if (rawPresets.length > LIMITS.presetCount) {
    return fail(`${label}.presets must have at most ${LIMITS.presetCount} entries`);
  }

  const presets: Preset[] = [];
  const presetErrors: string[] = [];
  const usedPresetIds = new Set<string>();

  rawPresets.forEach((entry, index) => {
    const raw = isRecord(entry) && isValidId(entry['id']) ? (entry['id'] as string) : undefined;
    const base =
      raw ??
      (isRecord(entry) && typeof entry['name'] === 'string'
        ? slugify(entry['name'])
        : `preset-${index + 1}`);
    const presetId = uniqueId(base, usedPresetIds);
    const result = validatePreset(entry, controls, presetId);
    if (!result.ok) {
      presetErrors.push(
        ...result.errors.map((message) => `${label}.presets[${index}]: ${message}`),
      );
      return;
    }
    usedPresetIds.add(presetId);
    presets.push(result.value);
  });

  if (presetErrors.length) return { ok: false, errors: presetErrors };

  return ok({
    id,
    name: nameResult.value,
    description: descriptionResult.value,
    ...(authorResult.value ? { author: authorResult.value } : {}),
    controls,
    render: validateRender(input['render']),
    fragment: fragmentResult.value,
    vertex: vertexResult.value,
    presets,
    // Tolerant: an older bundle (or one from a build predating this feature)
    // has no `channels` field at all, and simply imports with none assigned.
    channels: validateChannelPayloads(input['channels']),
  });
}

/**
 * Parse an imported file. Accepts either bundle kind and always hands back a
 * flat list of shaders, so callers do not care which one they were given.
 */
export function parseBundle(input: unknown): Result<ShaderPayload[]> {
  if (!isRecord(input)) {
    return fail('bundle must be a JSON object');
  }
  if (input['format'] !== BUNDLE_FORMAT) {
    return fail(
      `unsupported bundle format ${JSON.stringify(input['format'] ?? null)}; expected "${BUNDLE_FORMAT}"`,
    );
  }

  const kind = input['kind'];

  if (kind === 'shader') {
    const result = validateShaderPayload(input['shader']);
    return result.ok ? ok([result.value]) : result;
  }

  if (kind === 'collection') {
    const shaders = input['shaders'];
    if (!Array.isArray(shaders)) {
      return fail('collection bundle must have a "shaders" array');
    }
    if (shaders.length === 0) {
      return fail('collection bundle contains no shaders');
    }
    if (shaders.length > LIMITS.bundleShaderCount) {
      return fail(`collection bundle must have at most ${LIMITS.bundleShaderCount} shaders`);
    }

    const errors: string[] = [];
    const payloads: ShaderPayload[] = [];
    shaders.forEach((entry, index) => {
      const result = validateShaderPayload(entry, `shaders[${index}]`);
      if (result.ok) {
        payloads.push(result.value);
      } else {
        errors.push(...result.errors);
      }
    });

    return errors.length ? { ok: false, errors } : ok(payloads);
  }

  return fail('bundle kind must be "shader" or "collection"');
}

export function buildShaderBundle(shader: ShaderPayload): Bundle {
  return {
    format: BUNDLE_FORMAT,
    kind: 'shader',
    exportedAt: new Date().toISOString(),
    shader,
  };
}

export function buildCollectionBundle(shaders: ShaderPayload[]): Bundle {
  return {
    format: BUNDLE_FORMAT,
    kind: 'collection',
    exportedAt: new Date().toISOString(),
    shaders,
  };
}
