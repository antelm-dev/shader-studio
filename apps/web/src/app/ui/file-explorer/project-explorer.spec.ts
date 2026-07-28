import { CONFIG_DOC, VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import {
  createProject,
  makePass,
  resolvePassOrder,
  type ChannelBindings,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { describe, expect, it } from 'vitest';

import type { EditorDocument } from '../../workspace/shader-store';
import { filesGroupId, passChannelId, pipelineGroupId } from './node-id';
import {
  buildExplorerTree,
  collectSelectableDocIds,
  findExplorerNode,
  type ExplorerProjectionContext,
} from './project-explorer';

const IMAGE_ID = 'pass-image';
const COMMON_ID = 'pass-common';
const BUFFER_A_ID = 'pass-buffer-a';
const BUFFER_B_ID = 'pass-buffer-b';
const BUFFER_C_ID = 'pass-buffer-c';
const BUFFER_D_ID = 'pass-buffer-d';
const FILE_LIB_ID = 'file-lib';
const FILE_UTILS_ID = 'file-utils';

function defaultProject(): ShaderProject {
  return {
    version: 1,
    vertex: 'void main() {}',
    passes: [
      makePass({ id: IMAGE_ID, kind: 'image', name: 'Image', source: 'void mainImage() {}' }),
      makePass({ id: COMMON_ID, kind: 'common', name: 'Common', source: '' }),
    ],
    files: [],
  };
}

function fullProject(): ShaderProject {
  const channels: ChannelBindings = [
    { kind: 'texture', slot: 0 },
    { kind: 'buffer', passId: BUFFER_A_ID, feedback: false },
    { kind: 'buffer', passId: BUFFER_B_ID, feedback: true },
    { kind: 'none' },
  ];

  return {
    version: 1,
    vertex: 'void main() {}',
    passes: [
      makePass({
        id: IMAGE_ID,
        kind: 'image',
        name: 'Image',
        source: 'void mainImage() {}',
        channels,
      }),
      makePass({ id: COMMON_ID, kind: 'common', name: 'Common', source: '' }),
      makePass({
        id: BUFFER_A_ID,
        kind: 'buffer',
        name: 'Buffer A',
        slot: 'A',
        source: '',
        enabled: true,
      }),
      makePass({
        id: BUFFER_B_ID,
        kind: 'buffer',
        name: 'Buffer B',
        slot: 'B',
        source: '',
        enabled: true,
      }),
      makePass({
        id: BUFFER_C_ID,
        kind: 'buffer',
        name: 'Buffer C',
        slot: 'C',
        source: '',
        enabled: false,
      }),
      makePass({
        id: BUFFER_D_ID,
        kind: 'buffer',
        name: 'Buffer D',
        slot: 'D',
        source: '',
        enabled: false,
      }),
    ],
    files: [
      { id: FILE_LIB_ID, name: 'lib.glsl', source: '' },
      { id: FILE_UTILS_ID, name: 'utils.glsl', source: '' },
    ],
  };
}

function documentsFromProject(project: ShaderProject, controlsText = '[]'): EditorDocument[] {
  const orderedPasses = [
    project.passes.find((p) => p.kind === 'image')!,
    ...project.passes.filter((p) => p.kind === 'common'),
    ...project.passes.filter((p) => p.kind === 'buffer'),
  ];

  return [
    ...orderedPasses.map(
      (pass): EditorDocument => ({
        id: pass.id,
        kind: 'pass',
        name: pass.name,
        language: 'glsl',
        source: pass.source,
        passKind: pass.kind,
        slot: pass.slot,
        enabled: pass.enabled,
      }),
    ),
    ...project.files.map(
      (file): EditorDocument => ({
        id: file.id,
        kind: 'file',
        name: file.name,
        language: 'glsl',
        source: file.source,
      }),
    ),
    {
      id: VERTEX_DOC,
      kind: 'vertex',
      name: 'Vertex',
      language: 'glsl',
      source: project.vertex,
    },
    {
      id: CONFIG_DOC,
      kind: 'config',
      name: 'Config',
      language: 'json',
      source: controlsText,
    },
  ];
}

function baseContext(
  overrides: Partial<ExplorerProjectionContext> = {},
): ExplorerProjectionContext {
  const project = overrides.project ?? defaultProject();
  const documents = overrides.documents ?? documentsFromProject(project);
  const renderOrder = overrides.renderOrder ?? resolvePassOrder(project).order;

  return {
    view: 'files',
    loading: false,
    project,
    documents,
    activeDocId: IMAGE_ID,
    dirty: false,
    compiling: new Set(),
    errorCountFor: () => 0,
    renderOrder,
    canAddBuffer: true,
    ...overrides,
  };
}

function childNames(tree: ReturnType<typeof buildExplorerTree>, groupId: string): string[] {
  const group = findExplorerNode(tree, groupId);
  expect(group).toBeDefined();
  return group!.children.map((node) => node.name ?? node.labelKey ?? node.id);
}

describe('buildExplorerTree', () => {
  describe('empty and missing states', () => {
    it('returns loading for a loading store', () => {
      const tree = buildExplorerTree(baseContext({ loading: true, documents: [] }));
      expect(tree.emptyReason).toBe('loading');
      expect(tree.nodes).toEqual([]);
    });

    it('returns no-project when the project is absent', () => {
      const tree = buildExplorerTree(baseContext({ project: null, documents: [] }));
      expect(tree.emptyReason).toBe('no-project');
      expect(tree.nodes).toEqual([]);
    });

    it('returns no-documents when the document list is empty', () => {
      const tree = buildExplorerTree(baseContext({ project: defaultProject(), documents: [] }));
      expect(tree.emptyReason).toBe('no-documents');
      expect(tree.nodes).toEqual([]);
    });
  });

  describe('files view', () => {
    it('builds the default Image/Common project', () => {
      const tree = buildExplorerTree(baseContext({ view: 'files' }));

      expect(tree.emptyReason).toBeUndefined();
      expect(childNames(tree, filesGroupId('passes'))).toEqual(['Image', 'Common']);
      expect(findExplorerNode(tree, filesGroupId('includes'))).toBeUndefined();
      expect(childNames(tree, filesGroupId('project'))).toEqual(['Vertex', 'Config']);
    });

    it('orders four buffers in displayPasses order', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({ view: 'files', project, documents: documentsFromProject(project) }),
      );

      expect(childNames(tree, filesGroupId('passes'))).toEqual([
        'Image',
        'Common',
        'Buffer A',
        'Buffer B',
        'Buffer C',
        'Buffer D',
      ]);
    });

    it('includes source files, vertex, and config with distinct kinds', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({ view: 'files', project, documents: documentsFromProject(project) }),
      );

      expect(childNames(tree, filesGroupId('includes'))).toEqual(['lib.glsl', 'utils.glsl']);

      const vertex = findExplorerNode(tree, VERTEX_DOC);
      const config = findExplorerNode(tree, CONFIG_DOC);
      const image = findExplorerNode(tree, IMAGE_ID);
      const buffer = findExplorerNode(tree, BUFFER_A_ID);
      const file = findExplorerNode(tree, FILE_LIB_ID);

      expect(vertex?.kind).toBe('vertex');
      expect(config?.kind).toBe('config');
      expect(image?.kind).toBe('image-pass');
      expect(buffer?.kind).toBe('buffer-pass');
      expect(file?.kind).toBe('source-file');
    });
  });

  describe('pipeline view', () => {
    it('places Common in its own group and execution in render order', () => {
      const project = fullProject();
      const renderOrder = resolvePassOrder(project).order;
      const tree = buildExplorerTree(
        baseContext({
          view: 'pipeline',
          project,
          documents: documentsFromProject(project),
          renderOrder,
        }),
      );

      expect(childNames(tree, pipelineGroupId('common'))).toEqual(['Common']);
      expect(childNames(tree, pipelineGroupId('execution'))).toEqual(
        renderOrder.map((pass) => pass.name),
      );
    });

    it('lists disabled buffers in slot order', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'pipeline',
          project,
          documents: documentsFromProject(project),
          renderOrder: resolvePassOrder(project).order,
        }),
      );

      expect(childNames(tree, pipelineGroupId('disabled'))).toEqual(['Buffer C', 'Buffer D']);
    });

    it('represents texture, buffer, none, and feedback channel bindings', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'pipeline',
          project,
          documents: documentsFromProject(project),
          renderOrder: resolvePassOrder(project).order,
        }),
      );

      const image = findExplorerNode(tree, IMAGE_ID)!;
      const channelsGroup = image.children[0];
      expect(channelsGroup.labelKey).toBe('explorer.group.channels');

      const ch0 = channelsGroup.children[0];
      const ch1 = channelsGroup.children[1];
      const ch2 = channelsGroup.children[2];
      const ch3 = channelsGroup.children[3];

      expect(ch0.children[0].kind).toBe('channel-texture');
      expect(ch0.children[0].textureSlot).toBe(0);
      expect(ch1.children[0].kind).toBe('channel-buffer');
      expect(ch1.children[0].channelTargetPassId).toBe(BUFFER_A_ID);
      expect(ch2.children[0].kind).toBe('channel-feedback');
      expect(ch2.children[0].channelTargetPassId).toBe(BUFFER_B_ID);
      expect(ch3.children[0].kind).toBe('channel-none');
    });

    it('uses fixed iChannel0–3 channel row ids', () => {
      const project = defaultProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'pipeline',
          project,
          documents: documentsFromProject(project),
          renderOrder: resolvePassOrder(project).order,
        }),
      );

      const image = findExplorerNode(tree, IMAGE_ID)!;
      const channels = image.children[0].children;
      expect(channels.map((node) => node.id)).toEqual([
        passChannelId(IMAGE_ID, 0),
        passChannelId(IMAGE_ID, 1),
        passChannelId(IMAGE_ID, 2),
        passChannelId(IMAGE_ID, 3),
      ]);
    });
  });

  describe('status', () => {
    it('marks active, dirty, compiling, and error state on compilable docs', () => {
      const project = defaultProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents: documentsFromProject(project),
          activeDocId: COMMON_ID,
          dirty: true,
          compiling: new Set([COMMON_ID]),
          errorCountFor: (id) => (id === VERTEX_DOC ? 2 : 0),
        }),
      );

      const common = findExplorerNode(tree, COMMON_ID)!;
      const vertex = findExplorerNode(tree, VERTEX_DOC)!;

      expect(common.status).toMatchObject({
        active: true,
        dirty: true,
        compiling: true,
        errorCount: 0,
        disabled: false,
      });
      expect(vertex.status).toMatchObject({
        active: false,
        dirty: true,
        compiling: false,
        errorCount: 2,
      });
    });

    it('marks disabled buffers and keeps them selectable', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents: documentsFromProject(project),
        }),
      );

      const disabled = findExplorerNode(tree, BUFFER_C_ID)!;
      expect(disabled.status.disabled).toBe(true);
      expect(disabled.capabilities.selectable).toBe(true);
    });

    it('never marks source files dirty or with error counts', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents: documentsFromProject(project),
          dirty: true,
          errorCountFor: () => 5,
        }),
      );

      const file = findExplorerNode(tree, FILE_LIB_ID)!;
      expect(file.status).toMatchObject({ dirty: false, errorCount: 0, compiling: false });
    });
  });

  describe('capabilities', () => {
    it('allows rename/duplicate/delete/reorder only on buffers and files', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents: documentsFromProject(project),
          canAddBuffer: true,
        }),
      );

      const image = findExplorerNode(tree, IMAGE_ID)!.capabilities;
      const buffer = findExplorerNode(tree, BUFFER_A_ID)!.capabilities;
      const file = findExplorerNode(tree, FILE_LIB_ID)!.capabilities;

      expect(image).toMatchObject({
        rename: false,
        duplicate: false,
        delete: false,
        reorder: false,
        toggleEnabled: false,
      });
      expect(buffer).toMatchObject({
        rename: true,
        duplicate: true,
        delete: true,
        reorder: true,
        toggleEnabled: true,
      });
      expect(file).toMatchObject({
        rename: true,
        duplicate: true,
        delete: true,
        reorder: true,
        toggleEnabled: false,
      });
    });

    it('disables buffer duplicate when no free slot remains', () => {
      const project = fullProject();
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents: documentsFromProject(project),
          canAddBuffer: false,
        }),
      );

      expect(findExplorerNode(tree, BUFFER_A_ID)!.capabilities.duplicate).toBe(false);
      expect(findExplorerNode(tree, FILE_LIB_ID)!.capabilities.duplicate).toBe(true);
    });
  });

  describe('determinism and document integrity', () => {
    it('produces identical trees across repeated builds', () => {
      const project = fullProject();
      const ctx = baseContext({
        view: 'pipeline',
        project,
        documents: documentsFromProject(project),
        renderOrder: resolvePassOrder(project).order,
      });

      const first = buildExplorerTree(ctx);
      const second = buildExplorerTree(ctx);
      expect(first).toEqual(second);
    });

    it('maps selectable nodes to id === docId with no dangling references', () => {
      const project = fullProject();
      const documents = documentsFromProject(project);
      const docIds = new Set(documents.map((doc) => doc.id));
      const tree = buildExplorerTree(
        baseContext({
          view: 'pipeline',
          project,
          documents,
          renderOrder: resolvePassOrder(project).order,
        }),
      );

      const selectableIds = collectSelectableDocIds(tree);
      expect(selectableIds.length).toBeGreaterThan(0);
      for (const id of selectableIds) {
        expect(docIds.has(id)).toBe(true);
        const node = findExplorerNode(tree, id);
        expect(node?.id).toBe(node?.docId);
      }
    });
  });

  describe('legacy createProject helper', () => {
    it('works with migrateLegacyProject output', () => {
      const project = createProject('void mainImage() {}', 'void main() {}');
      const documents = documentsFromProject(project);
      const tree = buildExplorerTree(
        baseContext({
          view: 'files',
          project,
          documents,
          activeDocId: project.passes.find((p) => p.kind === 'image')!.id,
          renderOrder: resolvePassOrder(project).order,
        }),
      );

      expect(tree.emptyReason).toBeUndefined();
      expect(collectSelectableDocIds(tree)).toContain(VERTEX_DOC);
      expect(collectSelectableDocIds(tree)).toContain(CONFIG_DOC);
    });
  });
});

describe('collectSelectableDocIds', () => {
  it('returns an empty list for empty trees', () => {
    expect(collectSelectableDocIds({ view: 'files', nodes: [], emptyReason: 'loading' })).toEqual(
      [],
    );
  });
});
