import type { TextureFilterMode, TextureWrapMode } from '../model';
import { defaultBufferSource, defaultFileSource } from './defaults';
import { makePass, newId, uniqueName } from './factory';
import { bufferPasses, fileNames, findPass, freeSlot } from './queries';
import { sanitizeResolution } from './sanitize';
import {
  NO_BINDING,
  type ChannelBinding,
  type ChannelBindings,
  type ChannelIndex,
  type PassResolution,
  type ShaderFile,
  type ShaderProject,
} from './types';

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

export function movePass(project: ShaderProject, id: string, toIndex: number): ShaderProject {
  const buffers = bufferPasses(project);
  if (!buffers.some((pass) => pass.id === id)) return project;

  const reordered = reorder(buffers, id, toIndex);

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
