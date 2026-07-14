import { Injectable, afterNextRender, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { isOutputWindow } from '../output-mode';
import { I18n } from '../i18n/i18n';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from './shader-store';

/**
 * Keeps the URL and the selected shader in sync: `/shaders/:id` for whatever
 * is selected, `/` otherwise, in both directions — following a link updates
 * the selection, and picking a shader in the browser updates the URL.
 *
 * Self-starting, the same way `ShaderStore` is: nothing outside this class
 * needs to call anything for routing to come alive, except reading
 * `routeShaderId()` once, before hydration, for the SSR snapshot.
 */
@Injectable({ providedIn: 'root' })
export class RoutingCoordinator {
  private readonly router = inject(Router);
  private readonly store = inject(ShaderStore);
  private readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);

  private routingReady = false;

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (this.routingReady) void this.applyRoute();
      });

    effect(() => {
      const id = this.store.selectedId();
      if (!this.routingReady) return;
      const canonical = id ? `/shaders/${encodeURIComponent(id)}` : '/';
      if (this.router.url !== canonical) void this.router.navigateByUrl(canonical);
    });

    if (!isOutputWindow()) afterNextRender(() => void this.initializeRouting());
  }

  routeShaderId(): string | null {
    const match = /^\/shaders\/([^/?#]+)\/?(?:[?#].*)?$/.exec(this.router.url);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  private async initializeRouting(): Promise<void> {
    const requested = this.routeShaderId();
    await this.store.initializeClient(requested);
    this.routingReady = true;
    await this.normalizeRoute(requested);
    await this.workspace.resolveStaleRecovery();
    await this.workspace.resolveFirstRunMigration();
  }

  private async applyRoute(): Promise<void> {
    const requested = this.routeShaderId();
    if (!requested) {
      await this.normalizeRoute(null);
      return;
    }
    if (!this.store.shaders().some((shader) => shader.id === requested)) {
      this.store.notice.set({
        text: this.i18n.t('notice.shaderNotFound', { name: requested }),
        error: true,
      });
      await this.normalizeRoute(requested);
      return;
    }
    const changed = await this.workspace.selectShader(requested);
    if (!changed) await this.router.navigateByUrl(this.canonicalUrl(), { replaceUrl: true });
    else await this.workspace.resolveStaleRecovery();
  }

  private async normalizeRoute(requested: string | null): Promise<void> {
    const canonical = this.canonicalUrl();
    if (this.router.url !== canonical || requested !== this.store.selectedId()) {
      await this.router.navigateByUrl(canonical, { replaceUrl: true });
    }
  }

  private canonicalUrl(): string {
    const id = this.store.selectedId();
    return id ? `/shaders/${encodeURIComponent(id)}` : '/';
  }
}
