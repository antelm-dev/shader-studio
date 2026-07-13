/**
 * The multi-file, multi-pass shader document.
 *
 * A shader in the studio used to be one fragment and one vertex source. It is
 * now a *project*: a set of render passes (an Image pass, an optional Common
 * pass of shared code, and up to four buffers that render to textures) plus any
 * number of plain source files that passes can `#include`.
 *
 * Everything here is plain data and pure functions — no Angular, no DOM, no
 * three.js, no Node. The store mutates projects through these operations, the
 * renderer reads the graph they describe, and the tests exercise both without
 * standing anything up. That separation is the whole point of the file: the
 * rules about what a project *is* live in one place, and the three layers that
 * care about it (editor state, persistence, rendering) each read them rather
 * than reimplementing them.
 */

import { DEFAULT_TEXTURE_CHANNEL, type TextureFilterMode, type TextureWrapMode } from './model';

/** Bumped when a stored project can no longer be read by the current code. */
export const PROJECT_VERSION = 1;

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * `common` is not rendered — it is prepended to every other pass's source.
 * `image` is the pass that ends up on screen, and there is always exactly one.
 */
export type PassKind = 'image' | 'common' | 'buffer';

export type BufferSlot = 'A' | 'B' | 'C' | 'D';

export const BUFFER_SLOTS: readonly BufferSlot[] = ['A', 'B', 'C', 'D'];

export const CHANNEL_COUNT = 4;

export type ChannelIndex = 0 | 1 | 2 | 3;

export const CHANNEL_INDICES: readonly ChannelIndex[] = [0, 1, 2, 3];

/**
 * What an `iChannel` slot samples.
 *
 * `feedback` is the interesting one. A binding to a buffer normally means "the
 * frame that buffer produced *this* tick", which is what makes it a dependency:
 * it has to render first. With `feedback` set it means "the frame it produced
 * last tick" instead, which is not a dependency at all — the texture already
 * exists. That is what lets a buffer sample itself (a trail, a fluid, a
 * reaction-diffusion) without describing a cycle, and it is why the dependency
 * graph below ignores feedback edges entirely.
 */
export type ChannelBinding =
  | { kind: 'none' }
  | { kind: 'buffer'; passId: string; feedback: boolean }
  | { kind: 'texture'; slot: ChannelIndex };

export type ChannelBindings = readonly [
  ChannelBinding,
  ChannelBinding,
  ChannelBinding,
  ChannelBinding,
];

export const NO_BINDING: ChannelBinding = { kind: 'none' };

export function emptyBindings(): ChannelBindings {
  return [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }];
}

/**
 * Legacy shaders sampled `iChannelN` straight from the shader record's texture
 * slot N. Migrating one has to reproduce exactly that, or every existing shader
 * with a texture in it comes back black.
 */
export function legacyTextureBindings(): ChannelBindings {
  return [
    { kind: 'texture', slot: 0 },
    { kind: 'texture', slot: 1 },
    { kind: 'texture', slot: 2 },
    { kind: 'texture', slot: 3 },
  ];
}

/** How big a buffer's render target is. The Image pass always fills the canvas. */
export type PassResolutionMode = 'viewport' | 'scaled' | 'fixed';

export interface PassResolution {
  mode: PassResolutionMode;
  /** Fraction of the viewport, when `mode` is `scaled`. */
  scale: number;
  /** Only meaningful when `mode` is `fixed`. */
  width: number;
  height: number;
}

export const DEFAULT_PASS_RESOLUTION: PassResolution = {
  mode: 'viewport',
  scale: 1,
  width: 512,
  height: 512,
};

export const RESOLUTION_LIMITS = {
  scale: { min: 0.05, max: 4 },
  size: { min: 1, max: 4096 },
} as const;

export interface RenderPass {
  id: string;
  kind: PassKind;
  name: string;
  /** `A`–`D` for buffers; `null` for the Image and Common passes. */
  slot: BufferSlot | null;
  /** Disabled buffers are not rendered and cannot be sampled. Image is always on. */
  enabled: boolean;
  source: string;
  channels: ChannelBindings;
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

/** A plain source file. Not a pass: it only reaches the GPU via `#include`. */
export interface ShaderFile {
  id: string;
  name: string;
  source: string;
}

export interface ShaderProject {
  version: number;
  /** One vertex shader for every pass — a full-screen quad has nothing to vary. */
  vertex: string;
  /** Image and Common are always present. Buffers are ordered as the user left them. */
  passes: RenderPass[];
  files: ShaderFile[];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Ids are opaque and never shown. They are generated rather than derived from
 * the name so that renaming a pass cannot invalidate the channel bindings that
 * point at it.
 */
let idCounter = 0;

export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** For tests that want reproducible ids. */
export function resetIdCounter(): void {
  idCounter = 0;
}

function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function imagePass(project: ShaderProject): RenderPass {
  const pass = project.passes.find((entry) => entry.kind === 'image');
  if (!pass) throw new Error('The project has no Image pass, which should be impossible.');
  return pass;
}

export function commonPass(project: ShaderProject): RenderPass | null {
  return project.passes.find((entry) => entry.kind === 'common') ?? null;
}

export function bufferPasses(project: ShaderProject): RenderPass[] {
  return project.passes.filter((entry) => entry.kind === 'buffer');
}

export function findPass(project: ShaderProject, id: string): RenderPass | null {
  return project.passes.find((entry) => entry.id === id) ?? null;
}

/**
 * The passes in the order the tab bar shows them: the output first, then the
 * code every pass shares, then the buffers in whatever order the user dragged
 * them into.
 *
 * Display order is derived rather than stored so that nothing else has to keep
 * `passes` in a particular shape. The array's only ordering duty is the
 * *relative* order of the buffers, which is what `movePass` rewrites.
 */
export function displayPasses(project: ShaderProject): RenderPass[] {
  const common = commonPass(project);
  return [imagePass(project), ...(common ? [common] : []), ...bufferPasses(project)];
}

export function findFile(project: ShaderProject, id: string): ShaderFile | null {
  return project.files.find((entry) => entry.id === id) ?? null;
}

/** The name a `#include` would use to reach this pass or file. */
export function fileNames(project: ShaderProject): string[] {
  return project.files.map((file) => file.name);
}

/** A buffer's free slot, or `null` when all four are taken. */
export function freeSlot(project: ShaderProject): BufferSlot | null {
  const taken = new Set(bufferPasses(project).map((pass) => pass.slot));
  return BUFFER_SLOTS.find((slot) => !taken.has(slot)) ?? null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const DEFAULT_VERTEX = `varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const DEFAULT_COMMON = `// Shared by every pass. Anything declared here is available in
// the Image pass and in every buffer, without an #include.

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
`;

export function defaultBufferSource(slot: BufferSlot): string {
  return `precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

// Buffer ${slot} renders to a texture. Bind it to an iChannel of another pass
// (or of this one, with feedback, to read the frame you drew last tick).
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution;
  gl_FragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`;
}

export function defaultFileSource(name: string): string {
  return `// ${name}
// Reach this from a pass with:  #include "${name}"
`;
}

// ---------------------------------------------------------------------------
// Construction and migration
// ---------------------------------------------------------------------------

function makePass(
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

/**
 * Turn a single-shader record into a project.
 *
 * This is the compatibility hinge for every shader that existed before passes
 * did: the fragment becomes the Image pass, the vertex becomes the project's,
 * and the four texture slots are bound to the four channels exactly as the old
 * engine bound them. A migrated project renders the same pixels as the record
 * it came from — the Common pass it gains is empty, and an empty Common
 * contributes nothing.
 */
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

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

export function addFile(project: ShaderProject, name?: string): ShaderProject {
  const chosen = uniqueName(name?.trim() || 'untitled.glsl', fileNames(project));
  const file: ShaderFile = {
    id: newId('file'),
    name: chosen,
    source: defaultFileSource(chosen),
  };
  return { ...project, files: [...project.files, file] };
}

export function renameFile(project: ShaderProject, id: string, name: string): ShaderProject {
  const trimmed = name.trim();
  if (!trimmed) return project;

  const others = project.files.filter((file) => file.id !== id).map((file) => file.name);
  const chosen = uniqueName(trimmed, others);

  return {
    ...project,
    files: project.files.map((file) => (file.id === id ? { ...file, name: chosen } : file)),
  };
}

export function duplicateFile(project: ShaderProject, id: string): ShaderProject {
  const index = project.files.findIndex((file) => file.id === id);
  if (index < 0) return project;

  const source = project.files[index];
  const copy: ShaderFile = {
    id: newId('file'),
    name: uniqueName(`${source.name} copy`, fileNames(project)),
    source: source.source,
  };

  const files = [...project.files];
  files.splice(index + 1, 0, copy);
  return { ...project, files };
}

export function removeFile(project: ShaderProject, id: string): ShaderProject {
  return { ...project, files: project.files.filter((file) => file.id !== id) };
}

export function setFileSource(project: ShaderProject, id: string, source: string): ShaderProject {
  return {
    ...project,
    files: project.files.map((file) => (file.id === id ? { ...file, source } : file)),
  };
}

export function moveFile(project: ShaderProject, id: string, toIndex: number): ShaderProject {
  return { ...project, files: reorder(project.files, id, toIndex) };
}

// ---------------------------------------------------------------------------
// Pass operations
// ---------------------------------------------------------------------------

/**
 * Add a buffer in the first free slot. Returns the project unchanged when all
 * four are taken — Shadertoy's limit, and the one the `iChannel` model implies.
 */
export function addBuffer(project: ShaderProject): ShaderProject {
  const slot = freeSlot(project);
  if (!slot) return project;

  const pass = makePass({
    kind: 'buffer',
    name: `Buffer ${slot}`,
    slot,
    source: defaultBufferSource(slot),
  });

  return { ...project, passes: [...project.passes, pass] };
}

/**
 * Copy a buffer into the next free slot, bindings and settings included.
 *
 * A self-feedback binding is rewritten to point at the *copy*, not the original:
 * a duplicated trail buffer that kept reading the original's history would be a
 * silent alias, and the one thing a duplicate must be is independent.
 */
export function duplicatePass(project: ShaderProject, id: string): ShaderProject {
  const source = findPass(project, id);
  if (!source || source.kind !== 'buffer') return project;

  const slot = freeSlot(project);
  if (!slot) return project;

  const copyId = newId('buffer');
  const names = project.passes.map((pass) => pass.name);
  const copy = makePass({
    id: copyId,
    kind: 'buffer',
    name: uniqueName(`${source.name} copy`, names),
    slot,
    enabled: source.enabled,
    source: source.source,
    channels: source.channels.map((binding) =>
      binding.kind === 'buffer' && binding.passId === id
        ? { ...binding, passId: copyId }
        : { ...binding },
    ) as unknown as ChannelBindings,
    resolution: { ...source.resolution },
    filter: source.filter,
    wrap: source.wrap,
  });

  const passes = [...project.passes];
  const index = passes.findIndex((pass) => pass.id === id);
  passes.splice(index + 1, 0, copy);
  return { ...project, passes };
}

/**
 * Delete a buffer, and clear every binding that pointed at it.
 *
 * Leaving the bindings behind would turn one deletion into as many dangling
 * references as there were consumers, each of which would then have to be
 * reported as an error the user did not cause and cannot see the origin of.
 */
export function removePass(project: ShaderProject, id: string): ShaderProject {
  const pass = findPass(project, id);
  if (!pass || pass.kind !== 'buffer') return project;

  return {
    ...project,
    passes: project.passes
      .filter((entry) => entry.id !== id)
      .map((entry) => ({
        ...entry,
        channels: entry.channels.map((binding) =>
          binding.kind === 'buffer' && binding.passId === id ? NO_BINDING : binding,
        ) as unknown as ChannelBindings,
      })),
  };
}

export function renamePass(project: ShaderProject, id: string, name: string): ShaderProject {
  const trimmed = name.trim();
  if (!trimmed) return project;

  const others = project.passes.filter((pass) => pass.id !== id).map((pass) => pass.name);
  const chosen = uniqueName(trimmed, others);

  return {
    ...project,
    passes: project.passes.map((pass) => (pass.id === id ? { ...pass, name: chosen } : pass)),
  };
}

/** The Image pass cannot be switched off: something has to reach the screen. */
export function setPassEnabled(
  project: ShaderProject,
  id: string,
  enabled: boolean,
): ShaderProject {
  const pass = findPass(project, id);
  if (!pass || pass.kind === 'image') return project;

  return {
    ...project,
    passes: project.passes.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)),
  };
}

export function setPassSource(project: ShaderProject, id: string, source: string): ShaderProject {
  return {
    ...project,
    passes: project.passes.map((pass) => (pass.id === id ? { ...pass, source } : pass)),
  };
}

export function setVertexSource(project: ShaderProject, vertex: string): ShaderProject {
  return { ...project, vertex };
}

export function setPassResolution(
  project: ShaderProject,
  id: string,
  patch: Partial<PassResolution>,
): ShaderProject {
  return {
    ...project,
    passes: project.passes.map((pass) =>
      pass.id === id
        ? { ...pass, resolution: sanitizeResolution({ ...pass.resolution, ...patch }) }
        : pass,
    ),
  };
}

export function setPassSampling(
  project: ShaderProject,
  id: string,
  patch: { filter?: TextureFilterMode; wrap?: TextureWrapMode },
): ShaderProject {
  return {
    ...project,
    passes: project.passes.map((pass) => (pass.id === id ? { ...pass, ...patch } : pass)),
  };
}

export function setChannelBinding(
  project: ShaderProject,
  id: string,
  channel: ChannelIndex,
  binding: ChannelBinding,
): ShaderProject {
  return {
    ...project,
    passes: project.passes.map((pass) => {
      if (pass.id !== id) return pass;
      const channels = [...pass.channels] as ChannelBinding[];
      channels[channel] = binding;
      return { ...pass, channels: channels as unknown as ChannelBindings };
    }),
  };
}

/**
 * Reorder a buffer among the buffers.
 *
 * Only the buffers move: Image and Common are fixed points, and `toIndex` is an
 * index into `bufferPasses(project)` rather than into `passes`, so a caller
 * dragging the third buffer to the front does not have to know where the Common
 * pass happens to sit in the array.
 *
 * The order is presentational — the renderer takes its order from the
 * dependency graph, not from this array — but it is the order the tab bar shows
 * and the order a user reasons about, so it is worth preserving faithfully.
 */
export function movePass(project: ShaderProject, id: string, toIndex: number): ShaderProject {
  const buffers = bufferPasses(project);
  if (!buffers.some((pass) => pass.id === id)) return project;

  const reordered = reorder(buffers, id, toIndex);

  // Rebuild `passes`, putting the reordered buffers back into the slots the
  // buffers previously occupied and leaving everything else exactly where it was.
  let next = 0;
  return {
    ...project,
    passes: project.passes.map((pass) => (pass.kind === 'buffer' ? reordered[next++] : pass)),
  };
}

function reorder<T extends { id: string }>(items: readonly T[], id: string, toIndex: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return [...items];

  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, moved);
  return next;
}

// ---------------------------------------------------------------------------
// The dependency graph
// ---------------------------------------------------------------------------

export interface ProjectError {
  message: string;
  /** The pass the error belongs to, so the UI can point at its tab. */
  passId: string | null;
  channel: ChannelIndex | null;
}

export interface PassOrder {
  /** Enabled buffers in the order they must render, with the Image pass last. */
  order: RenderPass[];
  errors: ProjectError[];
}

const CHANNEL_LABEL = (channel: ChannelIndex): string => `iChannel${channel}`;

/**
 * Work out what has to render before what.
 *
 * The graph is over the enabled buffers plus the Image pass. An edge exists
 * from a pass to every buffer it samples *without* feedback — the frame it
 * needs is the one being drawn right now, so that buffer must go first. A
 * feedback binding is not an edge at all: it reads the previous frame, which is
 * already sitting in a texture, and treating it as one is what would make every
 * trail effect a "circular dependency".
 *
 * When the graph is broken — a dangling reference, a disabled buffer, a genuine
 * cycle — the order comes back with whatever could be ordered plus an error for
 * each problem. The renderer keeps showing the last good frame and the errors go
 * to the panel: a mis-wired channel is an editing mistake, not a crash.
 */
export function resolvePassOrder(project: ShaderProject): PassOrder {
  const errors: ProjectError[] = [];

  const image = imagePass(project);
  const enabled = bufferPasses(project).filter((pass) => pass.enabled);
  const nodes = [...enabled, image];
  const byId = new Map(nodes.map((pass) => [pass.id, pass]));

  // Every buffer, enabled or not, so a binding to a disabled one can be told
  // apart from a binding to one that no longer exists.
  const allBuffers = new Map(bufferPasses(project).map((pass) => [pass.id, pass]));

  const edges = new Map<string, string[]>(nodes.map((pass) => [pass.id, []]));

  for (const pass of nodes) {
    pass.channels.forEach((binding, index) => {
      if (binding.kind !== 'buffer') return;
      const channel = index as ChannelIndex;

      // The messages below do not name the pass they belong to: `passId` does
      // that, and every place one is shown — the tab, the settings panel, the
      // diagnostics list — already says which pass it is looking at. Naming it
      // again produced "Buffer A — Buffer A: iChannel0 samples itself".
      const target = allBuffers.get(binding.passId);
      if (!target) {
        errors.push({
          message: `${CHANNEL_LABEL(channel)} points at a buffer that no longer exists.`,
          passId: pass.id,
          channel,
        });
        return;
      }

      if (!target.enabled) {
        errors.push({
          message: `${CHANNEL_LABEL(channel)} samples “${target.name}”, which is disabled.`,
          passId: pass.id,
          channel,
        });
        return;
      }

      // Reads last frame's texture: nothing has to render first.
      if (binding.feedback) return;

      if (binding.passId === pass.id) {
        errors.push({
          message:
            `${CHANNEL_LABEL(channel)} samples itself. ` +
            `Turn on feedback to read the previous frame.`,
          passId: pass.id,
          channel,
        });
        return;
      }

      edges.get(pass.id)?.push(binding.passId);
    });
  }

  const order = topologicalOrder(nodes, edges, byId, errors);

  // The Image pass is the output: it is last by definition, not by dependency,
  // and a buffer that nothing samples must still render before it.
  const withoutImage = order.filter((pass) => pass.kind !== 'image');
  return { order: [...withoutImage, image], errors };
}

/**
 * Depth-first post-order, which yields dependencies before their dependents.
 * A node still on the stack when it is reached again closes a cycle, and the
 * stack itself is the cycle — which is what the message names.
 */
function topologicalOrder(
  nodes: readonly RenderPass[],
  edges: ReadonlyMap<string, string[]>,
  byId: ReadonlyMap<string, RenderPass>,
  errors: ProjectError[],
): RenderPass[] {
  const order: RenderPass[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const reported = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id)) return;

    if (onStack.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id]
        .map((entry) => byId.get(entry)?.name ?? entry)
        .join(' → ');
      // One error per cycle, not one per node that can see it.
      if (!reported.has(cycle)) {
        reported.add(cycle);
        errors.push({
          message:
            `Circular buffer dependency: ${cycle}. ` +
            `Break the loop, or turn on feedback so one of the channels reads the previous frame.`,
          passId: id,
          channel: null,
        });
      }
      return;
    }

    onStack.add(id);
    stack.push(id);

    for (const next of edges.get(id) ?? []) visit(next);

    stack.pop();
    onStack.delete(id);
    done.add(id);

    const pass = byId.get(id);
    if (pass) order.push(pass);
  };

  for (const node of nodes) visit(node.id);
  return order;
}

// ---------------------------------------------------------------------------
// Sanitizing what came back out of storage
// ---------------------------------------------------------------------------

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

/**
 * Read a project back out of storage, repairing anything that does not fit.
 *
 * Storage is not a trusted input: it survives across versions of this code, it
 * can be hand-edited, and a project that is *almost* right must not take the
 * app down with it. So every field is checked, the two passes that have to
 * exist are recreated if they do not, buffers land in real slots, and bindings
 * that point at passes which are no longer in the project are dropped rather
 * than left to fail later as a dangling reference the user never made.
 *
 * The fallbacks are the record's own sources, so the worst case — a project
 * that is unreadable rubbish — is a project that renders the shader the server
 * has, which is exactly where a legacy shader starts from anyway.
 */
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

  // Drop bindings to passes that did not survive the step above, so that a
  // repair never leaves behind a dangling reference the user never made.
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

/**
 * The stored order is preserved exactly — it is the order the user dragged the
 * buffer tabs into, and a save/reload that quietly re-sorted them would be a bug
 * you could only find by looking. What is *not* preserved is anything the rest
 * of the model relies on being true: a second Image pass, two buffers in one
 * slot, a fifth buffer.
 */
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

    // The slot *is* the identity the rest of the project binds through, so a
    // buffer that cannot get one is dropped rather than given a colliding one.
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
    // A duplicate name would make `#include` ambiguous, so storage cannot hold one.
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
