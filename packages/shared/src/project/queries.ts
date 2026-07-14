import { BUFFER_SLOTS, type BufferSlot, type RenderPass, type ShaderFile, type ShaderProject } from './types';

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

export function displayPasses(project: ShaderProject): RenderPass[] {
  const common = commonPass(project);
  return [imagePass(project), ...(common ? [common] : []), ...bufferPasses(project)];
}

export function findFile(project: ShaderProject, id: string): ShaderFile | null {
  return project.files.find((entry) => entry.id === id) ?? null;
}

export function fileNames(project: ShaderProject): string[] {
  return project.files.map((file) => file.name);
}

export function freeSlot(project: ShaderProject): BufferSlot | null {
  const taken = new Set(bufferPasses(project).map((pass) => pass.slot));
  return BUFFER_SLOTS.find((slot) => !taken.has(slot)) ?? null;
}
