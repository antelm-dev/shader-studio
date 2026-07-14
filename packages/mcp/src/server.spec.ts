import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ShaderStudioController, RenderFrameOptions } from '@shader-studio/shared/controller';
import type {
  CompileResult,
  DocumentSnapshot,
  McpStateSnapshot,
  PatchResult,
  ProjectSnapshot,
  RenderFrameResult,
  SetParamsResult,
  TextEdit,
} from '@shader-studio/shared/mcp-protocol';
import type { ParamValue, Preset, ShaderSummary } from '@shader-studio/shared/model';

import { buildServer } from './server';

/**
 * Exercises the registered tools and resources through a real MCP `Client`
 * connected in-process — the SDK validates every tool's `structuredContent`
 * against its declared `outputSchema` on the way through, so a passing call
 * here is also proof the schema and the handler agree with each other.
 *
 * The controller is a fake, not the real `BridgeController`: this layer is
 * about the MCP registration (schemas, annotations, resources), not the
 * WebSocket wire, which `bridge.spec.ts` already covers.
 */

const EMPTY_STATE: McpStateSnapshot = {
  selectedId: 'demo',
  shaders: [],
  record: null,
  draft: null,
  controls: [],
  params: {},
  presets: [],
  activePresetId: null,
  dirty: false,
  hasErrors: false,
  diagnostics: [],
};

class FakeController implements ShaderStudioController {
  revision = 1;
  documents = new Map<string, string>([
    ['image', 'void main() { gl_FragColor = vec4(1.0); }'],
    ['@vertex', 'void main() { gl_Position = vec4(position, 1.0); }'],
  ]);

  async listShaders(): Promise<readonly ShaderSummary[]> {
    return [
      {
        id: 'demo',
        name: 'Demo',
        description: '',
        updatedAt: '2024-01-01T00:00:00.000Z',
        controlCount: 0,
        presetCount: 0,
        thumbnail: null,
      },
    ];
  }

  async selectShader(): Promise<McpStateSnapshot> {
    return EMPTY_STATE;
  }

  async getState(): Promise<McpStateSnapshot> {
    return EMPTY_STATE;
  }

  async getProject(): Promise<ProjectSnapshot> {
    return {
      shaderId: 'demo',
      name: 'Demo',
      revision: this.revision,
      dirty: false,
      documents: [...this.documents.entries()].map(([id, source]) => ({
        id,
        kind: id === '@vertex' ? ('vertex' as const) : ('pass' as const),
        name: id,
        sourceLength: source.length,
      })),
      controls: [],
      params: {},
      presets: [],
      activePresetId: null,
      render: { bloom: { enabled: false, strength: 0.3, radius: 0.5, threshold: 0.85 } },
      diagnostics: [],
      hasErrors: false,
    };
  }

  async getDocument(documentId: string): Promise<DocumentSnapshot> {
    const source = this.documents.get(documentId);
    if (source === undefined) throw new Error(`Unknown document "${documentId}"`);
    return {
      id: documentId,
      kind: documentId === '@vertex' ? 'vertex' : 'pass',
      name: documentId,
      source,
      revision: this.revision,
      diagnostics: [],
    };
  }

  async applyPatch(
    _shaderId: string,
    baseRevision: number,
    edits: readonly TextEdit[],
  ): Promise<PatchResult> {
    if (baseRevision !== this.revision) {
      throw new Error(`stale: current revision is ${this.revision}`);
    }
    for (const edit of edits) {
      const current = this.documents.get(edit.documentId);
      if (current === undefined) throw new Error(`Unknown document "${edit.documentId}"`);
      this.documents.set(
        edit.documentId,
        current.slice(0, edit.start) + edit.text + current.slice(edit.end),
      );
    }
    this.revision += 1;
    return { revision: this.revision, diagnostics: [] };
  }

  async setParams(params: Record<string, ParamValue>): Promise<SetParamsResult> {
    const applied: string[] = [];
    const errors: Record<string, string> = {};
    for (const key of Object.keys(params)) {
      if (key === 'bogus') {
        errors[key] = `Unknown control "${key}".`;
        continue;
      }
      applied.push(key);
    }
    return { applied, errors, params };
  }

  async compileProject(): Promise<CompileResult> {
    return { revision: this.revision, diagnostics: [], hasErrors: false };
  }

  async renderFrame(options: RenderFrameOptions): Promise<RenderFrameResult> {
    return {
      base64: 'ZmFrZQ==',
      mimeType: 'image/png',
      width: options.width ?? 512,
      height: options.height ?? 512,
      time: options.time ?? 0,
    };
  }

  async saveProject(): Promise<McpStateSnapshot> {
    return EMPTY_STATE;
  }
  async setFragment(): Promise<McpStateSnapshot['diagnostics']> {
    return [];
  }
  async setVertex(): Promise<McpStateSnapshot['diagnostics']> {
    return [];
  }
  async setControls(): Promise<McpStateSnapshot['diagnostics']> {
    return [];
  }
  async setParam(): Promise<Record<string, ParamValue>> {
    return {};
  }
  async resetParams(): Promise<Record<string, ParamValue>> {
    return {};
  }
  async revert(): Promise<McpStateSnapshot> {
    return EMPTY_STATE;
  }
  async getDiagnostics(): Promise<McpStateSnapshot['diagnostics']> {
    return [];
  }
  async screenshot() {
    return { base64: 'ZmFrZQ==', mimeType: 'image/png' as const };
  }
  async listPresets(): Promise<readonly Preset[]> {
    return [];
  }
  async applyPreset(): Promise<McpStateSnapshot> {
    return EMPTY_STATE;
  }
  async savePreset(): Promise<readonly Preset[]> {
    return [];
  }
  async deletePreset(): Promise<readonly Preset[]> {
    return [];
  }
}

function textOf(content: Record<string, unknown> | undefined): string {
  return typeof content?.['text'] === 'string' ? content['text'] : '';
}

async function createLinkedClient(controller: ShaderStudioController): Promise<Client> {
  const server = buildServer(controller);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('mcp server', () => {
  let controller: FakeController;
  let client: Client;

  beforeEach(async () => {
    controller = new FakeController();
    client = await createLinkedClient(controller);
  });

  it('registers tools with output schemas and MCP annotations', async () => {
    const { tools } = await client.listTools();

    const save = tools.find((tool) => tool.name === 'save');
    expect(save?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(save?.outputSchema).toBeDefined();

    const getProject = tools.find((tool) => tool.name === 'get_project');
    expect(getProject?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(getProject?.outputSchema).toBeDefined();

    const patch = tools.find((tool) => tool.name === 'apply_shader_patch');
    expect(patch?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('list_shaders returns structured content matching its schema', async () => {
    const result = await client.callTool({ name: 'list_shaders', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ shaders: [{ id: 'demo' }] });
  });

  it('get_project describes documents by summary only, never their source', async () => {
    const result = await client.callTool({ name: 'get_project', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ shaderId: 'demo', revision: 1 });

    const project = result.structuredContent as { documents: Record<string, unknown>[] };
    expect(project.documents.length).toBeGreaterThan(0);
    expect(project.documents.every((doc) => !('source' in doc))).toBe(true);
  });

  it('get_document returns the full source for one document', async () => {
    const result = await client.callTool({
      name: 'get_document',
      arguments: { documentId: 'image' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      id: 'image',
      source: expect.stringContaining('gl_FragColor'),
    });
  });

  it('apply_shader_patch applies edits atomically and bumps the revision', async () => {
    const result = await client.callTool({
      name: 'apply_shader_patch',
      arguments: {
        shaderId: 'demo',
        baseRevision: 1,
        edits: [{ documentId: 'image', start: 0, end: 4, text: 'precision highp float;\nvoid' }],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ revision: 2 });
    expect(controller.documents.get('image')).toContain('precision highp float;');
  });

  it('apply_shader_patch reports an error instead of applying a stale revision', async () => {
    const result = await client.callTool({
      name: 'apply_shader_patch',
      arguments: {
        shaderId: 'demo',
        baseRevision: 999,
        edits: [{ documentId: 'image', start: 0, end: 0, text: '' }],
      },
    });

    expect(result.isError).toBe(true);
    // Nothing was applied — the fake's document is untouched.
    expect(controller.documents.get('image')).toBe('void main() { gl_FragColor = vec4(1.0); }');
  });

  it('set_params validates each key independently', async () => {
    const result = await client.callTool({
      name: 'set_params',
      arguments: { params: { speed: 1, bogus: true } },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      applied: ['speed'],
      errors: { bogus: expect.any(String) },
    });
  });

  it('compile_project returns the compiled revision and its diagnostics', async () => {
    const result = await client.callTool({ name: 'compile_project', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ revision: 1, hasErrors: false });
  });

  it('render_frame is deterministic for identical inputs', async () => {
    const first = await client.callTool({ name: 'render_frame', arguments: { time: 2 } });
    const second = await client.callTool({ name: 'render_frame', arguments: { time: 2 } });
    expect(first.structuredContent).toEqual(second.structuredContent);
  });

  it('reads every documented resource template', async () => {
    const library = await client.readResource({ uri: 'shader-studio://library' });
    expect(textOf(library.contents[0])).toContain('demo');

    const project = await client.readResource({ uri: 'shader-studio://shaders/demo/project' });
    expect(project.contents[0]?.mimeType).toBe('application/json');

    const document = await client.readResource({
      uri: 'shader-studio://shaders/demo/documents/image',
    });
    expect(textOf(document.contents[0])).toContain('gl_FragColor');

    const diagnostics = await client.readResource({
      uri: 'shader-studio://shaders/demo/diagnostics',
    });
    expect(diagnostics.contents[0]?.mimeType).toBe('application/json');

    const preview = await client.readResource({
      uri: 'shader-studio://shaders/demo/preview.png',
    });
    expect(preview.contents[0]?.mimeType).toBe('image/png');
  });
});
