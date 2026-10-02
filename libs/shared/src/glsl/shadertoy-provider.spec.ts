import { describe, expect, it, vi } from 'vitest';

import {
  fetchShadertoyAsset,
  fetchShadertoySource,
  isShadertoyAssetPath,
  type ShadertoyFetchResponse,
} from './shadertoy-api';
import { convertShadertoyPaste, convertShadertoySource } from './shadertoy-convert';

function response(
  status: number,
  body: Uint8Array | string = '',
  headers: Record<string, string> = {},
): ShadertoyFetchResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
  };
}

const shaderJson = JSON.stringify({ Shader: { info: { id: 'abc' }, renderpass: [] } });

describe('fetchShadertoySource', () => {
  it('requests the fixed API path and returns the parsed document', async () => {
    const fetch = vi.fn(async () => response(200, shaderJson));
    const result = await fetchShadertoySource('https://www.shadertoy.com/view/abc', 'k3y', {
      fetch,
    });
    expect(result).toEqual({ sourceId: 'abc', source: JSON.parse(shaderJson) });
    expect(fetch).toHaveBeenCalledWith('https://www.shadertoy.com/api/v1/shaders/abc?key=k3y', {
      redirect: 'manual',
    });
  });

  it('refuses bad ids and keys before any request', async () => {
    const fetch = vi.fn(async () => response(200, shaderJson));
    await expect(fetchShadertoySource('../../etc', 'key', { fetch })).rejects.toThrow(/ID or URL/);
    await expect(fetchShadertoySource('abc', 'a&b=c', { fetch })).rejects.toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows redirects only within the allow-list', async () => {
    const offsite = vi.fn(async () =>
      response(302, '', { location: 'https://evil.example/api/v1/shaders/abc' }),
    );
    await expect(fetchShadertoySource('abc', 'secret', { fetch: offsite })).rejects.toThrow(
      /does not follow/,
    );
    const elsewhere = vi.fn(async () => response(301, '', { location: '/media/a/x.png' }));
    await expect(fetchShadertoySource('abc', 'secret', { fetch: elsewhere })).rejects.toThrow(
      /does not follow/,
    );
    let hops = 0;
    const same = vi.fn(async () =>
      hops++ === 0
        ? response(307, '', { location: '/api/v1/shaders/abc?key=secret' })
        : response(200, shaderJson),
    );
    await expect(fetchShadertoySource('abc', 'secret', { fetch: same })).resolves.toMatchObject({
      sourceId: 'abc',
    });
    const loop = vi.fn(async () => response(302, '', { location: '/api/v1/shaders/abc' }));
    await expect(fetchShadertoySource('abc', 'secret', { fetch: loop })).rejects.toThrow(
      /too many/,
    );
  });

  it('bounds the body and never puts the key in an error', async () => {
    const declared = vi.fn(async () =>
      response(200, shaderJson, { 'content-length': String(3 * 1024 * 1024) }),
    );
    await expect(fetchShadertoySource('abc', 'secret', { fetch: declared })).rejects.toThrow(
      /larger than/,
    );
    const big = vi.fn(async () => response(200, new Uint8Array(3 * 1024 * 1024)));
    await expect(fetchShadertoySource('abc', 'secret', { fetch: big })).rejects.toThrow(
      /larger than/,
    );
    for (const fetch of [
      vi.fn(async () => response(403, 'denied')),
      vi.fn(async () => response(200, 'not json')),
    ]) {
      const error = await fetchShadertoySource('abc', 'secret', { fetch }).catch((e) => e);
      expect(String(error.message)).not.toContain('secret');
    }
  });
});

describe('fetchShadertoyAsset', () => {
  it('fetches only Shadertoy media paths', async () => {
    const fetch = vi.fn(async () => response(200, new Uint8Array([1, 2, 3])));
    await expect(fetchShadertoyAsset('/media/a/abc.png', { fetch })).resolves.toHaveLength(3);
    for (const path of [
      'https://evil.example/x.png',
      '//evil.example/x.png',
      '/media/a/../../api/x.png',
      '/api/v1/shaders/abc',
      '/media/a/x.mp4',
    ]) {
      expect(isShadertoyAssetPath(path)).toBe(false);
      await expect(fetchShadertoyAsset(path, { fetch })).rejects.toThrow(/texture path/);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses textures over the texture limit', async () => {
    const fetch = vi.fn(async () => response(200, new Uint8Array(4 * 1024 * 1024 + 1)));
    await expect(fetchShadertoyAsset('/media/a/abc.png', { fetch })).rejects.toThrow(/larger/);
  });
});

describe('convertShadertoySource / convertShadertoyPaste', () => {
  it('requests textures by path in first-use order, grouped, with credits', () => {
    const source = {
      Shader: {
        info: { id: 'abc', name: 'N'.repeat(100), description: 'D', username: 'iq' },
        renderpass: [
          {
            type: 'image',
            name: 'Image',
            code: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(0.0); }',
            inputs: [
              { channel: 0, ctype: 'texture', src: '/media/a/one.png' },
              { channel: 1, ctype: 'texture', src: '/media/a/one.png', sampler: { wrap: 'clamp' } },
            ],
            outputs: [{ id: 4, channel: 0 }],
          },
        ],
      },
    };
    const converted = convertShadertoySource(source, 'abc');
    expect(converted.name).toHaveLength(64);
    expect(converted.credits).toEqual({
      author: 'iq',
      sourceUrl: 'https://www.shadertoy.com/view/abc',
    });
    expect(converted.textures).toHaveLength(1);
    expect(converted.textures[0]!.uses.map((use) => use.channel)).toEqual([0, 1]);
    expect(converted.textures[0]!.wrap).toBe('repeat');
  });

  it('converts a pasted Image pass and refuses one without mainImage', () => {
    const pasted = convertShadertoyPaste(
      'Pasted',
      'void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }',
    );
    const image = pasted.project.passes.find((pass) => pass.kind === 'image')!;
    expect(image.source).toContain('uniform sampler2D iChannel0;');
    expect(pasted.warnings.some((warning) => warning.includes('Textures panel'))).toBe(true);
    expect(() => convertShadertoyPaste('x', 'void main() {}')).toThrow(/mainImage/);
  });
});
