import { DEFAULT_TEXTURE_CHANNEL } from '../model';
import {
  DEFAULT_PASS_RESOLUTION,
  emptyBindings,
  legacyTextureBindings,
  PROJECT_VERSION,
  type RenderPass,
  type ShaderProject,
} from './types';

let idCounter = 0;

export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function makePass(
  init: Partial<RenderPass> & Pick<RenderPass, 'kind' | 'name' | 'source'>,
): RenderPass {
  return {
    id: init.id ?? newId(init.kind),
    kind: init.kind,
    name: init.name,
    slot: init.slot ?? null,
    enabled: init.enabled ?? true,
    source: init.source,
    channels: init.channels ?? emptyBindings(),
    resolution: init.resolution ?? { ...DEFAULT_PASS_RESOLUTION },
    filter: init.filter ?? DEFAULT_TEXTURE_CHANNEL.filter,
    wrap: init.wrap ?? DEFAULT_TEXTURE_CHANNEL.wrap,
  };
}

export function migrateLegacyProject(fragment: string, vertex: string): ShaderProject {
  return {
    version: PROJECT_VERSION,
    vertex,
    passes: [
      makePass({
        kind: 'image',
        name: 'Image',
        source: fragment,
        channels: legacyTextureBindings(),
      }),
      makePass({ kind: 'common', name: 'Common', source: '' }),
    ],
    files: [],
  };
}

export function createProject(fragment: string, vertex: string): ShaderProject {
  return migrateLegacyProject(fragment, vertex);
}
