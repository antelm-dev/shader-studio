import { LIMITS } from './limits';
import { fail, ok, type Result } from './result';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isCleanString(value: unknown): value is string {
  // oxlint-disable-next-line no-control-regex
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value);
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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

export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LIMITS.idLength &&
    ID_PATTERN.test(value) &&
    !RESERVED_IDS.has(value)
  );
}

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

export function validateOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): Result<string> {
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

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base.slice(0, LIMITS.idLength - 6)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}-${Date.now().toString(36)}`;
}
