import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_VERSION, type CatalogueEntry } from '@shadergrove/shared';
import { PluginCatalogueService, sha256Hex } from './plugin-catalogue';

const packageText = (version = '1.0.0', id = 'dev.example.demo') =>
  JSON.stringify({
    manifest: {
      id,
      version,
      protocolVersion: 1,
      appVersionRange: '>=1.0.0',
      name: 'Demo',
      publisher: 'Example',
      license: 'MIT',
      contributions: [{ kind: 'effect', id: 'tint', name: 'Tint', controls: [] }],
    },
    glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c; }' },
  });

async function entryFor(text: string, overrides: Partial<CatalogueEntry> = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    id: 'dev.example.demo',
    version: '1.0.0',
    name: 'Demo',
    description: 'A demo.',
    publisher: 'Example',
    license: 'MIT',
    protocolVersion: 1,
    appVersionRange: '>=1.0.0',
    file: 'dev.example.demo-1.0.0.sgplugin.json',
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    contributions: [{ kind: 'effect', id: 'tint', name: 'Tint' }],
    ...overrides,
  } satisfies CatalogueEntry;
}

function setup(platform: 'browser' | 'server', files: Record<string, string>) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: platform }],
  });
  const catalogue = TestBed.inject(PluginCatalogueService);
  const fetcher = vi.fn(async (url: string) => {
    const name = url.slice(url.indexOf('plugins/') + 'plugins/'.length);
    return name in files
      ? new Response(files[name], { status: 200 })
      : new Response('missing', { status: 404 });
  });
  catalogue.useFetch(fetcher);
  return { catalogue, fetcher };
}

describe('PluginCatalogueService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists compatible entries from the shipped catalogue and fetches nothing else', async () => {
    const text = packageText();
    const compatible = await entryFor(text);
    const future = { ...compatible, id: 'dev.example.future', appVersionRange: '>=99.0.0' };
    const newProtocol = { ...compatible, id: 'dev.example.p9', protocolVersion: 9 };
    const { catalogue, fetcher } = setup('browser', {
      'catalogue.json': JSON.stringify({
        format: 'shadergrove-plugin-catalogue/v1',
        packages: [compatible, future, newProtocol],
      }),
    });
    await catalogue.load();
    expect(catalogue.state()).toEqual({ status: 'ready', packages: [compatible] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(APP_VERSION).toMatch(/^\d/);
  });

  it('fetches nothing during server rendering', async () => {
    const { catalogue, fetcher } = setup('server', {});
    await catalogue.load();
    expect(fetcher).not.toHaveBeenCalled();
    expect(catalogue.state().status).toBe('idle');
  });

  it('reports a malformed catalogue', async () => {
    const { catalogue } = setup('browser', { 'catalogue.json': '{"format":"nope"}' });
    await catalogue.load();
    expect(catalogue.state().status).toBe('error');
  });

  it('accepts a package only when its size, hash and identity match the entry', async () => {
    const text = packageText();
    const entry = await entryFor(text);
    const { catalogue } = setup('browser', { [entry.file]: text });
    await expect(catalogue.fetchPackage(entry)).resolves.toHaveLength(entry.bytes);

    await expect(catalogue.fetchPackage({ ...entry, sha256: '0'.repeat(64) })).rejects.toThrow(
      /hash/,
    );
    await expect(catalogue.fetchPackage({ ...entry, bytes: entry.bytes - 1 })).rejects.toThrow(
      /too large/,
    );
    await expect(catalogue.fetchPackage({ ...entry, bytes: entry.bytes + 1 })).rejects.toThrow(
      /not the/,
    );

    const other = packageText('2.0.0');
    const mislabelled = await entryFor(other);
    TestBed.resetTestingModule();
    const { catalogue: second } = setup('browser', { [mislabelled.file]: other });
    await expect(second.fetchPackage(mislabelled)).rejects.toThrow(/not the package/);
  });
});
