import { DEFAULT_BLOOM, type ParamValue, type Preset, type RenderSettings, type ShaderControl, type ShaderParams } from '../model';
import { LIMITS } from './limits';
import {
  isFiniteNumber,
  isRecord,
  validateName,
  validateOptionalText,
} from './primitives';
import { fail, ok, type Result } from './result';

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
