import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { I18n } from '../i18n/i18n';
import { ShaderStore } from '../workspace/shader-store';
import { ProjectPluginActions } from './project-actions';

/**
 * Where the app's old shortcuts lead now that importing from Shadertoy and
 * exporting to Wallpaper Engine are plugins: to the installed, switched-on
 * contribution for the job — found by what it declares (its provider or
 * runtime), not by its package name — or, without one, to Plugins, where the
 * official package can be installed. There is no built-in fallback.
 */
@Injectable({ providedIn: 'root' })
export class PluginEntryPoints {
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectPluginActions);
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);

  /** The official packages, used only as the link target when nothing suitable is enabled. */
  static readonly SHADERTOY_PACKAGE = 'dev.shadergrove.shadertoy';
  static readonly WALLPAPER_PACKAGE = 'dev.shadergrove.wallpaper-engine';

  /** Opens the Shadertoy importer's form in Plugins (the plugin itself draws nothing). */
  openShadertoyImport(): Promise<boolean> {
    const importer = this.projects.importerFor('shadertoy-api/v1');
    return this.openPlugins(importer?.installed.id ?? PluginEntryPoints.SHADERTOY_PACKAGE);
  }

  /** Exports the open shader with the enabled Wallpaper Engine exporter, or leads to Plugins. */
  async exportWallpaper(): Promise<void> {
    const exporter = this.projects.exporterFor('wallpaper-web/v1');
    if (!exporter) {
      await this.openPlugins(PluginEntryPoints.WALLPAPER_PACKAGE);
      return;
    }
    const name = this.store.record()?.name ?? '';
    const outcome = await this.projects.runExport(exporter.installed.id, exporter.contribution.id);
    switch (outcome.status) {
      case 'exported': {
        const warning = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(' ')}` : '';
        this.store.notice.set({
          text: this.i18n.t('notice.wallpaperExported', { name, warning }),
          error: false,
        });
        return;
      }
      case 'failed':
        this.store.notice.set({
          text: this.i18n.t('notice.wallpaperExportFailed', { error: outcome.message }),
          error: true,
        });
        return;
      case 'stale':
        this.store.notice.set({ text: this.i18n.t('plugins.staleResult'), error: true });
        return;
      default:
        return;
    }
  }

  private openPlugins(id: string): Promise<boolean> {
    return this.router.navigate(['/plugins'], { queryParams: { use: id } });
  }
}
