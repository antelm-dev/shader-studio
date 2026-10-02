/**
 * Turns a validated `ProjectCandidate` into a bundle the library can import.
 *
 * The candidate's texture *requests* are resolved here, by the host, through
 * the contribution's own source provider: each asset is fetched by the
 * provider (which refuses references outside its allow-list), sniffed, bounded
 * and slotted. Slots go to assets in the order they are first requested, as
 * the built-in Shadertoy importer did; a failed or unreadable download leaves
 * its bindings unassigned with a warning and does not take a slot. Finally the
 * whole payload goes through the same bundle validation a `.shader.json` file
 * does, so nothing the plugin returned reaches the library unchecked.
 */
import {
  DEFAULT_RENDER,
  type ShaderBundle,
  type ShaderControl,
  type ShaderPayload,
  type TextureChannelPayload,
} from '@shadergrove/shared/model';
import { decodeImage } from '@shadergrove/shared/image-dimensions';
import type { ProjectCandidate } from '@shadergrove/shared/plugin';
import {
  CHANNEL_COUNT,
  newId,
  type ChannelBinding,
  type ChannelIndex,
  type RenderPass,
} from '@shadergrove/shared/project';
import {
  LIMITS,
  TEXTURE_EXTENSIONS,
  buildShaderBundle,
  parseBundle,
  slugify,
} from '@shadergrove/shared/validate';

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
  const warnings = [...candidate.warnings];
  const passes: RenderPass[] = candidate.project.passes.map((pass) => ({
    ...pass,
    channels: [...pass.channels] as unknown as RenderPass['channels'],
  }));
  const channels = emptyChannels();
  let claimed = 0;

  for (const request of candidate.textures) {
    signal.throwIfAborted();
    const where = describe(passes, request.uses[0]!);
    if (!provider) {
      warnings.push(`${where}: this importer has no provider for textures.`);
      continue;
    }
    if (claimed >= CHANNEL_COUNT) {
      warnings.push(
        `Only ${CHANNEL_COUNT} texture slots are available; ${where} was left unassigned.`,
      );
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await provider.fetchAsset(request.asset, signal);
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`Failed to download a texture for ${where}: ${messageOf(error)}`);
      continue;
    }
    if (bytes.byteLength > LIMITS.textureBytes) {
      warnings.push(`Failed to download a texture for ${where}: larger than 4 MB`);
      continue;
    }
    const decoded = decodeImage(bytes);
    if (
      !decoded ||
      !TEXTURE_EXTENSIONS.has(decoded.ext) ||
      decoded.width > LIMITS.textureDimension ||
      decoded.height > LIMITS.textureDimension
    ) {
      warnings.push(`Could not read the texture format for ${where}.`);
      continue;
    }
    const slot = claimed++ as ChannelIndex;
    channels[slot] = {
      ext: decoded.ext,
      width: decoded.width,
      height: decoded.height,
      wrap: request.wrap,
      filter: request.filter,
      flipY: request.flipY,
      data: base64(bytes),
    };
    for (const use of request.uses) {
      const pass = passes.find((entry) => entry.id === use.passId);
      if (!pass) continue;
      const bindings = [...pass.channels] as ChannelBinding[];
      bindings[use.channel] = { kind: 'texture', slot };
      pass.channels = bindings as unknown as RenderPass['channels'];
    }
  }

  const project = { ...candidate.project, passes };
  const image = passes.find((pass) => pass.kind === 'image');
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
    channels: channels as unknown as ShaderPayload['channels'],
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

function emptyChannels(): TextureChannelPayload[] {
  return Array.from({ length: CHANNEL_COUNT }, () => ({
    ext: null,
    width: 0,
    height: 0,
    wrap: 'clamp',
    filter: 'linear',
    flipY: true,
    data: null,
  }));
}

function describe(passes: readonly RenderPass[], use: { passId: string; channel: number }): string {
  const pass = passes.find((entry) => entry.id === use.passId);
  return `"${pass?.name ?? 'pass'}" iChannel${use.channel}`;
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

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
