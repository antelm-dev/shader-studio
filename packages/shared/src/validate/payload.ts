import type { ImportMode, Preset, ShaderPayload } from '../model';
import { sanitizeProject } from '../project/sanitize';
import { LIMITS } from './limits';
import { validateChannelPayloads, validateThumbnailPayload } from './assets';
import { validateControls, validatePreset, validateRender } from './controls';
import {
  isRecord,
  isValidId,
  slugify,
  uniqueId,
  validateDescription,
  validateId,
  validateName,
  validateOptionalText,
  validateSource,
} from './primitives';
import { fail, ok, type Result } from './result';

export function validateImportMode(input: unknown): Result<ImportMode> {
  if (input === undefined || input === null) return ok('rename');
  if (input === 'rename' || input === 'overwrite') return ok(input);
  return fail('mode must be "rename" or "overwrite"');
}

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
    channels: validateChannelPayloads(input['channels']),
    thumbnail: validateThumbnailPayload(input['thumbnail']),
    // Tolerant, and the v1-bundle-compat story in one line: a bundle from
    // before projects existed has no `project` field, `sanitizeProject` sees
    // garbage/`undefined` and falls back to `migrateLegacyProject`, exactly
    // reproducing the single-pass shader the fragment/vertex above describe.
    project: sanitizeProject(input['project'], fragmentResult.value, vertexResult.value),
  });
}
