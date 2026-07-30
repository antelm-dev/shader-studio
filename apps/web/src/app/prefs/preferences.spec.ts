import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FILE_EXPLORER_OPEN,
  DEFAULT_FILE_EXPLORER_VIEW,
  DEFAULT_FILE_EXPLORER_WIDTH,
  FILE_EXPLORER_LIMITS,
} from '@shader-studio/shared/panel-prefs';
import { Preferences } from './preferences';

const STORAGE_KEY = 'shader-studio.preferences';

function makePreferences(storageData?: string): Preferences {
  const storage = new Map<string, string>();
  if (storageData !== undefined) storage.set(STORAGE_KEY, storageData);

  const mockStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };

  TestBed.configureTestingModule({
    providers: [
      Preferences,
      {
        provide: DOCUMENT,
        useValue: {
          defaultView: {
            localStorage: mockStorage,
            matchMedia: () => null,
          },
          documentElement: { style: {} },
        },
      },
      { provide: PLATFORM_ID, useValue: 'browser' },
    ],
  });

  return TestBed.inject(Preferences);
}

describe('Preferences file explorer fields', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults explorer open, view, and width', () => {
    const prefs = makePreferences();
    expect(prefs.value().fileExplorerOpen).toBe(DEFAULT_FILE_EXPLORER_OPEN);
    expect(prefs.value().fileExplorerView).toBe(DEFAULT_FILE_EXPLORER_VIEW);
    expect(prefs.value().fileExplorerWidth).toBe(DEFAULT_FILE_EXPLORER_WIDTH);
  });

  it('sanitizes malformed explorer prefs from storage', () => {
    const prefs = makePreferences(
      JSON.stringify({
        fileExplorerOpen: 'yes',
        fileExplorerView: 'tabs',
        fileExplorerWidth: 9000,
      }),
    );
    expect(prefs.value().fileExplorerOpen).toBe(DEFAULT_FILE_EXPLORER_OPEN);
    expect(prefs.value().fileExplorerView).toBe('files');
    expect(prefs.value().fileExplorerWidth).toBe(FILE_EXPLORER_LIMITS.width.max);
  });

  it('clamps explorer width below the minimum', () => {
    const prefs = makePreferences(JSON.stringify({ fileExplorerWidth: 12 }));
    expect(prefs.value().fileExplorerWidth).toBe(FILE_EXPLORER_LIMITS.width.min);
  });

  it('keeps a valid pipeline view and collapsed state', () => {
    const prefs = makePreferences(
      JSON.stringify({
        fileExplorerOpen: false,
        fileExplorerView: 'pipeline',
        fileExplorerWidth: 300,
      }),
    );
    expect(prefs.value().fileExplorerOpen).toBe(false);
    expect(prefs.value().fileExplorerView).toBe('pipeline');
    expect(prefs.value().fileExplorerWidth).toBe(300);
  });

  it('falls back to defaults when storage is not JSON', () => {
    const prefs = makePreferences('not-json');
    expect(prefs.value().fileExplorerOpen).toBe(DEFAULT_FILE_EXPLORER_OPEN);
    expect(prefs.value().fileExplorerView).toBe(DEFAULT_FILE_EXPLORER_VIEW);
    expect(prefs.value().fileExplorerWidth).toBe(DEFAULT_FILE_EXPLORER_WIDTH);
  });
});

describe('Preferences inspector surface mirror', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('mirrors the migrated inspector surface onto guiVisible/inspectorTab', () => {
    const prefs = makePreferences();
    const layout = prefs.value().surfacesLayout;
    const inspector = layout.surfaces.find((surface) => surface.kind === 'inspector');
    expect(inspector).toBeDefined();
    expect(prefs.value().guiVisible).toBe(inspector?.open);
    expect(inspector?.chrome.kind === 'inspector' && inspector.chrome.tab).toBe(
      prefs.value().inspectorTab,
    );
  });

  it('prefers a persisted surfacesLayout inspector over stale legacy fields', () => {
    const prefs = makePreferences(
      JSON.stringify({
        guiVisible: true,
        inspectorTab: 'controls',
        surfacesLayout: {
          version: 1,
          surfaces: [
            {
              id: 'surface:inspector',
              kind: 'inspector',
              open: false,
              placement: {
                host: 'contained',
                mode: 'floating',
                rect: { x: 10, y: 10, width: 300, height: 300 },
              },
              chrome: { kind: 'inspector', tab: 'presets' },
            },
          ],
          zOrder: ['surface:inspector'],
        },
      }),
    );

    expect(prefs.value().guiVisible).toBe(false);
    expect(prefs.value().inspectorTab).toBe('presets');
  });
});
