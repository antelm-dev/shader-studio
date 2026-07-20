import { describe, expect, it } from 'vitest';

import { bufferPasses, commonPass, imagePass } from '../project/queries';
import { importShadertoyShader, type ShadertoyFetchResponse } from './shadertoy-api';

const API_URL = /\/api\/v1\/shaders\//;

// A syntactically valid 1x1 PNG (signature + IHDR + rest doesn't matter to `decodeImage`,
// which only reads the fixed-offset width/height out of the IHDR chunk).
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jsonResponse(body: unknown): ShadertoyFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function textureResponse(bytes: Uint8Array): ShadertoyFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  };
}

interface FakeInput {
  id: number;
  channel: number;
  ctype: string;
  src?: string;
}

function renderpass(
  type: string,
  name: string,
  code: string,
  outputId: number,
  inputs: FakeInput[] = [],
) {
  return { type, name, code, inputs, outputs: [{ id: outputId, channel: 0 }] };
}

function apiFetch(renderpasses: unknown[], textures: Record<string, Uint8Array> = {}) {
  return async (url: string): Promise<ShadertoyFetchResponse> => {
    if (API_URL.test(url)) {
      return jsonResponse({
        Shader: {
          info: { id: 'abcdef', name: 'Test Shader', description: 'desc', username: 'tester' },
          renderpass: renderpasses,
        },
      });
    }
    const match = Object.entries(textures).find(([path]) => url.endsWith(path));
    if (match) return textureResponse(match[1]);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const MAIN_IMAGE_SRC = 'void mainImage(out vec4 c, in vec2 uv) { c = texture2D(iChannel0, uv); }';

describe('importShadertoyShader', () => {
  it('maps a buffer chain, marking self-references as feedback', async () => {
    const passes = [
      renderpass('buffer', 'Buf A', MAIN_IMAGE_SRC, 257, [
        { id: 257, channel: 0, ctype: 'buffer' }, // reads itself -> feedback
      ]),
      renderpass('image', 'Image', MAIN_IMAGE_SRC, 4, [
        { id: 257, channel: 0, ctype: 'buffer' }, // reads Buffer A -> not feedback
      ]),
    ];

    const { payload, warnings } = await importShadertoyShader('abcdef', 'key', {
      fetch: apiFetch(passes),
    });

    const buffers = bufferPasses(payload.project);
    expect(buffers).toHaveLength(1);
    const bufA = buffers[0];
    const image = imagePass(payload.project);

    expect(bufA.channels[0]).toMatchObject({ kind: 'buffer', passId: bufA.id, feedback: true });
    expect(image.channels[0]).toMatchObject({ kind: 'buffer', passId: bufA.id, feedback: false });
    expect(warnings).toHaveLength(0);
  });

  it('keeps the Common pass source', async () => {
    const passes = [
      renderpass('common', 'Common', 'float shared() { return 1.0; }', 1),
      renderpass('image', 'Image', 'void mainImage(out vec4 c, in vec2 uv) { c = vec4(0.0); }', 4),
    ];

    const { payload } = await importShadertoyShader('abcdef', 'key', { fetch: apiFetch(passes) });

    const common = commonPass(payload.project);
    expect(common?.source).toContain('shared()');
  });

  it('de-dupes textures by URL and caps assignment at 4 slots', async () => {
    const png = pngBytes(4, 4);
    const inputs: FakeInput[] = [
      { id: 1, channel: 0, ctype: 'texture', src: '/media/a/one.png' },
      { id: 2, channel: 1, ctype: 'texture', src: '/media/a/one.png' }, // same URL, same slot
      { id: 3, channel: 2, ctype: 'texture', src: '/media/a/two.png' },
      { id: 4, channel: 3, ctype: 'texture', src: '/media/a/three.png' },
    ];
    const passes = [
      renderpass(
        'image',
        'Image',
        'void mainImage(out vec4 c, in vec2 uv) { c = vec4(0.0); }',
        4,
        inputs,
      ),
      renderpass('buffer', 'Buf A', MAIN_IMAGE_SRC, 257, [
        { id: 5, channel: 0, ctype: 'texture', src: '/media/a/four.png' },
      ]),
    ];

    const { payload, warnings } = await importShadertoyShader('abcdef', 'key', {
      fetch: apiFetch(passes, {
        'one.png': png,
        'two.png': png,
        'three.png': png,
        'four.png': png,
      }),
    });

    const image = imagePass(payload.project);
    expect(image.channels[0]).toEqual(image.channels[1]); // same texture -> same slot
    expect(image.channels[0]).toMatchObject({ kind: 'texture', slot: 0 });
    expect(image.channels[2]).toMatchObject({ kind: 'texture', slot: 1 });
    expect(image.channels[3]).toMatchObject({ kind: 'texture', slot: 2 });

    const bufA = bufferPasses(payload.project)[0];
    expect(bufA.channels[0]).toMatchObject({ kind: 'texture', slot: 3 });

    expect(payload.channels[0].data).toBeTruthy();
    expect(payload.channels[0].ext).toBe('png');
    expect(warnings.some((w) => w.includes('4 texture slots'))).toBe(false);
  });

  it('warns and leaves the channel unassigned past the 4th distinct texture', async () => {
    const png = pngBytes(2, 2);
    const inputs: FakeInput[] = [
      { id: 1, channel: 0, ctype: 'texture', src: '/media/a/a.png' },
      { id: 2, channel: 1, ctype: 'texture', src: '/media/a/b.png' },
      { id: 3, channel: 2, ctype: 'texture', src: '/media/a/c.png' },
      { id: 4, channel: 3, ctype: 'texture', src: '/media/a/d.png' },
    ];
    const passes = [
      renderpass(
        'image',
        'Image',
        'void mainImage(out vec4 c, in vec2 uv) { c = vec4(0.0); }',
        4,
        inputs,
      ),
      renderpass('buffer', 'Buf A', MAIN_IMAGE_SRC, 257, [
        { id: 5, channel: 0, ctype: 'texture', src: '/media/a/e.png' }, // 5th distinct texture
      ]),
    ];

    const { payload, warnings } = await importShadertoyShader('abcdef', 'key', {
      fetch: apiFetch(passes, {
        'a.png': png,
        'b.png': png,
        'c.png': png,
        'd.png': png,
        'e.png': png,
      }),
    });

    const bufA = bufferPasses(payload.project)[0];
    expect(bufA.channels[0]).toEqual({ kind: 'none' });
    expect(warnings.some((w) => w.includes('Only 4 texture slots'))).toBe(true);
  });

  it('drops sound and cubemap passes with a warning', async () => {
    const passes = [
      renderpass('image', 'Image', MAIN_IMAGE_SRC, 4),
      renderpass('sound', 'Sound', 'vec2 mainSound(int s, float t) { return vec2(0.0); }', 5),
      renderpass('cubemap', 'Cube A', MAIN_IMAGE_SRC, 6),
    ];

    const { payload, warnings } = await importShadertoyShader('abcdef', 'key', {
      fetch: apiFetch(passes),
    });

    expect(payload.project.passes.some((p) => p.name === 'Sound')).toBe(false);
    expect(payload.project.passes.some((p) => p.name === 'Cube A')).toBe(false);
    expect(warnings.some((w) => w.includes('sound pass "Sound"'))).toBe(true);
    expect(warnings.some((w) => w.includes('cubemap pass "Cube A"'))).toBe(true);
  });

  it('drops unsupported input kinds with a warning and leaves the channel unbound', async () => {
    const passes = [
      renderpass('image', 'Image', MAIN_IMAGE_SRC, 4, [{ id: 1, channel: 0, ctype: 'keyboard' }]),
    ];

    const { payload, warnings } = await importShadertoyShader('abcdef', 'key', {
      fetch: apiFetch(passes),
    });

    const image = imagePass(payload.project);
    expect(image.channels[0]).toEqual({ kind: 'none' });
    expect(warnings.some((w) => w.includes('"keyboard" inputs'))).toBe(true);
  });

  it('accepts a full view URL as well as a bare id', async () => {
    const passes = [renderpass('image', 'Image', MAIN_IMAGE_SRC, 4)];
    const { payload } = await importShadertoyShader(
      'https://www.shadertoy.com/view/abcdef',
      'key',
      { fetch: apiFetch(passes) },
    );
    expect(payload.name).toBe('Test Shader');
  });

  it('throws a readable error when Shadertoy reports one', async () => {
    await expect(
      importShadertoyShader('abcdef', 'key', {
        fetch: async () => jsonResponse({ Error: 'Shader not found' }),
      }),
    ).rejects.toThrow(/Shader not found/);
  });

  it('requires an API key', async () => {
    await expect(importShadertoyShader('abcdef', '  ', { fetch: apiFetch([]) })).rejects.toThrow(
      /API key/,
    );
  });
});
