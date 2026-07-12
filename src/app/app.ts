import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
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
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { filter, map } from 'rxjs';

import type { ImportMode } from '../shared/model';
import { Preferences, type WorkspacePreferences } from './core/preferences';
import { DesktopPlatform } from './core/desktop-platform';
import { ShaderStore } from './core/shader-store';
import { GuiPanel } from './gui/gui-panel';
import { RendererHandle } from './rendering/renderer-handle';
import { ShaderCanvas } from './rendering/shader-canvas';
import { EditorShell } from './ui/editor-shell';
import { AppTitlebar } from './ui/app-titlebar';
import { PresetPanel } from './ui/preset-panel';
import { ShaderBrowser } from './ui/shader-browser';
import { TexturePanel } from './ui/texture-panel';
import { Workspace } from './ui/workspace';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppTitlebar,
    EditorShell,
    GuiPanel,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSidenavModule,
    MatToolbarModule,
    MatTooltipModule,
    PresetPanel,
    RouterOutlet,
    ShaderBrowser,
    ShaderCanvas,
    TexturePanel,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly workspace = inject(Workspace);
  protected readonly desktop = inject(DesktopPlatform);

  private readonly renderer = inject(RendererHandle);
  private readonly snackBar = inject(MatSnackBar);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private readonly router = inject(Router);
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

  protected readonly drawerOpen = computed(() => {
    if (this.desktop.fullscreen()) return false;
    return this.isHandset() ? this.handsetDrawerOpen() : this.preferences.value().browserOpen;
  });

  protected readonly darkMode = computed(() => this.preferences.value().colorScheme === 'dark');

  constructor() {
    // On the server, render the collection into the HTML. In the browser the
    // same work is deferred until after hydration, so the first client render
    // matches the markup the server produced (see ShaderStore's snapshot).
    if (this.isServer) {
      void this.store.initialize(this.routeShaderId());
    }

    afterNextRender(() => void this.initializeRouting());
    afterNextRender(() => {
      this.desktop.onCloseRequested(() => void this.handleDesktopClose());
    });
    afterNextRender(() => this.hintContextMenus());

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

  protected toggle(key: 'editorOpen' | 'guiVisible'): void {
    const patch = { [key]: !this.preferences.value()[key] } as Partial<WorkspacePreferences>;
    this.preferences.patch(patch);
  }

  protected toggleColorScheme(): void {
    this.preferences.patch({ colorScheme: this.darkMode() ? 'light' : 'dark' });
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

  protected pickFile(mode: ImportMode): void {
    if (this.desktop.available) {
      void this.workspace.importDesktop(mode);
      return;
    }
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

  protected exportCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.exportShader(record.id, record.name);
  }

  /**
   * Shortcuts, carried over from the original studio. They are ignored while a
   * text field or the code editor has focus: Space and S are just characters
   * when you are typing.
   */
  @HostListener('window:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;

    if (event.key === 'F11' && this.desktop.available) {
      event.preventDefault();
      this.desktop.toggleFullscreen();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.store.save();
      return;
    }

    if (this.isTyping(event.target)) return;

    switch (event.key.toLowerCase()) {
      case ' ':
        event.preventDefault();
        this.preferences.patch({ paused: !this.preferences.value().paused });
        break;
      case 'h':
        this.toggle('guiVisible');
        break;
      case 's':
        void this.renderer.screenshot(this.store.record()?.id ?? 'shader');
        break;
      default:
        break;
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
