import { isPlatformServer } from '@angular/common';
import { Injectable, PLATFORM_ID, afterNextRender, inject, isDevMode } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { McpBridge } from '../mcp/mcp-bridge';
import { isOutputWindow } from '../output-mode';
import { WorkspaceActions } from '../ui/workspace-actions';
import { OutputSync } from './output-sync';
import { RoutingCoordinator } from './routing-coordinator';
import { ShaderStore } from './shader-store';

/**
 * The app's one-time boot sequence: SSR snapshot hydration, the desktop
 * close guard, the dev-only MCP bridge, output-window mirroring, and the
 * first-run context-menu hint. Self-starting, like `ShaderStore` and
 * `RoutingCoordinator` — nothing outside this class calls anything on it.
 */
@Injectable({ providedIn: 'root' })
export class StartupCoordinator {
  private readonly store = inject(ShaderStore);
  private readonly routing = inject(RoutingCoordinator);
  private readonly desktop = inject(DesktopPlatform);
  private readonly workspace = inject(WorkspaceActions);
  private readonly outputSync = inject(OutputSync);
  private readonly mcpBridge = inject(McpBridge);
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18n);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  constructor() {
    const outputMode = isOutputWindow();

    if (outputMode) this.outputSync.startOutput();
    else this.outputSync.startController();

    // On the server, render the collection into the HTML. In the browser the
    // same work is deferred until after hydration, so the first client render
    // matches the markup the server produced (see ShaderStore's snapshot).
    if (this.isServer && !outputMode) {
      void this.store.initialize(this.routing.routeShaderId());
    }

    afterNextRender(() => {
      this.desktop.onCloseRequested(() => void this.handleDesktopClose());
    });
    if (!outputMode) afterNextRender(() => this.hintContextMenus());

    // Dev-only bridge for `mcp/server.ts`: lets an agent drive this tab's
    // store live. Never runs in a production build, and skipped on the
    // secondary output window, which mirrors the main tab rather than
    // hosting the editing session itself.
    if (!outputMode && isDevMode()) {
      afterNextRender(() => this.mcpBridge.start());
    }
  }

  private async handleDesktopClose(): Promise<void> {
    const approved = await this.workspace.guardedTransition(() => undefined);
    this.desktop.approveClose(approved);
  }

  private hintContextMenus(): void {
    if (this.isServer) return;
    const key = 'shader-studio.hinted-context-menus';
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      return;
    }
    this.snackBar.open(this.i18n.t('notice.contextMenuTip'), this.i18n.t('action.gotIt'), {
      duration: 6000,
      politeness: 'polite',
    });
  }
}
