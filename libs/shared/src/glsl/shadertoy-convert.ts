/**
 * Shadertoy → Shadergrove conversion, as pure data transformation.
 *
 * No network, no DOM, no image decoding: this is what the installed Shadertoy
 * plugin runs in its Worker, and what the legacy HTTP/IPC endpoint reuses.
 * Fetching the source document and its textures is the host's job (see
 * `shadertoy-api`), and so is giving textures their slots — the result here
 * only *requests* them, by Shadertoy media path.
 */
import type { ShaderControl, ShaderParams, TextureFilterMode, TextureWrapMode } from '../model';
import {
  BUFFER_SLOTS,
  DEFAULT_COMMON,
  DEFAULT_VERTEX,
  emptyBindings,
  makePass,
  sanitizeProject,
  type BufferSlot,
  type ChannelBinding,
  type ChannelIndex,
  type RenderPass,
  type ShaderProject,
} from '../project';
import { LIMITS } from '../validate/limits';
import { wrapMainImage } from './shadertoy';

export const SHADERTOY_ORIGIN = 'https://www.shadertoy.com';

/** The project a conversion produces; the same shape as a protocol-2 `ProjectCandidate`. */
export interface ShadertoyConversion {
  name: string;
  description: string;
  credits: { author?: string; sourceUrl?: string };
  project: ShaderProject;
  controls: ShaderControl[];
  values: ShaderParams;
  /** Textures to fetch, in first-use order; `asset` is the Shadertoy media path. */
  textures: {
    asset: string;
    uses: { passId: string; channel: ChannelIndex }[];
    wrap: TextureWrapMode;
    filter: TextureFilterMode;
    flipY: boolean;
  }[];
  warnings: string[];
}

// --- Shadertoy's own JSON shape (api/v1/shaders/{id}) ----------------------

interface ShadertoySampler {
  filter?: string;
  wrap?: string;
  vflip?: string | boolean;
}

interface ShadertoyInput {
  id?: string | number;
  src?: string;
  channel?: number;
  ctype?: string;
  type?: string;
  sampler?: ShadertoySampler;
}

interface ShadertoyOutput {
  id?: string | number;
  channel?: number;
}

interface ShadertoyRenderpass {
  type?: string;
  name?: string;
  code?: string;
  inputs?: ShadertoyInput[];
  outputs?: ShadertoyOutput[];
}

interface ShadertoyResponse {
  Shader?: {
    info?: { id?: string; name?: string; description?: string; username?: string };
    renderpass?: ShadertoyRenderpass[];
  };
  Error?: string;
}

/** Accepts a bare id (`XsBSRR`) or a full `shadertoy.com/view/XsBSRR` URL. */
export function parseShadertoyId(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  const match = /shadertoy\.com\/view\/([A-Za-z0-9]+)/.exec(trimmed);
  const id = match ? match[1]! : trimmed;
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) {
    throw new Error('That does not look like a Shadertoy shader ID or URL.');
  }
  return id;
}

const UNSUPPORTED_INPUT_KINDS = new Set([
  'cubemap',
  'volume',
  'video',
  'webcam',
  'keyboard',
  'music',
  'musicstream',
  'mic',
]);

const DROPPED_PASS_KINDS = new Set(['sound', 'cubemap']);
const WRAP_MODES = new Set(['repeat', 'clamp', 'mirror']);

function inputKind(input: ShadertoyInput): string {
  return input.ctype ?? input.type ?? 'texture';
}

function samplerWrap(sampler: ShadertoySampler | undefined): TextureWrapMode {
  return sampler?.wrap && WRAP_MODES.has(sampler.wrap)
    ? (sampler.wrap as TextureWrapMode)
    : 'repeat';
}

function samplerFilter(sampler: ShadertoySampler | undefined): TextureFilterMode {
  return sampler?.filter === 'nearest' ? 'nearest' : 'linear';
}

function samplerFlipY(sampler: ShadertoySampler | undefined): boolean {
  if (sampler?.vflip === undefined) return true;
  return sampler.vflip === true || sampler.vflip === 'true';
}

function outputIdOf(rpass: ShadertoyRenderpass): string | undefined {
  return rpass.outputs?.[0]?.id !== undefined ? String(rpass.outputs[0].id) : undefined;
}

/** Builds a `RenderPass` for an Image or Buffer pass, wrapping its `mainImage` source. */
function buildMainImagePass(
  kind: 'image' | 'buffer',
  name: string,
  code: string,
  slot: BufferSlot | null,
  warnings: string[],
): RenderPass {
  let wrapped;
  try {
    wrapped = wrapMainImage(code, { warnUnassignedChannels: false });
  } catch {
    // Malformed source still gets a pass so the user can fix it in the editor
    // rather than losing the whole import.
    wrapped = { fragment: code, warnings: [] };
  }
  warnings.push(...wrapped.warnings);
  return makePass({ kind, name, slot, source: wrapped.fragment });
}

interface BuiltPasses {
  passes: RenderPass[];
  /** Shadertoy renderpass output id -> the local pass it feeds. */
  outputToPassId: Map<string, string>;
}

/** First pass over `renderpass[]`: create every `RenderPass`, dropping kinds we can't model. */
function buildPasses(kept: ShadertoyRenderpass[], warnings: string[]): BuiltPasses {
  const passes: RenderPass[] = [];
  const outputToPassId = new Map<string, string>();
  const takenSlots = new Set<BufferSlot>();

  for (const rpass of kept) {
    const kind = rpass.type ?? 'image';
    const code = typeof rpass.code === 'string' ? rpass.code : '';
    let pass: RenderPass | undefined;

    if (kind === 'common') {
      pass = makePass({ kind: 'common', name: 'Common', source: code || DEFAULT_COMMON });
    } else if (kind === 'image') {
      pass = buildMainImagePass('image', 'Image', code, null, warnings);
    } else if (kind === 'buffer') {
      const slot = BUFFER_SLOTS.find((candidate) => !takenSlots.has(candidate));
      if (!slot) {
        warnings.push(`Dropped buffer pass "${rpass.name ?? 'Buffer'}" — all four slots are used.`);
      } else {
        takenSlots.add(slot);
        pass = buildMainImagePass(
          'buffer',
          rpass.name?.trim().slice(0, LIMITS.nameLength) || `Buffer ${slot}`,
          code,
          slot,
          warnings,
        );
      }
    } else {
      warnings.push(`Dropped the "${rpass.name ?? kind}" pass — unrecognized pass type "${kind}".`);
    }

    if (!pass) continue;
    passes.push(pass);
    const outputId = outputIdOf(rpass);
    if (outputId) outputToPassId.set(outputId, pass.id);
  }

  return { passes, outputToPassId };
}

type TextureRequest = ShadertoyConversion['textures'][number];

/** Resolves one `inputs[]` entry into a channel binding and/or a texture request. */
function wireInput(
  input: ShadertoyInput,
  pass: RenderPass,
  index: ChannelIndex,
  outputToPassId: Map<string, string>,
  requests: TextureRequest[],
  warnings: string[],
): ChannelBinding | null {
  const kind = inputKind(input);

  if (kind === 'buffer') {
    const refId = input.id !== undefined ? String(input.id) : undefined;
    const targetPassId = refId ? outputToPassId.get(refId) : undefined;
    if (!targetPassId) {
      warnings.push(`"${pass.name}" iChannel${index}: could not resolve the buffer it references.`);
      return null;
    }
    return { kind: 'buffer', passId: targetPassId, feedback: targetPassId === pass.id };
  }

  if (kind === 'texture') {
    if (typeof input.src !== 'string' || !input.src) return null;
    const existing = requests.find((request) => request.asset === input.src);
    if (existing) {
      existing.uses.push({ passId: pass.id, channel: index });
    } else {
      requests.push({
        asset: input.src,
        uses: [{ passId: pass.id, channel: index }],
        wrap: samplerWrap(input.sampler),
        filter: samplerFilter(input.sampler),
        flipY: samplerFlipY(input.sampler),
      });
    }
    return null;
  }

  if (UNSUPPORTED_INPUT_KINDS.has(kind)) {
    warnings.push(`"${pass.name}" iChannel${index}: "${kind}" inputs aren't supported yet.`);
    return null;
  }

  warnings.push(`"${pass.name}" iChannel${index}: unrecognized input type "${kind}".`);
  return null;
}

/** Second pass over `renderpass[]`: wire each pass's four channels now every pass has a local id. */
function wireChannels(
  kept: ShadertoyRenderpass[],
  passes: RenderPass[],
  outputToPassId: Map<string, string>,
  warnings: string[],
): TextureRequest[] {
  const requests: TextureRequest[] = [];

  for (const rpass of kept) {
    const outputId = outputIdOf(rpass);
    const pass = outputId
      ? passes.find((entry) => entry.id === outputToPassId.get(outputId))
      : undefined;
    if (!pass) continue;

    const bindings = [...emptyBindings()] as ChannelBinding[];
    for (const input of Array.isArray(rpass.inputs) ? rpass.inputs : []) {
      const channel = input?.channel;
      if (channel === undefined || !Number.isInteger(channel) || channel < 0 || channel > 3) {
        continue;
      }
      const index = channel as ChannelIndex;
      const binding = wireInput(input, pass, index, outputToPassId, requests, warnings);
      if (binding) bindings[index] = binding;
    }
    pass.channels = bindings as unknown as RenderPass['channels'];
  }

  return requests;
}

/**
 * Reconstructs a Shadertoy API response (`api/v1/shaders/{id}`) as a
 * Shadergrove project: buffers, the Common tab and channel wiring survive;
 * passes and inputs the engine has no model for (Sound, Cube, keyboard,
 * video, webcam, music) are dropped with a warning instead of failing.
 */
export function convertShadertoySource(body: unknown, shadertoyId: string): ShadertoyConversion {
  const response = (body ?? {}) as ShadertoyResponse;
  if (typeof response.Error === 'string' && response.Error) {
    throw new Error(`Shadertoy: ${response.Error.slice(0, 200)}`);
  }
  const shader = response.Shader;
  if (!shader?.info || !Array.isArray(shader.renderpass)) {
    throw new Error('Unexpected response from Shadertoy.');
  }

  const warnings: string[] = [];
  const kept = shader.renderpass.filter((rpass) => {
    const kind = rpass?.type ?? 'image';
    if (DROPPED_PASS_KINDS.has(kind)) {
      warnings.push(`Dropped the ${kind} pass "${rpass.name ?? kind}" — not supported yet.`);
      return false;
    }
    return typeof rpass === 'object' && rpass !== null;
  });

  const { passes, outputToPassId } = buildPasses(kept, warnings);
  const textures = wireChannels(kept, passes, outputToPassId, warnings);

  const rawProject: ShaderProject = { version: 1, vertex: DEFAULT_VERTEX, passes, files: [] };
  const imageFallback =
    passes.find((pass) => pass.kind === 'image')?.source ??
    'void main() { gl_FragColor = vec4(0.0); }\n';
  const project = sanitizeProject(rawProject, imageFallback, DEFAULT_VERTEX);
  if (!project.passes.some((pass) => pass.kind === 'image')) {
    throw new Error('The imported shader has no Image pass.');
  }

  const info = shader.info;
  const name = text(info.name, LIMITS.nameLength) || 'Imported Shadertoy';
  const author = text(info.username, LIMITS.authorLength);
  return {
    name,
    description: text(info.description, LIMITS.descriptionLength),
    credits: {
      ...(author ? { author } : {}),
      sourceUrl: `${SHADERTOY_ORIGIN}/view/${shadertoyId}`,
    },
    project,
    controls: [],
    values: {},
    textures,
    warnings: warnings.map((warning) => warning.slice(0, 300)).slice(0, 32),
  };
}

/** One pasted Image pass, as the built-in paste dialog converted it. */
export function convertShadertoyPaste(name: string, source: string): ShadertoyConversion {
  const converted = wrapMainImage(source);
  const image = makePass({ kind: 'image', name: 'Image', slot: null, source: converted.fragment });
  const project = sanitizeProject(
    { version: 1, vertex: DEFAULT_VERTEX, passes: [image], files: [] },
    converted.fragment,
    DEFAULT_VERTEX,
  );
  return {
    name: text(name, LIMITS.nameLength) || 'Shadertoy import',
    description: '',
    credits: {},
    project,
    controls: [],
    values: {},
    textures: [],
    warnings: converted.warnings,
  };
}

// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Trimmed, control characters removed, cut to `max`. */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, '').trim().slice(0, max).trim();
}
