import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nCatalog, type I18nCatalogMap } from '../../i18n/catalog';
import { I18n } from '../../i18n/i18n';
import { PluginCommands, type PluginCommand } from '../../plugins/plugin-commands';
import { Preferences } from '../../prefs/preferences';
import { NewShaderDialog } from './new-shader-dialog';

class FileCatalog extends I18nCatalog {
  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    const raw = readFileSync(
      resolve(import.meta.dirname, `../../../../../../i18n/${locale}.json`),
      'utf8',
    );
    return Promise.resolve(JSON.parse(raw) as I18nCatalogMap);
  }
}

describe('NewShaderDialog', () => {
  const imports = signal<PluginCommand[]>([]);
  const close = vi.fn();

  beforeEach(async () => {
    imports.set([]);
    close.mockClear();
    TestBed.configureTestingModule({
      imports: [NewShaderDialog],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        { provide: I18nCatalog, useClass: FileCatalog },
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        { provide: MatDialogRef, useValue: { close } },
        { provide: PluginCommands, useValue: { imports } },
      ],
    });
    await TestBed.inject(I18n).ensureLoaded('en');
  });

  afterEach(() => TestBed.resetTestingModule());

  const buttons = (fixture: { nativeElement: HTMLElement }) =>
    Array.from(fixture.nativeElement.querySelectorAll('button')).map(
      (button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );

  it('offers no importer while no plugin contributes one', () => {
    const fixture = TestBed.createComponent(NewShaderDialog);
    fixture.detectChanges();
    expect(buttons(fixture).some((label) => /Shadertoy/.test(label))).toBe(false);
  });

  it('offers each active importer and hands the chosen one back', () => {
    const shadertoy: PluginCommand = {
      id: 'plugin:pkg/shadertoy',
      ref: 'pkg/shadertoy',
      icon: () => 'public',
      label: () => 'Import from Shadertoy…',
      action: () => undefined,
    };
    imports.set([shadertoy]);
    const fixture = TestBed.createComponent(NewShaderDialog);
    fixture.detectChanges();
    expect(buttons(fixture)).toContain('public Import from Shadertoy…');

    (
      fixture.nativeElement.querySelector(
        '[data-testid="new-shader-plugin:pkg/shadertoy"]',
      ) as HTMLButtonElement
    ).click();
    expect(close).toHaveBeenCalledWith({ action: 'plugin', command: shadertoy });
  });
});
