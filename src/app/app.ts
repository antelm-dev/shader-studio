import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavContainer, MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { map } from 'rxjs';

import type { ImportMode } from '@shader-studio/shared/model';
import { DEFAULT_PANEL_WIDTHS, PANEL_LIMITS } from '@shader-studio/shared/panel-prefs';
import {
  COLOR_SCHEME_OPTIONS,
  Preferences,
  colorSchemeIcon,
  type ColorScheme,
} from './prefs/preferences';
import { DesktopPlatform } from './desktop/desktop-platform';
import { McpBridge } from './mcp/mcp-bridge';
import { ShaderStore } from './workspace/shader-store';
import { OutputSync } from './workspace/output-sync';
import { EditorWindow } from './editor/editor-window';
import { EditorShell } from './ui/editor/editor-shell';
import { AppTitlebar } from './ui/layout/app-titlebar';
import { DocumentStatus } from './ui/editor/document-status';
import { GlobalShortcuts } from './ui/layout/global-shortcuts';
import { InspectorPanel } from './ui/inspector/inspector-panel';
import { MenuCommands, type MenuCommand } from './ui/menu-commands';
import { isOutputWindow } from './output-mode';
import { PreviewShell } from './ui/preview/preview-shell';
import { PreviewStage } from './ui/preview/preview-stage';
import { ResizeHandle } from './ui/layout/resize-handle';
import { RoutingCoordinator } from './workspace/routing-coordinator';
import { ShaderBrowser } from './ui/browser/shader-browser';
import { WorkspaceActions } from './ui/workspace-actions';
import { I18n, LANGUAGE_OPTIONS, type AppLocale } from './i18n/i18n';
import { TranslatePipe } from './i18n/translate.pipe';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [GlobalShortcuts],
  imports: [
    AppTitlebar,
    EditorShell,
    InspectorPanel,
    TranslatePipe,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSidenavModule,
    MatToolbarModule,
    MatTooltipModule,
    PreviewShell,
    PreviewStage,
    ResizeHandle,
    RouterOutlet,
    ShaderBrowser,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly status = inject(DocumentStatus);
  protected readonly commands = inject(MenuCommands);
  protected readonly editorWindow = inject(EditorWindow);
  protected readonly i18n = inject(I18n);
  protected readonly outputMode = isOutputWindow();

  private readonly snackBar = inject(MatSnackBar);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private readonly routing = inject(RoutingCoordinator);
  private readonly outputSync = inject(OutputSync);
  private readonly mcpBridge = inject(McpBridge);

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  private readonly importMode = signal<ImportMode>('rename');

  protected readonly isHandset = toSignal(
    inject(BreakpointObserver)
      .observe([Breakpoints.Handset, Breakpoints.TabletPortrait])
      .pipe(map((state) => state.matches)),
    { initialValue: false },
  );

  /**
   * On a handset the drawer covers the whole screen, so it starts closed and is
   * not remembered — the saved `browserOpen` preference describes the desktop
   * rail, where an open drawer costs nothing.
   */
  private readonly handsetDrawerOpen = signal(false);

  protected readonly drawerOpen = computed(() =>
    this.isHandset() ? this.handsetDrawerOpen() : this.preferences.value().browserOpen,
  );

  protected readonly colorSchemeOptions = COLOR_SCHEME_OPTIONS;
  protected readonly languageOptions = LANGUAGE_OPTIONS;
  protected readonly themeIcon = computed(() =>
    colorSchemeIcon(this.preferences.value().colorScheme),
  );

  protected readonly inspectorOpen = computed(() => this.preferences.value().guiVisible);

  // --- Menus --------------------------------------------------------------
  // One section of the "More actions" menu each. The items that are not plain
  // icon-label-verb rows — the Theme submenu, the desktop-only output window —
  // stay written out in the template, where their exceptions are visible.

  protected readonly viewCommands: readonly MenuCommand[] = [
    {
      id: 'toggle-inspector',
      icon: () => 'tune',
      label: () =>
        this.i18n.t(
          this.preferences.value().guiVisible ? 'action.hideInspector' : 'action.showInspector',
        ),
      shortcut: 'H',
      action: () => this.commands.toggle('guiVisible'),
    },
    this.commands.toggleEditor,
    {
      id: 'capture-image',
      icon: () => 'photo_camera',
      label: () => this.i18n.t('action.captureImage'),
      disabled: () => !this.store.record(),
      shortcut: 'S',
      action: () => this.commands.captureImage(),
    },
    this.commands.exportSequence,
  ];

  protected readonly shaderCommands: readonly MenuCommand[] = [
    this.commands.newShader,
    this.commands.renameShader,
    this.commands.duplicateShader,
  ];

  protected readonly importExportCommands: readonly MenuCommand[] = [
    this.commands.import('rename', 'action.importShader'),
    this.commands.import('overwrite', 'action.importReplace'),
    {
      id: 'import-shadertoy',
      icon: () => 'public',
      label: () => this.i18n.t('action.importShadertoy'),
      action: () => void this.workspace.importShadertoy(),
    },
    this.commands.exportShader,
    this.commands.exportAll,
  ];

  /** The context menu on the document title. It only opens over a shader. */
  protected readonly documentCommands: readonly MenuCommand[] = [
    this.commands.renameShader,
    this.commands.duplicateShader,
    this.commands.exportShader,
    {
      id: 'delete-shader',
      icon: () => 'delete',
      label: () => this.i18n.t('action.deleteShader'),
      action: () => this.commands.deleteCurrent(),
    },
  ];

  // --- Panel widths -------------------------------------------------------

  protected readonly panelLimits = PANEL_LIMITS;
  protected readonly defaultWidths = DEFAULT_PANEL_WIDTHS;

  /**
   * The width a separator is currently being dragged to, if one is.
   *
   * While it is set the panel renders from here instead of from `Preferences`,
   * which is only written once the gesture ends — see `ResizeHandle`.
   */
  protected readonly liveBrowserWidth = signal<number | null>(null);
  protected readonly liveInspectorWidth = signal<number | null>(null);

  protected readonly browserWidth = computed(
    () => this.liveBrowserWidth() ?? this.preferences.value().browserWidth,
  );
  protected readonly inspectorWidth = computed(
    () => this.liveInspectorWidth() ?? this.preferences.value().inspectorWidth,
  );

  private readonly sidenavContainer = viewChild.required(MatSidenavContainer);

  constructor() {
    if (this.outputMode) this.outputSync.startOutput();
    else this.outputSync.startController();

    // The hidden input the browser imports go through is in this template.
    if (!this.outputMode) this.commands.useFilePicker((mode) => this.pickFile(mode));
    /**
     * A side drawer offsets the content with a margin that Material measures for
     * itself — on open, on close, and on a viewport change, but *not* when the
     * drawer's own width changes underneath it. Dragging the separator is exactly
     * that case, so it has to be asked.
     *
     * It has to be asked *after* the frame is rendered, which is why this is an
     * `afterRenderEffect` and not an `effect`. `updateContentMargins` does not
     * take a width — it measures the drawer's `offsetWidth` off the DOM. A plain
     * effect runs before Angular has flushed the `[style.width.px]` binding, so
     * Material would measure the width the drawer had *before* the drag and the
     * content would settle one gesture behind: the drawer grows, the content
     * stays put and is overlapped by it, and the separator — which is pinned to
     * the content's left edge — is left stranded inside the drawer, where it can
     * no longer be grabbed. You get exactly one resize.
     */
    afterRenderEffect(() => {
      if (this.outputMode) return;
      this.browserWidth();
      this.drawerOpen();
      this.sidenavContainer().updateContentMargins();
    });

    // On the server, render the collection into the HTML. In the browser the
    // same work is deferred until after hydration, so the first client render
    // matches the markup the server produced (see ShaderStore's snapshot).
    if (this.isServer && !this.outputMode) {
      void this.store.initialize(this.routing.routeShaderId());
    }

    afterNextRender(() => {
      this.desktop.onCloseRequested(() => void this.handleDesktopClose());
    });
    if (!this.outputMode) afterNextRender(() => this.hintContextMenus());

    // Dev-only bridge for `mcp/server.ts`: lets an agent drive this tab's
    // store live. Never runs in a production build, and skipped on the
    // secondary output window, which mirrors the main tab rather than
    // hosting the editing session itself.
    if (!this.outputMode && isDevMode()) {
      afterNextRender(() => this.mcpBridge.start());
    }

    // Picking a shader on a handset should get the drawer out of the way — it
    // is covering the very thing you just chose to look at.
    effect(() => {
      this.store.selectedId();
      untracked(() => {
        if (this.isHandset()) this.handsetDrawerOpen.set(false);
      });
    });

    effect(() => {
      const notice = this.store.notice();
      if (!notice) return;

      this.snackBar.open(notice.text, this.i18n.t('action.dismiss'), {
        duration: notice.error ? 8000 : 3000,
        politeness: notice.error ? 'assertive' : 'polite',
      });
      this.store.notice.set(null);
    });
  }

  protected commitBrowserWidth(width: number): void {
    this.liveBrowserWidth.set(null);
    this.preferences.patch({ browserWidth: width });
  }

  protected commitInspectorWidth(width: number): void {
    this.liveInspectorWidth.set(null);
    this.preferences.patch({ inspectorWidth: width });
  }

  protected setColorScheme(colorScheme: ColorScheme): void {
    this.preferences.patch({ colorScheme });
  }

  protected setLanguage(language: AppLocale): void {
    this.i18n.setLocale(language);
  }

  protected themeLabel(theme: ColorScheme): string {
    return this.i18n.t(`theme.${theme}`);
  }

  protected toggleBrowser(): void {
    if (this.isHandset()) {
      this.handsetDrawerOpen.update((open) => !open);
    } else {
      this.preferences.patch({ browserOpen: !this.preferences.value().browserOpen });
    }
  }

  protected closeBrowser(): void {
    if (this.isHandset()) {
      this.handsetDrawerOpen.set(false);
    } else {
      this.preferences.patch({ browserOpen: false });
    }
  }

  /** The browser half of an import: the desktop opens its own dialog instead. */
  private pickFile(mode: ImportMode): void {
    this.importMode.set(mode);
    const input = this.fileInput().nativeElement;
    // Reset first, so picking the same file twice still fires a change event.
    input.value = '';
    input.click();
  }

  protected async onFilePicked(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) await this.workspace.importFile(file, this.importMode());
  }

  /** Opening the editor is what an error badge is *for*. */
  protected showEditor(): void {
    this.preferences.patch({ editorOpen: true });
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
