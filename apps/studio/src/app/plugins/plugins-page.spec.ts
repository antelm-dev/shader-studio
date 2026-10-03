import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueEntry } from '@shadergrove/shared/plugin';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18nCatalog, type I18nCatalogMap } from '../i18n/catalog';
import { I18n } from '../i18n/i18n';
import { Preferences } from '../prefs/preferences';
import { AppThemes } from '../themes/app-themes';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption } from './effect-adoption';
import { PluginCatalogueService } from './plugin-catalogue';
import { PluginInstallations } from './plugin-installations';
import { PluginsPage } from './plugins-page';
import { ProjectPluginActions } from './project-actions';

class FileCatalog extends I18nCatalog {
  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    const raw = readFileSync(
      resolve(import.meta.dirname, `../../../../../i18n/${locale}.json`),
      'utf8',
    );
    return Promise.resolve(JSON.parse(raw) as I18nCatalogMap);
  }
}

const entry = (id: string): CatalogueEntry => ({
  id,
  version: '1.0.0',
  name: id,
  description: '',
  publisher: 'Example',
  license: 'MIT',
  protocolVersion: 2,
  appVersionRange: '>=1.0.0',
  file: `${id}-1.0.0.sgplugin.json`,
  bytes: 1,
  sha256: '0'.repeat(64),
  contributions: [],
});

/**
 * Links into Plugins (`/plugins?use=<id>`) from the menus and the palette.
 * Following one while the page is already open reuses the page, so the
 * highlight and the scroll have to follow the link, not the first visit.
 */
describe('PluginsPage deep links', () => {
  const FIRST = 'dev.example.first';
  const SECOND = 'dev.example.second';
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;

  beforeEach(async () => {
    scrolled.length = 0;
    // The test DOM has neither `CSS.escape` nor layout; ids here need no escaping.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.id);
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: 'plugins', component: PluginsPage }]),
        I18n,
        { provide: I18nCatalog, useClass: FileCatalog },
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        {
          provide: PluginInstallations,
          useValue: {
            loading: signal(false),
            plugins: signal([]),
            profile: signal('anonymous'),
            find: () => undefined,
          },
        },
        {
          provide: PluginCatalogueService,
          useValue: {
            state: signal({ status: 'ready', packages: [entry(FIRST), entry(SECOND)] }),
            load: async () => undefined,
          },
        },
        {
          provide: ProjectPluginActions,
          useValue: { running: signal(null), importers: signal([]), exporters: signal([]) },
        },
        { provide: AppThemes, useValue: { entries: signal([]) } },
        { provide: EffectAdoption, useValue: {} },
        { provide: ShaderStore, useValue: { draft: signal(null) } },
        { provide: DesktopPlatform, useValue: { available: false } },
      ],
    });
    await TestBed.inject(I18n).ensureLoaded('en');
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  const focused = (harness: RouterTestingHarness): string[] =>
    Array.from(harness.routeNativeElement!.querySelectorAll('article.focused')).map(
      (card) => card.id,
    );

  const settle = async (harness: RouterTestingHarness) => {
    harness.detectChanges();
    await new Promise((done) => setTimeout(done, 5));
    harness.detectChanges();
  };

  it('moves the highlight and the scroll to each package a link asks for', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/plugins?use=${FIRST}`, PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([`available-${FIRST}`]);
    expect(scrolled).toEqual([`available-${FIRST}`]);

    // Same route, another package: the page is reused.
    await harness.navigateByUrl(`/plugins?use=${SECOND}`, PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([`available-${SECOND}`]);
    expect(scrolled).toEqual([`available-${FIRST}`, `available-${SECOND}`]);

    // Without one, nothing is highlighted; the same link followed again scrolls again.
    await harness.navigateByUrl('/plugins', PluginsPage);
    await settle(harness);
    expect(focused(harness)).toEqual([]);
    await harness.navigateByUrl(`/plugins?use=${SECOND}`, PluginsPage);
    await settle(harness);
    expect(scrolled).toEqual([`available-${FIRST}`, `available-${SECOND}`, `available-${SECOND}`]);
  });
});
