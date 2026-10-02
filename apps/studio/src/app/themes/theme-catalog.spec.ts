import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  THEME_UI_ROLES,
  parsePluginPackage,
  type PluginPackage,
  type ThemeContribution,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';
import { isPluginCompatible } from '@shadergrove/shared/plugin';

import { monacoThemeId } from '../editor/editor-themes';
import type { InstalledPlugin } from '../plugins/plugin-installations';
import {
  UI_ROLE_PROPERTIES,
  UI_THEME_PROPERTIES,
  findPluginTheme,
  pluginMonacoThemeId,
  pluginThemeEntries,
  resolveAppTheme,
  resolveEditorTheme,
  uiThemeProperties,
} from './theme-catalog';

const fixture = resolve(
  import.meta.dirname,
  '../../../../../tools/workspace/fixtures/plugins/themes/grove-amber.sgplugin.json',
);

function amber(): PluginPackage {
  const parsed = parsePluginPackage(readFileSync(fixture, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.errors.join());
  return parsed.value;
}

function installed(
  plugin: PluginPackage | null,
  active = true,
  id = 'dev.shadergrove.grove-amber',
) {
  return {
    id,
    stored: { id, text: '', enabled: active, installedAt: '' },
    plugin,
    problem: plugin ? null : 'broken',
    active,
  } satisfies InstalledPlugin;
}

const DARK = 'plugin:dev.shadergrove.grove-amber/amber-dark';
const LIGHT = 'plugin:dev.shadergrove.grove-amber/amber-light';

describe('the Grove Amber fixture', () => {
  it('is a valid, code-free package of a light and a dark theme for this app', () => {
    const plugin = amber();
    expect(plugin.code).toBeUndefined();
    expect(isPluginCompatible(plugin.manifest, APP_VERSION)).toBe(true);
    expect(
      plugin.manifest.contributions.map((c) => [c.kind, (c as ThemeContribution).scheme]),
    ).toEqual([
      ['theme', 'dark'],
      ['theme', 'light'],
    ]);
  });
});

describe('pluginThemeEntries', () => {
  it('lists every theme of active packages only, with their credits', () => {
    const entries = pluginThemeEntries([installed(amber())]);
    expect(entries.map((entry) => entry.ref)).toEqual([DARK, LIGHT]);
    expect(entries[0]).toMatchObject({
      packageName: 'Grove Amber',
      publisher: 'Shadergrove',
      version: '1.0.0',
      license: 'CC0-1.0',
    });
    expect(pluginThemeEntries([installed(amber(), false)])).toEqual([]);
    expect(pluginThemeEntries([installed(null, false)])).toEqual([]);
  });

  it('finds an entry by reference, never by a malformed or unknown one', () => {
    const entries = pluginThemeEntries([installed(amber())]);
    expect(findPluginTheme(entries, DARK)?.theme.name).toBe('Grove Amber Dark');
    expect(findPluginTheme(entries, 'plugin:dev.shadergrove.grove-amber/amber-sepia')).toBeNull();
    expect(findPluginTheme(entries, 'amber-dark')).toBeNull();
  });
});

describe('resolveAppTheme', () => {
  const entries = pluginThemeEntries([installed(amber())]);

  it('wears the built-in in its own scheme', () => {
    expect(resolveAppTheme('builtin', 'light', entries)).toEqual({
      kind: 'builtin',
      scheme: 'light',
    });
  });

  it('lets a plugin theme bring its scheme, whatever the built-in one is', () => {
    const app = resolveAppTheme(LIGHT, 'dark', entries);
    expect(app).toMatchObject({ kind: 'plugin', scheme: 'light' });
  });

  it('falls back to the built-in while the reference is not in the catalogue', () => {
    expect(resolveAppTheme(DARK, 'light', [])).toEqual({ kind: 'builtin', scheme: 'light' });
  });
});

describe('uiThemeProperties', () => {
  it('maps every role to its own Material token, and nothing else', () => {
    expect(UI_ROLE_PROPERTIES.primary).toBe('--mat-sys-primary');
    expect(UI_ROLE_PROPERTIES['surface-container-high']).toBe('--mat-sys-surface-container-high');
    expect(UI_THEME_PROPERTIES).toHaveLength(THEME_UI_ROLES.length);
    expect(UI_THEME_PROPERTIES.every((p) => /^--mat-sys-[a-z-]+$/.test(p))).toBe(true);
  });

  it('sets nothing for the built-in, and only the roles a theme defines', () => {
    const entries = pluginThemeEntries([installed(amber())]);
    expect(uiThemeProperties({ kind: 'builtin', scheme: 'dark' })).toEqual([]);

    const dark = new Map(uiThemeProperties(resolveAppTheme(DARK, 'dark', entries)));
    expect(dark.get('--mat-sys-primary')).toBe('#f2a93b');
    expect(dark.get('--mat-sys-secondary')).toBe('#d9b98c');

    const light = new Map(uiThemeProperties(resolveAppTheme(LIGHT, 'dark', entries)));
    expect(light.get('--mat-sys-surface')).toBe('#fbf6ef');
    expect(light.has('--mat-sys-secondary')).toBe(false);
  });
});

describe('resolveEditorTheme', () => {
  const entries = pluginThemeEntries([installed(amber())]);
  const builtinDark = resolveAppTheme('builtin', 'dark', entries);
  const pluginLight = resolveAppTheme(LIGHT, 'dark', entries);

  it('follows the app on auto, the built-in or a plugin theme', () => {
    expect(resolveEditorTheme('auto', builtinDark, entries).monacoId).toBe(
      monacoThemeId('studio-dark'),
    );
    expect(
      resolveEditorTheme('auto', resolveAppTheme('builtin', 'light', entries), entries),
    ).toMatchObject({ monacoId: monacoThemeId('studio-light'), ref: null });
    const followed = resolveEditorTheme('auto', pluginLight, entries);
    expect(followed).toMatchObject({ ref: LIGHT, monacoId: pluginMonacoThemeId(LIGHT) });
    expect(followed.palette.background).toBe('#fdf9f3');
  });

  it('keeps an explicit built-in or plugin choice over the app', () => {
    expect(resolveEditorTheme('midnight', pluginLight, entries).monacoId).toBe(
      monacoThemeId('midnight'),
    );
    expect(resolveEditorTheme(DARK, pluginLight, entries).ref).toBe(DARK);
    expect(resolveEditorTheme(DARK, builtinDark, entries).ref).toBe(DARK);
  });

  it('treats a pinned plugin theme that is not installed as auto', () => {
    expect(resolveEditorTheme(DARK, resolveAppTheme('builtin', 'light', []), [])).toMatchObject({
      monacoId: monacoThemeId('studio-light'),
      ref: null,
    });
  });

  it('names every plugin theme within what Monaco accepts, distinctly', () => {
    const a = pluginMonacoThemeId('plugin:a.b/c');
    const b = pluginMonacoThemeId('plugin:a-b/c');
    const c = pluginMonacoThemeId('plugin:a_b/c');
    for (const id of [a, b, c]) expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
