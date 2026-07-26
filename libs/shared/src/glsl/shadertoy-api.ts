import {
  DEFAULT_RENDER,
  type ShaderPayload,
  type TextureChannelPayload,
} from '@shader-studio/shared/model';
import {
  BUFFER_SLOTS,
  CHANNEL_COUNT,
  DEFAULT_COMMON,
  DEFAULT_VERTEX,
  emptyBindings,
  makePass,
  newId,
  sanitizeProject,
  type BufferSlot,
  type ChannelBinding,
  type ChannelIndex,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { LIMITS, TEXTURE_EXTENSIONS, slugify } from '@shader-studio/shared/validate';
import { decodeImage } from '@shader-studio/shared/image-dimensions';
import { wrapMainImage } from '@shader-studio/shared/shadertoy-import';

const SHADERTOY_ORIGIN = 'https://www.shadertoy.com';

/**
 * The slice of the DOM/Node `fetch` API this module needs. Kept as a local,
 * structural type — rather than the ambient `fetch`/`Response` globals — so
 * this package stays usable without a DOM or Node `lib` (it runs in the
 * Electron main process, the Express server, and the browser alike).
 */
export interface ShadertoyFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ShadertoyFetch = (url: string) => Promise<ShadertoyFetchResponse>;

export interface ShadertoyFetchDeps {
  fetch: ShadertoyFetch;
}

export interface ShadertoyImportResult {
  payload: ShaderPayload;
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
  const id = match ? match[1] : trimmed;
  if (!/^[A-Za-z0-9]+$/.test(id)) {
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

function samplerWrap(sampler: ShadertoySampler | undefined): TextureChannelPayload['wrap'] {
  return sampler?.wrap && WRAP_MODES.has(sampler.wrap)
    ? (sampler.wrap as TextureChannelPayload['wrap'])
    : 'repeat';
}

function samplerFilter(sampler: ShadertoySampler | undefined): TextureChannelPayload['filter'] {
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
    const code = rpass.code ?? '';
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
          rpass.name?.trim() || `Buffer ${slot}`,
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

interface QueuedTexture {
  url: string;
  passId: string;
  passName: string;
  channel: ChannelIndex;
  sampler: ShadertoySampler | undefined;
}

/** Resolves one input to a channel binding, or `null` for buffer refs deferred to texture queuing. */
function resolveBufferBinding(
  input: ShadertoyInput,
  pass: RenderPass,
  index: ChannelIndex,
  outputToPassId: Map<string, string>,
  warnings: string[],
): ChannelBinding | null {
  const refId = input.id !== undefined ? String(input.id) : undefined;
  const targetPassId = refId ? outputToPassId.get(refId) : undefined;
  if (!targetPassId) {
    warnings.push(`"${pass.name}" iChannel${index}: could not resolve the buffer it references.`);
    return null;
  }
  return { kind: 'buffer', passId: targetPassId, feedback: targetPassId === pass.id };
}

/** Resolves one `inputs[]` entry into a channel binding and/or a texture download to queue. */
function wireInput(
  input: ShadertoyInput,
  pass: RenderPass,
  index: ChannelIndex,
  outputToPassId: Map<string, string>,
  queuedTextures: QueuedTexture[],
  warnings: string[],
): ChannelBinding | null {
  const kind = inputKind(input);

  if (kind === 'buffer') {
    return resolveBufferBinding(input, pass, index, outputToPassId, warnings);
  }

  if (kind === 'texture') {
    if (!input.src) return null;
    queuedTextures.push({
      url: `${SHADERTOY_ORIGIN}${input.src}`,
      passId: pass.id,
      passName: pass.name,
      channel: index,
      sampler: input.sampler,
    });
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
): QueuedTexture[] {
  const queuedTextures: QueuedTexture[] = [];

  for (const rpass of kept) {
    const outputId = outputIdOf(rpass);
    const pass = outputId
      ? passes.find((entry) => entry.id === outputToPassId.get(outputId))
      : undefined;
    if (!pass) continue;

    const bindings = [...emptyBindings()] as ChannelBinding[];

    for (const input of rpass.inputs ?? []) {
      const channel = input.channel;
      if (channel === undefined || channel < 0 || channel > 3) continue;
      const index = channel as ChannelIndex;
      const binding = wireInput(input, pass, index, outputToPassId, queuedTextures, warnings);
      if (binding) bindings[index] = binding;
    }

    pass.channels = bindings as unknown as RenderPass['channels'];
  }

  return queuedTextures;
}

function emptyChannelPayloads(): TextureChannelPayload[] {
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

async function downloadTexture(url: string, fetchImpl: ShadertoyFetch): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`request failed (${response.status})`);

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > LIMITS.textureBytes) {
    throw new Error(`larger than ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`);
  }
  return new Uint8Array(buffer);
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Dependency-free base64 encoding — avoids relying on ambient `Buffer`/`btoa`. */
function base64FromBytes(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    result += hasB2 ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return result;
}

/**
 * Downloads every texture a pass references, de-duplicated by URL and capped
 * at the project model's 4 global slots, and rewrites each queued pass's
 * `texture` binding to point at the slot its URL landed on.
 */
async function resolveTextures(
  queuedTextures: QueuedTexture[],
  passes: RenderPass[],
  fetchImpl: ShadertoyFetch,
  warnings: string[],
): Promise<TextureChannelPayload[]> {
  const channels = emptyChannelPayloads();
  const slotByUrl = new Map<string, ChannelIndex>();

  for (const queued of queuedTextures) {
    let slot = slotByUrl.get(queued.url);
    if (slot === undefined) {
      const claimed = await claimTextureSlot(queued, slotByUrl, channels, fetchImpl, warnings);
      if (claimed === undefined) continue;
      slot = claimed;
    }

    const pass = passes.find((entry) => entry.id === queued.passId);
    if (!pass) continue;
    const bindings = [...pass.channels] as ChannelBinding[];
    bindings[queued.channel] = { kind: 'texture', slot };
    pass.channels = bindings as unknown as RenderPass['channels'];
  }

  return channels;
}

/** Downloads one queued texture into the next free slot, or records why it couldn't. */
async function claimTextureSlot(
  queued: QueuedTexture,
  slotByUrl: Map<string, ChannelIndex>,
  channels: TextureChannelPayload[],
  fetchImpl: ShadertoyFetch,
  warnings: string[],
): Promise<ChannelIndex | undefined> {
  if (slotByUrl.size >= CHANNEL_COUNT) {
    warnings.push(
      `Only ${CHANNEL_COUNT} texture slots are available; "${queued.passName}" iChannel${queued.channel} was left unassigned.`,
    );
    return undefined;
  }
  const slot = slotByUrl.size as ChannelIndex;

  try {
    const bytes = await downloadTexture(queued.url, fetchImpl);
    const decoded = decodeImage(bytes);
    if (!decoded || !TEXTURE_EXTENSIONS.has(decoded.ext)) {
      warnings.push(
        `Could not read the texture format for "${queued.passName}" iChannel${queued.channel}.`,
      );
      return undefined;
    }
    slotByUrl.set(queued.url, slot);
    channels[slot] = {
      ext: decoded.ext,
      width: decoded.width,
      height: decoded.height,
      wrap: samplerWrap(queued.sampler),
      filter: samplerFilter(queued.sampler),
      flipY: samplerFlipY(queued.sampler),
      data: base64FromBytes(bytes),
    };
    return slot;
  } catch (error) {
    warnings.push(
      `Failed to download a texture for "${queued.passName}": ${(error as Error).message}`,
    );
    return undefined;
  }
}

/** `slugify(name)-<shadertoyId>`, kept short and always a valid id. */
function uniqueId(base: string, shadertoyId: string): string {
  const suffix = shadertoyId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  if (!suffix) return base || newId('shader');
  const trimmedBase = base.slice(0, LIMITS.idLength - suffix.length - 1);
  return trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
}

/**
 * Fetches a Shadertoy shader and reconstructs it as a `ShaderPayload` this
 * app can import through its existing bundle pipeline: buffers, the Common
 * tab, and channel wiring survive; passes/inputs the engine has no model for
 * (Sound, Cube, keyboard, video, webcam, music) are dropped with a warning
 * instead of failing the whole import.
 */
export async function importShadertoyShader(
  idOrUrl: string,
  apiKey: string,
  deps: ShadertoyFetchDeps,
): Promise<ShadertoyImportResult> {
  const id = parseShadertoyId(idOrUrl);
  const key = apiKey.trim();
  if (!key) throw new Error('A Shadertoy API key is required.');

  const response = await deps.fetch(
    `${SHADERTOY_ORIGIN}/api/v1/shaders/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`,
  );
  if (!response.ok) {
    throw new Error(`Shadertoy request failed (${response.status}).`);
  }

  const body = (await response.json()) as ShadertoyResponse;
  if (body.Error) throw new Error(`Shadertoy: ${body.Error}`);
  const shader = body.Shader;
  if (!shader?.info || !Array.isArray(shader.renderpass)) {
    throw new Error('Unexpected response from Shadertoy.');
  }

  const warnings: string[] = [];
  const kept = shader.renderpass.filter((rpass) => {
    const kind = rpass.type ?? 'image';
    if (DROPPED_PASS_KINDS.has(kind)) {
      warnings.push(`Dropped the ${kind} pass "${rpass.name ?? kind}" — not supported yet.`);
      return false;
    }
    return true;
  });

  const { passes, outputToPassId } = buildPasses(kept, warnings);
  const queuedTextures = wireChannels(kept, passes, outputToPassId, warnings);
  const channels = await resolveTextures(queuedTextures, passes, deps.fetch, warnings);

  const rawProject: ShaderProject = { version: 1, vertex: DEFAULT_VERTEX, passes, files: [] };
  const imageFallback =
    passes.find((pass) => pass.kind === 'image')?.source ??
    'void main() { gl_FragColor = vec4(0.0); }\n';
  const project = sanitizeProject(rawProject, imageFallback, DEFAULT_VERTEX);
  const imagePass = project.passes.find((pass) => pass.kind === 'image');
  if (!imagePass) throw new Error('The imported shader has no Image pass.');

  const name = shader.info.name?.trim() || 'Imported Shadertoy';
  const payload: ShaderPayload = {
    id: uniqueId(slugify(name), id),
    name,
    description: shader.info.description?.trim() ?? '',
    ...(shader.info.username ? { author: shader.info.username } : {}),
    controls: [],
    render: DEFAULT_RENDER,
    fragment: imagePass.source,
    vertex: project.vertex,
    presets: [],
    channels: channels as unknown as ShaderPayload['channels'],
    thumbnail: null,
    project,
  };

  return { payload, warnings };
}
