import {
  DOCUMENT,
  Injectable,
  Injector,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import type { PluginThemeRef } from '@shadergrove/shared/plugin';

import { EditorSettings } from '../editor/editor-settings';
import { toMonacoTheme, type MonacoApi } from '../editor/monaco-loader';
import { PluginInstallations } from '../plugins/plugin-installations';
import { Preferences, colorSchemeIcon, type ColorScheme } from '../prefs/preferences';
import {
  UI_THEME_PROPERTIES,
  pluginThemeEntries,
  resolveAppTheme,
  resolveEditorTheme,
  uiThemeProperties,
  type PluginThemeEntry,
  type ResolvedAppTheme,
  type ResolvedEditorTheme,
} from './theme-catalog';

/**
 * The one owner of what the app and its editor are painted with.
 *
 * Merges the built-in theme with the theme contributions of the current
 * profile's active packages, resolves the stored choices against that catalogue,
 * and applies the result: the root `color-scheme` and the Material colour tokens
 * for the chrome — overlays, lil-gui and the glass surfaces all derive from
 * those — and Monaco's global theme for every editor. Nothing else writes
 * either; `Preferences` only stores the choices.
 *
 * Until the session and the plugins have loaded, the catalogue is empty and the
 * built-in theme is painted: never a palette of the previous profile, and never
 * one from a package that is no longer active. A stored reference is kept all
 * the while, and applies again as soon as its theme is back in the catalogue.
 * Listing or applying a theme starts no plugin Worker: a theme is data.
 */
@Injectable({ providedIn: 'root' })
export class AppThemes {
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly preferences = inject(Preferences);
  private readonly editorSettings = inject(EditorSettings);
  // The server has no plugins: it renders the built-in theme, deterministically.
  private readonly installations = this.isBrowser ? inject(PluginInstallations) : null;

  private readonly monaco = signal<MonacoApi | null>(null);
  private started = false;

  /** The themes of the current profile's active packages. */
  readonly entries = computed<readonly PluginThemeEntry[]>(() =>
    this.installations ? pluginThemeEntries(this.installations.plugins()) : [],
  );

  /** What the app wears now. */
  readonly app = computed<ResolvedAppTheme>(() =>
    resolveAppTheme(
      this.preferences.value().appThemeId,
      this.preferences.resolved(),
      this.entries(),
    ),
  );

  /** The light/dark scheme actually painted. */
  readonly scheme = computed(() => this.app().scheme);

  /** What every editor wears, the settings dialog's preview included. */
  readonly editor = computed<ResolvedEditorTheme>(() =>
    resolveEditorTheme(this.editorSettings.effective().theme, this.app(), this.entries()),
  );

  /** The icon of the theme menu: the built-in scheme's, or a palette for a plugin theme. */
  readonly icon = computed(() =>
    this.app().kind === 'plugin'
      ? 'palette'
      : colorSchemeIcon(this.preferences.value().colorScheme),
  );

  /** Starts painting. Called once at startup in the browser; a no-op on the server. */
  start(): void {
    if (!this.isBrowser || this.started) return;
    this.started = true;

    const options = { injector: this.injector };
    effect(() => this.applyUi(this.app()), options);

    effect(() => {
      const monaco = this.monaco();
      const theme = this.editor();
      if (monaco) untracked(() => applyEditor(monaco, theme));
    }, options);
  }

  /**
   * Hands over Monaco once it has loaded, and paints it at once — before the
   * first editor is created, so no editor ever shows Monaco's default first.
   * Later changes, a plugin palette updated under the same id included, follow
   * through the effect above. Safe to call from every editor.
   */
  attachMonaco(monaco: MonacoApi): void {
    if (untracked(this.monaco) === monaco) return;
    applyEditor(monaco, untracked(this.editor));
    this.monaco.set(monaco);
  }

  /** Wear the built-in theme in this scheme. */
  selectBuiltin(colorScheme: ColorScheme): void {
    this.preferences.patch({ appThemeId: 'builtin', colorScheme });
  }

  /** Wear a plugin theme. The built-in scheme is left as it was, for when it comes back. */
  selectPlugin(ref: PluginThemeRef): void {
    this.preferences.patch({ appThemeId: ref });
  }

  /** Whether the built-in theme is worn, in this scheme. */
  isBuiltinSelected(colorScheme: ColorScheme): boolean {
    return this.app().kind === 'builtin' && this.preferences.value().colorScheme === colorScheme;
  }

  isPluginSelected(ref: PluginThemeRef): boolean {
    const app = this.app();
    return app.kind === 'plugin' && app.entry.ref === ref;
  }

  private applyUi(app: ResolvedAppTheme): void {
    const root = this.document.documentElement;
    // Every Material colour token is a `light-dark()` pair, so the built-in
    // palette — and every role a plugin theme leaves out — follows this.
    root.style.colorScheme = app.scheme;
    // Everything the previous theme set goes first, so a theme with fewer roles
    // never keeps a colour of the one before.
    for (const property of UI_THEME_PROPERTIES) root.style.removeProperty(property);
    for (const [property, value] of uiThemeProperties(app)) {
      root.style.setProperty(property, value);
    }
    if (app.kind === 'plugin') root.dataset['appTheme'] = app.entry.ref;
    else delete root.dataset['appTheme'];
  }
}

/** Defines a plugin palette before selecting it; Monaco refreshes a redefined current theme. */
function applyEditor(monaco: MonacoApi, theme: ResolvedEditorTheme): void {
  if (theme.ref) monaco.editor.defineTheme(theme.monacoId, toMonacoTheme(theme.palette));
  monaco.editor.setTheme(theme.monacoId);
}
