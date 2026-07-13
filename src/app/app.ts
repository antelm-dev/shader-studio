import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
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
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavContainer, MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { filter, map } from 'rxjs';

import type { ImportMode } from '@shader-studio/shared/model';
import { DEFAULT_PANEL_WIDTHS, PANEL_LIMITS } from './core/panel-prefs';
import {
  COLOR_SCHEME_OPTIONS,
  Preferences,
  colorSchemeIcon,
  type ColorScheme,
} from './core/preferences';
import { DesktopPlatform } from './core/desktop-platform';
import { McpBridge } from './core/mcp-bridge';
import { ShaderStore } from './core/shader-store';
import { OutputSync } from './core/output-sync';
import { ShaderCanvas } from './rendering/shader-canvas';
import { EditorShell } from './ui/editor-shell';
import { AppTitlebar } from './ui/app-titlebar';
import { DocumentStatus } from './ui/document-status';
import { InspectorPanel } from './ui/inspector-panel';
import { MenuCommands, type MenuCommand } from './ui/menu-commands';
import { ResizeHandle } from './ui/resize-handle';
import { ShaderBrowser } from './ui/shader-browser';
import { Workspace } from './ui/workspace';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppTitlebar,
    EditorShell,
    InspectorPanel,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSidenavModule,
    MatToolbarModule,
    MatTooltipModule,
    ResizeHandle,
    RouterOutlet,
    ShaderBrowser,
    ShaderCanvas,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly workspace = inject(Workspace);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly status = inject(DocumentStatus);
  protected readonly commands = inject(MenuCommands);
  protected readonly outputMode =
    typeof window !== 'undefined' && window.location.pathname.replace(/\/$/, '') === '/output';

  private readonly snackBar = inject(MatSnackBar);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private readonly router = inject(Router);
  private readonly outputSync = inject(OutputSync);
  private readonly mcpBridge = inject(McpBridge);
  private routingReady = false;

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
      label: () => (this.preferences.value().guiVisible ? 'Hide inspector' : 'Show inspector'),
      shortcut: 'H',
      action: () => this.commands.toggle('guiVisible'),
    },
    this.commands.toggleEditor,
    {
      id: 'capture-image',
      icon: () => 'photo_camera',
      label: () => 'Capture image',
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
    this.commands.import('rename', 'Import shader…'),
    this.commands.import('overwrite', 'Import and replace…'),
    {
      id: 'import-shadertoy',
      icon: () => 'public',
      label: () => 'Import from Shadertoy…',
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
      label: () => 'Delete shader…',
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
      void this.store.initialize(this.routeShaderId());
    }

    if (!this.outputMode) afterNextRender(() => void this.initializeRouting());
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

    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe(() => {
        if (this.routingReady) void this.applyRoute();
      });

    effect(() => {
      const id = this.store.selectedId();
      if (!this.routingReady) return;
      const canonical = id ? `/shaders/${encodeURIComponent(id)}` : '/';
      if (this.router.url !== canonical) void this.router.navigateByUrl(canonical);
    });

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

      this.snackBar.open(notice.text, 'Dismiss', {
        duration: notice.error ? 8000 : 3000,
        politeness: notice.error ? 'assertive' : 'polite',
      });
      this.store.notice.set(null);
    });
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
      this.store.notice.set({ text: `Shader “${requested}” was not found`, error: true });
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

  private routeShaderId(): string | null {
    const match = /^\/shaders\/([^/?#]+)\/?(?:[?#].*)?$/.exec(this.router.url);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
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

  /**
   * Shortcuts, carried over from the original studio.
   *
   * The split matters. The chorded ones — Ctrl+S, Ctrl+N, the tab shortcuts —
   * work *while you are typing*, because that is exactly when you want them:
   * saving and switching files are things you do with your hands on the keyboard,
   * mid-edit. The bare-letter ones (Space, H, S) are ignored inside a text field
   * or the code editor, where they are simply characters.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    if (event.key === 'F11' && this.desktop.available) {
      event.preventDefault();
      this.desktop.toggleFullscreen();
      return;
    }

    if (this.onChordKeydown(event)) return;
    if (this.isTyping(event.target)) return;

    switch (event.key.toLowerCase()) {
      case ' ':
        event.preventDefault();
        this.preferences.patch({ paused: !this.preferences.value().paused });
        break;
      case 'h':
        this.commands.toggle('guiVisible');
        break;
      case 's':
        this.commands.captureImage();
        break;
      default:
        break;
    }
  }

  /** Returns true when the event was one of ours and has been handled. */
  private onChordKeydown(event: KeyboardEvent): boolean {
    const chord = event.ctrlKey || event.metaKey;
    if (!chord) return false;

    const key = event.key.toLowerCase();

    switch (key) {
      case 's':
        event.preventDefault();
        void this.store.save();
        return true;

      case 'n':
        event.preventDefault();
        void this.workspace.createFile();
        return true;

      // Run/compile. The preview already recompiles as you type, so this is the
      // "do it *now*" that a debounce always makes someone want.
      case 'enter':
        event.preventDefault();
        this.store.recompile();
        return true;

      case 'w':
        event.preventDefault();
        void this.closeActiveDoc();
        return true;

      case 'pageup':
        event.preventDefault();
        this.store.cycleDoc(-1);
        return true;

      case 'pagedown':
        event.preventDefault();
        this.store.cycleDoc(1);
        return true;

      default:
        break;
    }

    // Ctrl+1…9 opens the nth tab, the way every editor with tabs does.
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const doc = this.store.documents()[digit - 1];
      if (doc) {
        event.preventDefault();
        this.store.selectDoc(doc.id);
        return true;
      }
    }

    return false;
  }

  /** Ctrl+W closes the open tab — when it is one that can be closed. */
  private async closeActiveDoc(): Promise<void> {
    const doc = this.store.activeDoc();
    if (!doc) return;

    // The Image pass, Common, Vertex and Config are fixtures: there is exactly
    // one of each and the shader is not a shader without them.
    if (doc.passKind === 'buffer' || doc.kind === 'file') {
      await this.workspace.deleteDocument(doc);
    }
  }

  @HostListener('window:beforeunload', ['$event'])
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.desktop.available || !this.store.dirty()) return;
    this.store.flushRecovery();
    event.preventDefault();
    event.returnValue = '';
  }

  private async handleDesktopClose(): Promise<void> {
    const approved = await this.workspace.guardedTransition(() => undefined);
    this.desktop.approveClose(approved);
  }

  private isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.closest('.monaco-editor') !== null
    );
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
    this.snackBar.open(
      'Tip: right-click the preview, shaders, presets or editor bar for actions',
      'Got it',
      {
        duration: 6000,
        politeness: 'polite',
      },
    );
  }
}
