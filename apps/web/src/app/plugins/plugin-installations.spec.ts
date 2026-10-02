import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  effectContributionCandidate,
  type CustomEffect,
  type EffectContribution,
  type RenderSettings,
} from '@shadergrove/shared';
import { AuthService } from '../auth/auth.service';
import { RendererHandle } from '../rendering/renderer-handle';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { PLUGIN_STORE, PluginInstallations, type PluginReview } from './plugin-installations';
import type { PluginStore, StoredPlugin } from './plugin-store';

/** One map per profile, standing in for one IndexedDB database each, and outliving the service. */
class MemoryStores {
  readonly byProfile = new Map<string, Map<string, StoredPlugin>>();

  for(profile: string): PluginStore {
    const records = this.byProfile.get(profile) ?? new Map<string, StoredPlugin>();
    this.byProfile.set(profile, records);
    return {
      list: async () => [...records.values()],
      put: async (record) => void records.set(record.id, record),
      remove: async (id) => void records.delete(id),
    };
  }
}

function packageText(overrides: { id?: string; version?: string; range?: string } = {}): string {
  return JSON.stringify({
    manifest: {
      id: overrides.id ?? 'dev.example.tint',
      version: overrides.version ?? '1.0.0',
      protocolVersion: 1,
      appVersionRange: overrides.range ?? '>=1.0.0',
      name: 'Tint',
      publisher: 'Example',
      license: 'MIT',
      contributions: [
        {
          kind: 'effect',
          id: 'tint',
          name: 'Red tint',
          controls: [{ key: 'amount', type: 'number', default: 0.5, min: 0, max: 1 }],
        },
      ],
    },
    glsl: {
      tint: 'vec4 effect(vec4 c, vec2 uv) { return c * vec4(1.0, u_amount, u_amount, 1.0); }',
    },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('PluginInstallations', () => {
  let stores: MemoryStores;
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const draft = signal<{ render: RenderSettings } | null>(null);
  const probe = vi.fn(() => [] as unknown[]);

  function setup(): PluginInstallations {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLUGIN_STORE, useValue: (profile: string) => stores.for(profile) },
        { provide: AuthService, useValue: { user, status } },
        {
          provide: ShaderStore,
          useValue: {
            draft,
            setRender: (render: RenderSettings) => draft.set({ render }),
          },
        },
        {
          provide: RendererHandle,
          useValue: { engine: () => ({ probeCustomEffect: probe }) },
        },
      ],
    });
    return TestBed.inject(PluginInstallations);
  }

  /** Lets the profile effect run and the store's promises settle. */
  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function okReview(installations: PluginInstallations, text = packageText()) {
    const review = installations.review(bytes(text));
    if (!review.ok) throw new Error(review.errors.join());
    return review;
  }

  beforeEach(() => {
    stores = new MemoryStores();
    user.set(null);
    status.set('anonymous');
    draft.set({ render: structuredClone(DEFAULT_RENDER) });
    probe.mockReset().mockReturnValue([]);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('reviews a package without installing it, and installs it switched off', async () => {
    const installations = setup();
    await settle();

    const review = okReview(installations);
    expect(review.compatible).toBe(true);
    expect(installations.plugins()).toEqual([]);

    await installations.install(review);
    expect(installations.plugins()).toEqual([
      expect.objectContaining({ id: 'dev.example.tint', active: false, problem: null }),
    ]);

    await installations.setEnabled('dev.example.tint', true);
    expect(installations.find('dev.example.tint')?.active).toBe(true);
  });

  it('refuses an invalid file at review and an incompatible package at install', async () => {
    const installations = setup();
    await settle();

    const invalid = installations.review(bytes('{"manifest":{"id":"x"}}')) as PluginReview;
    expect(invalid.ok).toBe(false);
    expect(installations.review(new Uint8Array([0xff, 0xfe])).ok).toBe(false);

    const future = okReview(installations, packageText({ range: '>=99.0.0' }));
    expect(future.compatible).toBe(false);
    await expect(installations.install(future)).rejects.toThrow(/not made for this version/);
    expect(installations.plugins()).toEqual([]);
  });

  it('comes back after a restart from what was stored, with no network at all', async () => {
    let installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);

    // A new app session over the same store: nothing is fetched, everything is reread.
    TestBed.resetTestingModule();
    installations = setup();
    await settle();

    expect(installations.find('dev.example.tint')?.active).toBe(true);
  });

  it("keeps each account to its own plugins, never reusing another profile's packages", async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    expect(installations.plugins()).toHaveLength(1);

    user.set({ id: 'alice' });
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.host('dev.example.tint')).toBeNull();

    user.set(null);
    await settle();
    expect(installations.plugins()).toHaveLength(1);
  });

  it('loads nothing until the session is known, so a signed-in user never sees the anonymous profile', async () => {
    await stores.for('anonymous').put({
      id: 'dev.example.tint',
      text: packageText(),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    status.set('loading');
    const installations = setup();
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.loading()).toBe(true);
    expect(installations.host('dev.example.tint')).toBeNull();

    user.set({ id: 'alice' });
    status.set('authenticated');
    await settle();
    expect(installations.plugins()).toEqual([]);
    expect(installations.loading()).toBe(false);
    expect([...stores.byProfile.keys()]).toEqual(['anonymous', 'alice']);
  });

  it('revalidates what it reads: a corrupted or outdated record comes back off, and can still be removed', async () => {
    stores.for('anonymous').put({
      id: 'dev.example.broken',
      text: '{ corrupted',
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    stores.for('anonymous').put({
      id: 'dev.example.old',
      text: packageText({ id: 'dev.example.old', range: '<1.0.0' }),
      enabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const installations = setup();
    await settle();

    const broken = installations.find('dev.example.broken')!;
    expect(broken.active).toBe(false);
    expect(broken.problem).toMatch(/valid package/);
    expect(installations.find('dev.example.old')!.active).toBe(false);
    await expect(installations.setEnabled('dev.example.old', true)).rejects.toThrow(/app versions/);

    await installations.remove('dev.example.broken');
    expect(installations.find('dev.example.broken')).toBeUndefined();
  });

  it('updates in place from a newer file of the same id, switched off again', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);

    const update = okReview(installations, packageText({ version: '1.1.0' }));
    expect(update.replaces).toBe('1.0.0');
    await installations.install(update);

    const installed = installations.find('dev.example.tint')!;
    expect(installed.plugin?.manifest.version).toBe('1.1.0');
    expect(installed.active).toBe(false);
  });

  it('adds a declarative effect twice, and both copies outlive the package', async () => {
    const installations = setup();
    await settle();
    await installations.install(okReview(installations));
    await installations.setEnabled('dev.example.tint', true);
    const installed = installations.find('dev.example.tint')!;
    const contribution = installed.plugin!.manifest.contributions[0] as EffectContribution;
    const adoption = TestBed.inject(EffectAdoption);

    const candidate = effectContributionCandidate(installed.plugin!, contribution);
    expect(adoption.adopt(candidate)).toEqual({ ok: true });
    expect(adoption.adopt(candidate)).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(2);

    await installations.remove('dev.example.tint');

    const customs = draft()!.render.postProcessing.effects.filter(
      (effect): effect is CustomEffect => effect.type === 'custom',
    );
    expect(customs).toHaveLength(2);
    expect(customs[0]!.instanceId).not.toBe(customs[1]!.instanceId);
    expect(customs[0]!.definition).toMatchObject({ name: 'Red tint', source: candidate.source });
    expect(customs[0]!.values).toEqual({ amount: 0.5 });
  });

  it('adopts nothing the driver rejects, and nothing without an open shader', async () => {
    setup();
    const adoption = TestBed.inject(EffectAdoption);
    const candidate = { name: 'Bad', source: 'nope', controls: [], values: {} };
    const before = structuredClone(draft()!.render);

    probe.mockReturnValue([
      { severity: 'error', line: 1, message: 'syntax error', source: 'fragment' },
    ]);
    expect(adoption.adopt(candidate)).toMatchObject({ ok: false, reason: 'compile' });
    expect(draft()!.render).toEqual(before);

    draft.set(null);
    expect(adoption.adopt(candidate)).toEqual({ ok: false, reason: 'no-shader' });
  });
});
