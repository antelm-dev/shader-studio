import {
  CUSTOM_EFFECT_API_VERSION,
  DEFAULT_BLOOM,
  DEFAULT_VIGNETTE,
  createBloomEffect,
  legacyInstanceId,
  type BloomEffect,
  type CustomEffectDefinition,
  type BloomSettings,
  type ParamValue,
  type PostProcessingEffect,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type VignetteSettings,
} from '../model';
import { LIMITS } from './limits';
import {
  isCleanString,
  isFiniteNumber,
  isRecord,
  validateName,
  validateOptionalText,
} from './primitives';
import { fail, ok, type Result } from './result';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

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

export function defaultParams(controls: readonly ShaderControl[]): ShaderParams {
  const params: ShaderParams = {};
  for (const control of controls) {
    params[control.key] = control.default;
  }
  return params;
}

export function validateParamValue(control: ShaderControl, value: unknown): Result<ParamValue> {
  const key = control.key;
  switch (control.type) {
    case 'number': {
      if (!isFiniteNumber(value)) return fail(`"${key}" must be a finite number`);
      return ok(Math.min(Math.max(value, control.min), control.max));
    }
    case 'boolean':
      return typeof value === 'boolean' ? ok(value) : fail(`"${key}" must be a boolean`);
    case 'color':
      return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
        ? ok(value.toLowerCase())
        : fail(`"${key}" must be a #rrggbb color`);
    case 'select':
      return isFiniteNumber(value) && Object.values(control.options).includes(value)
        ? ok(value)
        : fail(`"${key}" must be one of the option values`);
    default:
      return fail(`"${key}" has an unsupported control type`);
  }
}

export function sanitizeParams(controls: readonly ShaderControl[], input: unknown): ShaderParams {
  const params = defaultParams(controls);
  if (!isRecord(input)) return params;

  for (const control of controls) {
    if (!(control.key in input)) continue;
    const result = validateParamValue(control, input[control.key]);
    if (result.ok) params[control.key] = result.value;
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
    ...(isRecord(input['render']) ? { render: validateRender(input['render']) } : {}),
  });
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function clampBloomSettings(input: unknown): BloomSettings {
  const record = isRecord(input) ? input : {};
  return {
    strength: clamp(record['strength'], 0, 3, DEFAULT_BLOOM.strength),
    radius: clamp(record['radius'], 0, 1, DEFAULT_BLOOM.radius),
    threshold: clamp(record['threshold'], 0, 1, DEFAULT_BLOOM.threshold),
  };
}

function clampVignetteSettings(input: unknown): VignetteSettings {
  const record = isRecord(input) ? input : {};
  return {
    intensity: clamp(record['intensity'], 0, 1, DEFAULT_VIGNETTE.intensity),
    softness: clamp(record['softness'], 0, 1, DEFAULT_VIGNETTE.softness),
    roundness: clamp(record['roundness'], 0, 1, DEFAULT_VIGNETTE.roundness),
  };
}

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Room left for a `-n` suffix when a kept id has to be made unique. */
const MAX_KEPT_ID = LIMITS.instanceIdLength - 8;

/**
 * A custom effect's definition, or `null` if nothing of it can be kept safely:
 * a source that is not a string or is over `LIMITS.customEffectSourceLength`
 * never reaches the GPU or storage. Name and code always survive otherwise.
 * Controls that do not validate under the v1 rules are dropped — for a newer
 * `apiVersion` that is expected, since the effect will not run here anyway.
 * `customEffectErrors` reports the same cases as errors where a save or an
 * import must refuse instead of normalizing.
 */
function validateCustomDefinition(input: unknown): CustomEffectDefinition | null {
  if (!isRecord(input)) return null;
  const { apiVersion, name, source } = input;
  if (typeof source !== 'string' || source.length > LIMITS.customEffectSourceLength) return null;
  const controls = customControls(input['controls']);
  return {
    apiVersion:
      Number.isInteger(apiVersion) && (apiVersion as number) > 0 ? (apiVersion as number) : 0,
    name:
      isCleanString(name) && name.trim() !== ''
        ? name.trim().slice(0, LIMITS.nameLength)
        : 'Custom effect',
    source,
    controls: controls.ok ? controls.value : [],
  };
}

function customControls(input: unknown): Result<ShaderControl[]> {
  if (Array.isArray(input) && input.length > LIMITS.customEffectControlCount) {
    return fail(`must have at most ${LIMITS.customEffectControlCount} controls`);
  }
  return validateControls(input ?? []);
}

/** One entry of a canonical `postProcessing.effects` array, without its id. Unknown `type`s are discarded. */
function validateEffect(
  input: unknown,
): DistributiveOmit<PostProcessingEffect, 'instanceId'> | null {
  if (!isRecord(input)) return null;
  const enabled = typeof input['enabled'] === 'boolean' ? input['enabled'] : false;
  switch (input['type']) {
    case 'bloom':
      return { type: 'bloom', enabled, settings: clampBloomSettings(input['settings']) };
    case 'vignette':
      return { type: 'vignette', enabled, settings: clampVignetteSettings(input['settings']) };
    case 'custom': {
      const definition = validateCustomDefinition(input['definition']);
      if (!definition) return null;
      const values = sanitizeParams(definition.controls, input['values']);
      return { type: 'custom', enabled, definition, values };
    }
    default:
      return null;
  }
}

/**
 * A whole `postProcessing.effects` array: considers at most
 * `LIMITS.postProcessingEffectCount` entries (an oversized array is truncated
 * rather than scanned in full) and drops anything of an unrecognized shape.
 *
 * Ids are made unique deterministically, so the same input always yields the
 * same chain: an entry keeps a valid id unless an earlier entry already took
 * it; one without (a chain from before ids existed held at most one effect per
 * type) gets `legacyInstanceId(type)`; a clash gets `-2`, `-3`, ... appended.
 */
function validateEffects(input: unknown): PostProcessingEffect[] {
  if (!Array.isArray(input)) return [];

  const used = new Set<string>();
  const effects: PostProcessingEffect[] = [];
  for (const entry of input.slice(0, LIMITS.postProcessingEffectCount)) {
    const effect = validateEffect(entry);
    if (!effect) continue;
    const raw = (entry as Record<string, unknown>)['instanceId'];
    const base =
      typeof raw === 'string' && INSTANCE_ID_PATTERN.test(raw) && raw.length <= MAX_KEPT_ID
        ? raw
        : legacyInstanceId(effect.type);
    let instanceId = base;
    for (let n = 2; used.has(instanceId); n++) instanceId = `${base}-${n}`;
    used.add(instanceId);
    effects.push({ ...effect, instanceId } as PostProcessingEffect);
  }
  return effects;
}

/**
 * What `validateRender` would silently normalize in a custom effect but a save
 * or an import must refuse: code over the limit or of the wrong type, an
 * `apiVersion` that is not a positive integer, or v1 controls that do not
 * validate. Lists one message per problem, or none.
 */
export function customEffectErrors(input: unknown, label = 'render'): string[] {
  if (!isRecord(input) || !isRecord(input['postProcessing'])) return [];
  const effects = input['postProcessing']['effects'];
  if (!Array.isArray(effects)) return [];
  const errors: string[] = [];
  effects.slice(0, LIMITS.postProcessingEffectCount).forEach((entry, index) => {
    if (!isRecord(entry) || entry['type'] !== 'custom') return;
    const at = `${label}.postProcessing.effects[${index}].definition`;
    const definition = entry['definition'];
    if (!isRecord(definition)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { apiVersion, source } = definition;
    if (typeof source !== 'string') errors.push(`${at}.source must be a string`);
    else if (source.length > LIMITS.customEffectSourceLength) {
      errors.push(`${at}.source must be at most ${LIMITS.customEffectSourceLength} characters`);
    }
    if (!Number.isInteger(apiVersion) || (apiVersion as number) < 1) {
      errors.push(`${at}.apiVersion must be a positive integer`);
    } else if (apiVersion === CUSTOM_EFFECT_API_VERSION) {
      const controls = customControls(definition['controls']);
      if (!controls.ok) errors.push(...controls.errors.map((error) => `${at}.controls: ${error}`));
    }
  });
  return errors;
}

/** `validateRender` for a write: fails on what `customEffectErrors` reports instead of normalizing it. */
export function validateRenderStrict(input: unknown, label = 'render'): Result<RenderSettings> {
  const errors = customEffectErrors(input, label);
  return errors.length ? fail(...errors) : ok(validateRender(input));
}

/** A pre-chain `{ enabled, strength, radius, threshold }` bloom record — a v1/v2 bundle or an old preset snapshot. */
function legacyBloomEffect(input: unknown): BloomEffect | null {
  if (!isRecord(input)) return null;
  return {
    type: 'bloom',
    instanceId: legacyInstanceId('bloom'),
    enabled: typeof input['enabled'] === 'boolean' ? input['enabled'] : false,
    settings: clampBloomSettings(input),
  };
}

/**
 * The compatibility boundary for the render contract. Accepts the canonical
 * `{ postProcessing: { enabled, effects } }` chain, the legacy `{ bloom }`
 * shape (a v1/v2 bundle, or an old preset's captured render), or nothing at
 * all — every case is clamped and normalized into a legal `RenderSettings`,
 * and none of them can fail. Never mutates `input`.
 */
export function validateRender(input: unknown): RenderSettings {
  const record = isRecord(input) ? input : {};

  const postProcessing = record['postProcessing'];
  if (isRecord(postProcessing)) {
    return {
      postProcessing: {
        enabled: typeof postProcessing['enabled'] === 'boolean' ? postProcessing['enabled'] : true,
        effects: validateEffects(postProcessing['effects']),
      },
    };
  }

  const legacy = legacyBloomEffect(record['bloom']);
  return {
    postProcessing: {
      enabled: true,
      effects: legacy ? [legacy] : [createBloomEffect()],
    },
  };
}
