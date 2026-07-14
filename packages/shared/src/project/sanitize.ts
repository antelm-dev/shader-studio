import { migrateLegacyProject, newId, uniqueName } from './factory';
import {
  BUFFER_SLOTS,
  CHANNEL_INDICES,
  DEFAULT_PASS_RESOLUTION,
  legacyTextureBindings,
  NO_BINDING,
  PROJECT_VERSION,
  RESOLUTION_LIMITS,
  type BufferSlot,
  type ChannelBinding,
  type ChannelBindings,
  type ChannelIndex,
  type PassKind,
  type PassResolution,
  type PassResolutionMode,
  type RenderPass,
  type ShaderFile,
  type ShaderProject,
} from './types';

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function sanitizeResolution(input: unknown): PassResolution {
  const value = (input ?? {}) as Partial<PassResolution>;
  const mode: PassResolutionMode =
    value.mode === 'scaled' || value.mode === 'fixed' ? value.mode : 'viewport';

  return {
    mode,
    scale: clamp(
      value.scale,
      RESOLUTION_LIMITS.scale.min,
      RESOLUTION_LIMITS.scale.max,
      DEFAULT_PASS_RESOLUTION.scale,
    ),
    width: Math.round(
      clamp(
        value.width,
        RESOLUTION_LIMITS.size.min,
        RESOLUTION_LIMITS.size.max,
        DEFAULT_PASS_RESOLUTION.width,
      ),
    ),
    height: Math.round(
      clamp(
        value.height,
        RESOLUTION_LIMITS.size.min,
        RESOLUTION_LIMITS.size.max,
        DEFAULT_PASS_RESOLUTION.height,
      ),
    ),
  };
}

function sanitizeBinding(input: unknown): ChannelBinding {
  const value = (input ?? {}) as Partial<
    ChannelBinding & { passId: string; slot: number; feedback: boolean }
  >;

  if (value.kind === 'buffer' && typeof value.passId === 'string' && value.passId) {
    return { kind: 'buffer', passId: value.passId, feedback: value.feedback === true };
  }
  if (value.kind === 'texture' && CHANNEL_INDICES.includes(value.slot as ChannelIndex)) {
    return { kind: 'texture', slot: value.slot as ChannelIndex };
  }
  return { kind: 'none' };
}

function sanitizeBindings(input: unknown): ChannelBindings {
  const value = Array.isArray(input) ? input : [];
  return CHANNEL_INDICES.map((index) =>
    sanitizeBinding(value[index]),
  ) as unknown as ChannelBindings;
}

function sanitizePass(input: unknown, kind: PassKind, fallbackName: string): RenderPass | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<RenderPass>;
  if (typeof value.source !== 'string') return null;

  const slot = BUFFER_SLOTS.includes(value.slot as BufferSlot) ? (value.slot as BufferSlot) : null;

  return {
    id: typeof value.id === 'string' && value.id ? value.id : newId(kind),
    kind,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : fallbackName,
    slot: kind === 'buffer' ? slot : null,
    enabled: kind === 'image' ? true : value.enabled !== false,
    source: value.source,
    channels: sanitizeBindings(value.channels),
    resolution: sanitizeResolution(value.resolution),
    filter: value.filter === 'nearest' ? 'nearest' : 'linear',
    wrap: value.wrap === 'repeat' || value.wrap === 'mirror' ? value.wrap : 'clamp',
  };
}

export function sanitizeProject(
  input: unknown,
  fallbackFragment: string,
  fallbackVertex: string,
): ShaderProject {
  if (!input || typeof input !== 'object') {
    return migrateLegacyProject(fallbackFragment, fallbackVertex);
  }

  const value = input as Partial<ShaderProject>;
  const passes = sanitizePasses(Array.isArray(value.passes) ? value.passes : [], fallbackFragment);

  const live = new Set(passes.map((pass) => pass.id));
  const repaired = passes.map((pass) => ({
    ...pass,
    channels: pass.channels.map((binding) =>
      binding.kind === 'buffer' && !live.has(binding.passId) ? NO_BINDING : binding,
    ) as unknown as ChannelBindings,
  }));

  return {
    version: PROJECT_VERSION,
    vertex: typeof value.vertex === 'string' ? value.vertex : fallbackVertex,
    passes: repaired,
    files: sanitizeFiles(Array.isArray(value.files) ? value.files : []),
  };
}

function sanitizePasses(rawPasses: readonly unknown[], fallbackFragment: string): RenderPass[] {
  const passes: RenderPass[] = [];
  const takenSlots = new Set<BufferSlot>();
  let seenImage = false;
  let seenCommon = false;

  for (const raw of rawPasses) {
    const kind = (raw as RenderPass | undefined)?.kind;

    if (kind === 'image' && !seenImage) {
      const pass = sanitizePass(raw, 'image', 'Image');
      if (pass) {
        seenImage = true;
        passes.push(pass);
      }
      continue;
    }

    if (kind === 'common' && !seenCommon) {
      const pass = sanitizePass(raw, 'common', 'Common');
      if (pass) {
        seenCommon = true;
        passes.push(pass);
      }
      continue;
    }

    if (kind !== 'buffer') continue;

    const pass = sanitizePass(raw, 'buffer', 'Buffer');
    if (!pass) continue;

    const slot = pass.slot && !takenSlots.has(pass.slot) ? pass.slot : nextFree(takenSlots);
    if (!slot) continue;

    takenSlots.add(slot);
    passes.push({ ...pass, slot, name: pass.name === 'Buffer' ? `Buffer ${slot}` : pass.name });
  }

  if (!seenImage) {
    const image = sanitizePass(
      { source: fallbackFragment, channels: legacyTextureBindings() },
      'image',
      'Image',
    );
    if (image) passes.unshift(image);
  }

  if (!seenCommon) {
    const common = sanitizePass({ source: '' }, 'common', 'Common');
    if (common) passes.push(common);
  }

  return passes;
}

function sanitizeFiles(rawFiles: readonly unknown[]): ShaderFile[] {
  const files: ShaderFile[] = [];
  const taken = new Set<string>();

  for (const raw of rawFiles) {
    const file = raw as Partial<ShaderFile> | undefined;
    if (!file || typeof file.source !== 'string') continue;

    const wanted = typeof file.name === 'string' && file.name.trim() ? file.name : 'untitled.glsl';
    const name = uniqueName(wanted, taken);
    taken.add(name);

    files.push({
      id: typeof file.id === 'string' && file.id ? file.id : newId('file'),
      name,
      source: file.source,
    });
  }

  return files;
}

function nextFree(taken: ReadonlySet<BufferSlot>): BufferSlot | null {
  return BUFFER_SLOTS.find((slot) => !taken.has(slot)) ?? null;
}
