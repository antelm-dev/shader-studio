/**
 * Turns a validated `ProjectCandidate` into a bundle the library can import.
 *
 * The candidate's texture *requests* are resolved here, by the host, through
 * the contribution's own source provider (`resolveTextureRequests`): each
 * asset is fetched by the provider — which refuses references outside its
 * allow-list — sniffed, bounded and slotted. Then the whole payload goes
 * through the same bundle validation a `.shader.json` file does, so nothing
 * the plugin returned reaches the library unchecked.
 */
import {
  DEFAULT_RENDER,
  type ShaderBundle,
  type ShaderControl,
  type ShaderPayload,
} from '@shadergrove/shared/model';
import { resolveTextureRequests, type ProjectCandidate } from '@shadergrove/shared/plugin';
import { newId } from '@shadergrove/shared/project';
import { LIMITS, buildShaderBundle, parseBundle, slugify } from '@shadergrove/shared/validate';

import type { SourceProvider } from './host-adapters';

export interface ResolvedImport {
  bundle: ShaderBundle;
  name: string;
  warnings: string[];
}

export interface ResolveOptions {
  /** Kept short and appended to the id, as the built-in importer did. */
  idSuffix?: string;
  signal: AbortSignal;
}

/** Resolve a candidate's textures with `provider` (if any) and validate the result as a bundle. */
export async function resolveProjectCandidate(
  candidate: ProjectCandidate,
  provider: SourceProvider | null,
  { idSuffix, signal }: ResolveOptions,
): Promise<ResolvedImport> {
  const unresolved = provider ? [] : candidate.textures;
  const resolved = await resolveTextureRequests(
    candidate.project.passes,
    provider ? candidate.textures : [],
    (asset) => provider!.fetchAsset(asset, signal),
    () => signal.throwIfAborted(),
  );
  signal.throwIfAborted();
  const warnings = [
    ...candidate.warnings,
    ...resolved.warnings,
    ...unresolved.map(
      () => 'A texture was left unassigned: this importer has no texture provider.',
    ),
  ];

  const project = { ...candidate.project, passes: resolved.passes };
  const image = project.passes.find((pass) => pass.kind === 'image');
  if (!image) throw new Error('The imported shader has no Image pass.');
  // The candidate's values become the controls' defaults: an import has no presets yet.
  const controls = candidate.controls.map(
    (control) =>
      ({ ...control, default: candidate.values[control.key] ?? control.default }) as ShaderControl,
  );
  const payload: ShaderPayload = {
    id: shaderId(candidate.name, idSuffix),
    name: candidate.name,
    description: candidate.description,
    ...(candidate.credits.author ? { author: candidate.credits.author } : {}),
    controls,
    render: DEFAULT_RENDER,
    fragment: image.source,
    vertex: project.vertex,
    presets: [],
    channels: resolved.channels as unknown as ShaderPayload['channels'],
    thumbnail: null,
    project,
  };
  const bundle = buildShaderBundle(payload) as ShaderBundle;
  const parsed = parseBundle(bundle);
  if (!parsed.ok) {
    throw new Error(`The imported shader is not valid: ${parsed.errors[0] ?? ''}`);
  }
  return { bundle, name: candidate.name, warnings };
}

/** `slugify(name)-<suffix>`, kept short and always a valid id. */
function shaderId(name: string, suffix?: string): string {
  const base = slugify(name);
  const tail = (suffix ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  if (!tail) return base || newId('shader');
  const trimmed = base.slice(0, LIMITS.idLength - tail.length - 1);
  return trimmed ? `${trimmed}-${tail}` : tail;
}
