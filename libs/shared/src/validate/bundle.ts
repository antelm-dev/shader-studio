import { BUNDLE_FORMAT, LEGACY_BUNDLE_FORMAT, type Bundle, type ShaderPayload } from '../model';
import { LIMITS } from './limits';
import { validateShaderPayload } from './payload';
import { isRecord } from './primitives';
import { fail, ok, type Result } from './result';

export function parseBundle(input: unknown): Result<ShaderPayload[]> {
  if (!isRecord(input)) {
    return fail('bundle must be a JSON object');
  }
  // A `shader-studio/v1` bundle has no `project` field; `validateShaderPayload`
  // synthesizes one via `migrateLegacyProject`, so accepting the old tag here is
  // the whole of v1 import compatibility.
  if (input['format'] !== BUNDLE_FORMAT && input['format'] !== LEGACY_BUNDLE_FORMAT) {
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
