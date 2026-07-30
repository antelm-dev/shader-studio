import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RENDER,
  createVignetteEffect,
  getBloomEffect,
  getVignetteEffect,
  type RenderSettings,
} from '@shader-studio/shared/model';
import { I18nCatalog, type I18nCatalogMap } from '../../i18n/catalog';
import { I18n } from '../../i18n/i18n';
import { Preferences, createDefaultWorkspacePreferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { PostProcessingPanel } from './post-processing-panel';

class FileCatalog extends I18nCatalog {
  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    const raw = readFileSync(
      resolve(import.meta.dirname, `../../../../../../i18n/${locale}.json`),
      'utf8',
    );
    return Promise.resolve(JSON.parse(raw) as I18nCatalogMap);
  }
}

/** Fires a real `input` + `change` cycle on a native input, the way a slider drag does. */
function setInputValue(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** `mat-slide-toggle`'s host carries the test id, but its inner `button[role="switch"]` is what's clickable. */
function clickToggle(host: Element): void {
  host.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
}

describe('PostProcessingPanel', () => {
  const draft = signal<{ render: RenderSettings } | null>({ render: DEFAULT_RENDER });

  beforeEach(async () => {
    draft.set({ render: DEFAULT_RENDER });

    await TestBed.configureTestingModule({
      imports: [PostProcessingPanel],
      providers: [
        provideZonelessChangeDetection(),
        { provide: I18nCatalog, useClass: FileCatalog },
        I18n,
        {
          provide: Preferences,
          useValue: {
            value: signal(createDefaultWorkspacePreferences()).asReadonly(),
            patch: () => {},
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            draft: draft.asReadonly(),
            setRender: (render: RenderSettings) => draft.set({ render }),
          },
        },
      ],
    }).compileComponents();

    await TestBed.inject(I18n).ensureLoaded('en');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function create() {
    const fixture = TestBed.createComponent(PostProcessingPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  it('renders the default chain: Bloom present, Vignette absent', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="pp-effect-bloom"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="pp-effect-vignette"]')).toBeNull();
  });

  it('the Add menu disables a type already in the chain', async () => {
    const fixture = await create();
    const component = fixture.componentInstance;

    expect(component['canAdd']('bloom')).toBe(false);
    expect(component['canAdd']('vignette')).toBe(true);
  });

  it('add appends a fresh enabled Vignette; remove drops it entirely', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    // mat-menu content renders into the CDK overlay container (document.body),
    // not under the component's own element — it has to be opened first.
    root.querySelector<HTMLButtonElement>('[data-testid="pp-add"]')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="pp-add-vignette"]')!.click();
    fixture.detectChanges();

    expect(draft()!.render.postProcessing.effects.map((e) => e.type)).toEqual([
      'bloom',
      'vignette',
    ]);
    expect(getVignetteEffect(draft()!.render).enabled).toBe(true);
    expect(root.querySelector('[data-testid="pp-effect-vignette"]')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('[data-testid="pp-remove-vignette"]')!.click();
    fixture.detectChanges();

    expect(draft()!.render.postProcessing.effects.map((e) => e.type)).toEqual(['bloom']);
    expect(root.querySelector('[data-testid="pp-effect-vignette"]')).toBeNull();
  });

  it('move up/down swaps chain order, and the DOM order follows it', async () => {
    draft.set({
      render: {
        postProcessing: {
          enabled: true,
          effects: [getBloomEffect(DEFAULT_RENDER), createVignetteEffect({ enabled: true })],
        },
      },
    });
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLButtonElement>('[data-testid="pp-move-up-vignette"]')!.click();
    fixture.detectChanges();

    expect(draft()!.render.postProcessing.effects.map((e) => e.type)).toEqual([
      'vignette',
      'bloom',
    ]);
    const rows = [...root.querySelectorAll('.effect')].map((row) =>
      row.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['pp-effect-vignette', 'pp-effect-bloom']);
  });

  it('master toggle flips only postProcessing.enabled, leaving effects untouched', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    const before = draft()!.render.postProcessing.effects;
    expect(draft()!.render.postProcessing.enabled).toBe(true); // DEFAULT_RENDER starts enabled

    clickToggle(root.querySelector('[data-testid="pp-master-toggle"]')!);
    fixture.detectChanges();

    expect(draft()!.render.postProcessing.enabled).toBe(false);
    expect(draft()!.render.postProcessing.effects).toEqual(before);
  });

  it('per-effect enable toggles only that effect', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    expect(getBloomEffect(draft()!.render).enabled).toBe(false); // DEFAULT_RENDER's Bloom starts disabled

    clickToggle(root.querySelector('[data-testid="pp-enable-bloom"]')!);
    fixture.detectChanges();

    expect(getBloomEffect(draft()!.render).enabled).toBe(true);
    expect(draft()!.render.postProcessing.enabled).toBe(true); // master switch untouched
  });

  it('reset restores an effect to its type defaults, keeping enabled state and position', async () => {
    draft.set({
      render: {
        postProcessing: {
          enabled: true,
          effects: [
            {
              type: 'bloom',
              enabled: false,
              settings: { strength: 1.9, radius: 0.9, threshold: 0.1 },
            },
          ],
        },
      },
    });
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLButtonElement>('[data-testid="pp-reset-bloom"]')!.click();
    fixture.detectChanges();

    const bloom = getBloomEffect(draft()!.render);
    expect(bloom.enabled).toBe(false); // untouched
    expect(bloom.settings).toEqual({ strength: 0.3, radius: 0.5, threshold: 0.85 }); // back to defaults
  });

  it('two rapid settings edits on the same effect both survive — neither clobbers the other', async () => {
    draft.set({
      render: {
        postProcessing: {
          enabled: true,
          effects: [getBloomEffect(DEFAULT_RENDER), createVignetteEffect({ enabled: true })],
        },
      },
    });
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    const vignetteRow = root.querySelector('[data-testid="pp-effect-vignette"]')!;
    const [intensityInput, softnessInput] = [
      ...vignetteRow.querySelectorAll<HTMLInputElement>('input[type="range"]'),
    ];

    // Both edits fire before Angular gets a chance to re-render in between —
    // exactly the case a template closure over a stale `effect` object would
    // get wrong, since the second edit's handler would still see the first
    // edit's pre-update settings.
    setInputValue(intensityInput, 0.9);
    setInputValue(softnessInput, 0.15);
    fixture.detectChanges();

    const vignette = getVignetteEffect(draft()!.render);
    expect(vignette.settings.intensity).toBe(0.9);
    expect(vignette.settings.softness).toBe(0.15);
    expect(vignette.settings.roundness).toBe(1); // default, untouched by either edit
  });
});
