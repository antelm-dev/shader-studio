import { bufferPasses, imagePass } from './queries';
import type { ChannelIndex, RenderPass, ShaderProject } from './types';

export interface ProjectError {
  message: string;
  passId: string | null;
  channel: ChannelIndex | null;
}

export interface PassOrder {
  order: RenderPass[];
  errors: ProjectError[];
}

const CHANNEL_LABEL = (channel: ChannelIndex): string => `iChannel${channel}`;

export function resolvePassOrder(project: ShaderProject): PassOrder {
  const errors: ProjectError[] = [];

  const image = imagePass(project);
  const enabled = bufferPasses(project).filter((pass) => pass.enabled);
  const nodes = [...enabled, image];
  const byId = new Map(nodes.map((pass) => [pass.id, pass]));

  const allBuffers = new Map(bufferPasses(project).map((pass) => [pass.id, pass]));

  const edges = new Map<string, string[]>(nodes.map((pass) => [pass.id, []]));

  for (const pass of nodes) {
    pass.channels.forEach((binding, index) => {
      if (binding.kind !== 'buffer') return;
      const channel = index as ChannelIndex;

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

  const withoutImage = order.filter((pass) => pass.kind !== 'image');
  return { order: [...withoutImage, image], errors };
}

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
