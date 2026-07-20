import { Injectable, inject } from '@angular/core';

import { I18n } from '../../i18n/i18n';
import { Preferences, type ColorScheme, type WorkspacePreferences } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderStore } from '../../workspace/shader-store';

/**
 * The command surface behind the preview's context menu: pausing, capturing
 * a frame, resetting parameters, visibility toggles and the theme picker.
 * Kept apart from `PreviewShell`, which owns the window's geometry (mode,
 * dragging, resizing) and nothing about what its menu items actually do.
 */
@Injectable({ providedIn: 'root' })
export class PreviewMenuCommands {
  private readonly preferences = inject(Preferences);
  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);
  private readonly i18n = inject(I18n);

  toggle(key: 'editorOpen' | 'guiVisible'): void {
    this.preferences.patch({
      [key]: !this.preferences.value()[key],
    } as Partial<WorkspacePreferences>);
  }

  togglePause(): void {
    this.preferences.patch({ paused: !this.preferences.value().paused });
  }

  setColorScheme(colorScheme: ColorScheme): void {
    this.preferences.patch({ colorScheme });
  }

  async savePng(): Promise<void> {
    const name = this.store.record()?.id ?? 'shader';
    const saved = await this.renderer.screenshot(name);
    if (!saved) {
      this.store.notice.set({ text: this.i18n.t('preview.nothingToCapture'), error: true });
    }
  }

  themeLabel(theme: ColorScheme): string {
    return this.i18n.t(`theme.${theme}`);
  }
}
