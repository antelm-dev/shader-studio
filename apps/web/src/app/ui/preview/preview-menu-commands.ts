import { Injectable, inject } from '@angular/core';

import { I18n } from '../../i18n/i18n';
import { Preferences, type ColorScheme } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { ShaderStore } from '../../workspace/shader-store';

@Injectable({ providedIn: 'root' })
export class PreviewMenuCommands {
  private readonly preferences = inject(Preferences);
  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);
  private readonly i18n = inject(I18n);
  private readonly layout = inject(SurfaceLayoutService);

  toggleInspector(): void {
    this.layout.toggleInspectorOpen();
  }

  toggleEditor(): void {
    this.layout.toggleEditorOpen();
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
