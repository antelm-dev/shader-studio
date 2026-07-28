import { CONFIG_DOC, VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import {
  BUFFER_SLOTS,
  CHANNEL_INDICES,
  displayPasses,
  type ChannelBinding,
  type ChannelIndex,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';

import type { EditorDocument } from '../../workspace/shader-store';
import {
  INFORMATIONAL_CAPABILITIES,
  INACTIVE_STATUS,
  type ExplorerNode,
  type ExplorerNodeCapabilities,
  type ExplorerNodeStatus,
  type ExplorerSelectableKind,
  type ExplorerTree,
  type ExplorerViewMode,
} from './contract';
import type { TranslationKey } from '../../i18n/keys';
import {
  assertSelectableNodeId,
  channelBindingId,
  filesGroupId,
  passChannelId,
  passChannelsGroupId,
  pipelineGroupId,
} from './node-id';

/** Pure inputs for building an explorer tree (no Angular / store coupling). */
export interface ExplorerProjectionContext {
  view: ExplorerViewMode;
  loading?: boolean;
  project: ShaderProject | null;
  documents: readonly EditorDocument[];
  activeDocId: string | null;
  dirty: boolean;
  compiling: ReadonlySet<string>;
  errorCountFor: (docId: string) => number;
  renderOrder: readonly RenderPass[];
  canAddBuffer: boolean;
}

export function buildExplorerTree(ctx: ExplorerProjectionContext): ExplorerTree {
  if (ctx.loading) {
    return { view: ctx.view, nodes: [], emptyReason: 'loading' };
  }
  if (!ctx.project) {
    return { view: ctx.view, nodes: [], emptyReason: 'no-project' };
  }
  if (ctx.documents.length === 0) {
    return { view: ctx.view, nodes: [], emptyReason: 'no-documents' };
  }

  const docById = new Map(ctx.documents.map((doc) => [doc.id, doc]));
  const nodes =
    ctx.view === 'files' ? buildFilesView(ctx, docById) : buildPipelineView(ctx, docById);

  return { view: ctx.view, nodes };
}

function buildFilesView(
  ctx: ExplorerProjectionContext,
  docById: ReadonlyMap<string, EditorDocument>,
): ExplorerNode[] {
  const project = ctx.project!;
  const nodes: ExplorerNode[] = [];

  const passChildren = displayPasses(project)
    .map((pass) => docById.get(pass.id))
    .filter((doc): doc is EditorDocument => doc !== undefined)
    .map((doc) => buildSelectableNode(doc, 1, ctx));

  nodes.push(
    buildGroupNode({
      id: filesGroupId('passes'),
      labelKey: 'explorer.group.passes',
      depth: 0,
      children: passChildren,
      defaultExpanded: true,
    }),
  );

  if (project.files.length > 0) {
    const fileChildren = project.files
      .map((file) => docById.get(file.id))
      .filter((doc): doc is EditorDocument => doc !== undefined)
      .map((doc) => buildSelectableNode(doc, 1, ctx));

    nodes.push(
      buildGroupNode({
        id: filesGroupId('includes'),
        labelKey: 'explorer.group.includes',
        depth: 0,
        children: fileChildren,
        defaultExpanded: true,
      }),
    );
  }

  const projectChildren = [VERTEX_DOC, CONFIG_DOC]
    .map((id) => docById.get(id))
    .filter((doc): doc is EditorDocument => doc !== undefined)
    .map((doc) => buildSelectableNode(doc, 1, ctx));

  nodes.push(
    buildGroupNode({
      id: filesGroupId('project'),
      labelKey: 'explorer.group.project',
      depth: 0,
      children: projectChildren,
      defaultExpanded: true,
    }),
  );

  return nodes;
}

function buildPipelineView(
  ctx: ExplorerProjectionContext,
  docById: ReadonlyMap<string, EditorDocument>,
): ExplorerNode[] {
  const project = ctx.project!;
  const nodes: ExplorerNode[] = [];
  const passNameById = new Map(displayPasses(project).map((pass) => [pass.id, pass.name]));

  const common = displayPasses(project).find((pass) => pass.kind === 'common');
  if (common) {
    const doc = docById.get(common.id);
    if (doc) {
      nodes.push(
        buildGroupNode({
          id: pipelineGroupId('common'),
          labelKey: 'explorer.group.common',
          depth: 0,
          children: [buildPassWithChannels(common, doc, 1, ctx, passNameById)],
          defaultExpanded: true,
        }),
      );
    }
  }

  const executionChildren = ctx.renderOrder
    .map((pass) => {
      const doc = docById.get(pass.id);
      return doc ? buildPassWithChannels(pass, doc, 1, ctx, passNameById) : null;
    })
    .filter((node): node is ExplorerNode => node !== null);

  nodes.push(
    buildGroupNode({
      id: pipelineGroupId('execution'),
      labelKey: 'explorer.group.execution',
      depth: 0,
      children: executionChildren,
      defaultExpanded: true,
    }),
  );

  const disabledBuffers = displayPasses(project)
    .filter((pass) => pass.kind === 'buffer' && !pass.enabled)
    .sort((a, b) => BUFFER_SLOTS.indexOf(a.slot!) - BUFFER_SLOTS.indexOf(b.slot!));

  if (disabledBuffers.length > 0) {
    const disabledChildren = disabledBuffers
      .map((pass) => {
        const doc = docById.get(pass.id);
        return doc ? buildPassWithChannels(pass, doc, 1, ctx, passNameById) : null;
      })
      .filter((node): node is ExplorerNode => node !== null);

    nodes.push(
      buildGroupNode({
        id: pipelineGroupId('disabled'),
        labelKey: 'explorer.group.disabledBuffers',
        depth: 0,
        children: disabledChildren,
        defaultExpanded: true,
      }),
    );
  }

  return nodes;
}

function buildPassWithChannels(
  pass: RenderPass,
  doc: EditorDocument,
  depth: number,
  ctx: ExplorerProjectionContext,
  passNameById: ReadonlyMap<string, string>,
): ExplorerNode {
  const channelsGroup = buildGroupNode({
    id: passChannelsGroupId(pass.id),
    labelKey: 'explorer.group.channels',
    depth: depth + 1,
    children: CHANNEL_INDICES.map((channel) =>
      buildChannelNode(pass, channel, depth + 2, passNameById),
    ),
    defaultExpanded: false,
    icon: 'tune',
  });

  return buildSelectableNode(doc, depth, ctx, [channelsGroup]);
}

function buildChannelNode(
  pass: RenderPass,
  channel: ChannelIndex,
  depth: number,
  passNameById: ReadonlyMap<string, string>,
): ExplorerNode {
  const binding = pass.channels[channel];
  return {
    id: passChannelId(pass.id, channel),
    kind: 'channel',
    labelKey: `explorer.channel.${channel}`,
    depth,
    channelIndex: channel,
    children: [buildBindingNode(pass, channel, binding, depth + 1, passNameById)],
    capabilities: INFORMATIONAL_CAPABILITIES,
    status: INACTIVE_STATUS,
    icon: 'input',
  };
}

function buildBindingNode(
  pass: RenderPass,
  channel: ChannelIndex,
  binding: ChannelBinding,
  depth: number,
  passNameById: ReadonlyMap<string, string>,
): ExplorerNode {
  switch (binding.kind) {
    case 'none':
      return {
        id: channelBindingId(pass.id, channel, { kind: 'none' }),
        kind: 'channel-none',
        labelKey: 'explorer.binding.none',
        depth,
        channelIndex: channel,
        children: [],
        capabilities: INFORMATIONAL_CAPABILITIES,
        status: INACTIVE_STATUS,
        icon: 'link_off',
      };
    case 'texture':
      return {
        id: channelBindingId(pass.id, channel, {
          kind: 'texture',
          textureSlot: binding.slot,
        }),
        kind: 'channel-texture',
        labelKey: 'explorer.binding.texture',
        labelParams: { slot: binding.slot },
        depth,
        channelIndex: channel,
        textureSlot: binding.slot,
        children: [],
        capabilities: INFORMATIONAL_CAPABILITIES,
        status: INACTIVE_STATUS,
        icon: 'image',
      };
    case 'buffer':
      if (binding.feedback) {
        return {
          id: channelBindingId(pass.id, channel, {
            kind: 'feedback',
            targetId: binding.passId,
          }),
          kind: 'channel-feedback',
          labelKey: 'explorer.binding.feedback',
          labelParams: { name: targetLabel(passNameById, binding.passId) },
          depth,
          channelIndex: channel,
          channelTargetPassId: binding.passId,
          children: [],
          capabilities: INFORMATIONAL_CAPABILITIES,
          status: INACTIVE_STATUS,
          icon: 'replay',
        };
      }
      return {
        id: channelBindingId(pass.id, channel, {
          kind: 'buffer',
          targetId: binding.passId,
        }),
        kind: 'channel-buffer',
        labelKey: 'explorer.binding.buffer',
        labelParams: { name: targetLabel(passNameById, binding.passId) },
        depth,
        channelIndex: channel,
        channelTargetPassId: binding.passId,
        children: [],
        capabilities: INFORMATIONAL_CAPABILITIES,
        status: INACTIVE_STATUS,
        icon: 'layers',
      };
  }
}

function targetLabel(
  passNameById: ReadonlyMap<string, string>,
  passId: string,
): string | { kind: 'translation'; key: 'explorer.binding.missingTarget' } {
  return (
    passNameById.get(passId) ?? {
      kind: 'translation',
      key: 'explorer.binding.missingTarget',
    }
  );
}

function buildGroupNode(options: {
  id: string;
  labelKey: TranslationKey;
  depth: number;
  children: ExplorerNode[];
  defaultExpanded?: boolean;
  icon?: string;
}): ExplorerNode {
  return {
    id: options.id,
    kind: 'group',
    labelKey: options.labelKey,
    depth: options.depth,
    children: options.children,
    capabilities: INFORMATIONAL_CAPABILITIES,
    status: INACTIVE_STATUS,
    icon: options.icon ?? 'folder',
    defaultExpanded: options.defaultExpanded,
  };
}

function buildSelectableNode(
  doc: EditorDocument,
  depth: number,
  ctx: ExplorerProjectionContext,
  children: ExplorerNode[] = [],
): ExplorerNode {
  assertSelectableNodeId(doc.id);
  const kind = selectableKind(doc);
  return {
    id: doc.id,
    kind,
    docId: doc.id,
    name: doc.name,
    slot: doc.slot ?? null,
    depth,
    children,
    capabilities: buildCapabilities(doc, ctx.canAddBuffer),
    status: buildStatus(doc, kind, ctx),
    icon: iconForDoc(doc),
  };
}

function selectableKind(doc: EditorDocument): ExplorerSelectableKind {
  if (doc.kind === 'file') return 'source-file';
  if (doc.kind === 'vertex') return 'vertex';
  if (doc.kind === 'config') return 'config';
  switch (doc.passKind) {
    case 'image':
      return 'image-pass';
    case 'common':
      return 'common-pass';
    case 'buffer':
      return 'buffer-pass';
    default:
      throw new Error(`Unknown pass kind for document "${doc.id}"`);
  }
}

function isCompilableKind(kind: ExplorerSelectableKind): boolean {
  return kind !== 'source-file';
}

function buildCapabilities(doc: EditorDocument, canAddBuffer: boolean): ExplorerNodeCapabilities {
  const rename = doc.passKind === 'buffer' || doc.kind === 'file';
  const duplicate = (doc.passKind === 'buffer' && canAddBuffer) || doc.kind === 'file';
  const del = doc.passKind === 'buffer' || doc.kind === 'file';
  return {
    selectable: true,
    rename,
    duplicate,
    delete: del,
    reorder: rename,
    toggleEnabled: doc.passKind === 'buffer',
  };
}

function buildStatus(
  doc: EditorDocument,
  kind: ExplorerSelectableKind,
  ctx: ExplorerProjectionContext,
): ExplorerNodeStatus {
  const compilable = isCompilableKind(kind);
  return {
    active: doc.id === ctx.activeDocId,
    disabled: doc.passKind === 'buffer' && doc.enabled === false,
    dirty: compilable && ctx.dirty,
    compiling: compilable && ctx.compiling.has(doc.id),
    errorCount: compilable ? ctx.errorCountFor(doc.id) : 0,
  };
}

function iconForDoc(doc: EditorDocument): string {
  if (doc.kind === 'file') return 'description';
  if (doc.kind === 'vertex') return 'change_history';
  if (doc.kind === 'config') return 'data_object';
  switch (doc.passKind) {
    case 'image':
      return 'image';
    case 'common':
      return 'share';
    default:
      return 'layers';
  }
}

/** Walks the tree and returns every selectable document id. */
export function collectSelectableDocIds(tree: ExplorerTree): string[] {
  const ids: string[] = [];
  const visit = (nodes: readonly ExplorerNode[]): void => {
    for (const node of nodes) {
      if (node.docId) ids.push(node.docId);
      visit(node.children);
    }
  };
  visit(tree.nodes);
  return ids;
}

/** Depth-first search for a node by id. */
export function findExplorerNode(tree: ExplorerTree, id: string): ExplorerNode | undefined {
  const search = (nodes: readonly ExplorerNode[]): ExplorerNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const child = search(node.children);
      if (child) return child;
    }
    return undefined;
  };
  return search(tree.nodes);
}
