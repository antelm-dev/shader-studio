/** Reading and writing a shader's `presets.json`. */

import * as path from 'node:path';

import type { Preset, ShaderControl } from '@shader-studio/shared/model';
import { slugify, uniqueId, validateId, validatePreset } from '@shader-studio/shared/validate';

import { pathExists, readJson, writeFileAtomic } from './file-store';

const PRESETS_FILE = 'presets.json';

function presetsFile(shaderDir: string): string {
  return path.join(shaderDir, PRESETS_FILE);
}

export async function readPresets(dir: string, controls: ShaderControl[]): Promise<Preset[]> {
  const file = presetsFile(dir);
  if (!(await pathExists(file))) return [];

  const raw = await readJson(file);
  const list = Array.isArray((raw as { presets?: unknown })?.presets)
    ? (raw as { presets: unknown[] }).presets
    : [];

  const presets: Preset[] = [];
  const used = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const candidate = entry as Record<string, unknown> | null;
    const base =
      typeof candidate?.['id'] === 'string' && validateId(candidate['id']).ok
        ? (candidate['id'] as string)
        : slugify(
            typeof candidate?.['name'] === 'string' ? candidate['name'] : `preset-${index + 1}`,
          );
    const id = uniqueId(base, used);
    const result = validatePreset(entry, controls, id);
    if (result.ok) {
      used.add(id);
      presets.push(result.value);
    }
  }
  return presets;
}

export async function writePresets(dir: string, presets: Preset[]): Promise<void> {
  await writeFileAtomic(presetsFile(dir), `${JSON.stringify({ presets }, null, 2)}\n`);
}
