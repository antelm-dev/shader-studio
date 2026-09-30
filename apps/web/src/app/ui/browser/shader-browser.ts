import { Component, computed, effect, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import type { SyncStatus } from '@shadergrove/desktop-api/contracts';
import type { ThumbnailMeta } from '@shadergrove/shared/model';
import { AuthService } from '../../auth/auth.service';
import { DesktopAccount } from '../../desktop/desktop-account';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { DesktopSync } from '../../desktop/desktop-sync';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { ThumbnailAssets } from '../../assets/thumbnail-assets';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';

/**
 * How long an opened shader is left to render before it is photographed for
 * the library: long enough to compile, decode its textures and get past the
 * black first frames of anything driven by time.
 */
const PREVIEW_SETTLE_MS = 2000;

/**
 * The library: every shader, as a row or as a card, with a preview.
 *
 * The rows are plain buttons in a list rather than a selection list: opening
 * a shader is navigation, not a selection you then act on, and `aria-current`
 * says which one is open. The arrow keys, Home and End move between them.
 */
@Component({
  selector: 'app-shader-browser',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <header class="browser-header">
      <h2 class="browser-title">
        {{ 'browser.title' | translate }}
        @if (store.shaders().length; as total) {
          <span class="count">{{ total }}</span>
        }
      </h2>
      @if (sync.progress(); as progress) {
        <span class="sync-progress" role="status">{{ 'sync.progress' | translate: progress }}</span>
      }
      <button
        matIconButton
        type="button"
        [matTooltip]="(grid() ? 'browser.viewList' : 'browser.viewGrid') | translate"
        [attr.aria-label]="(grid() ? 'browser.viewList' : 'browser.viewGrid') | translate"
        (click)="toggleView()"
      >
        <mat-icon>{{ grid() ? 'view_list' : 'grid_view' }}</mat-icon>
      </button>
      <button
        matIconButton
        type="button"
        [matTooltip]="'browser.new' | translate"
        [attr.aria-label]="'browser.create' | translate"
        (click)="workspace.createShader()"
      >
        <mat-icon>add</mat-icon>
      </button>
    </header>

    <label class="search">
      <mat-icon aria-hidden="true">search</mat-icon>
      <input
        #search
        type="search"
        class="search-input"
        autocomplete="off"
        spellcheck="false"
        [placeholder]="'browser.filter' | translate"
        [attr.aria-label]="'browser.filter' | translate"
        [value]="query()"
        (input)="query.set(search.value)"
      />
    </label>

    @if (filtered().length === 0) {
      <p class="empty">
        {{ (store.shaders().length === 0 ? 'browser.empty' : 'browser.noMatch') | translate }}
      </p>
    } @else {
      <ul
        class="shader-list"
        [class.grid]="grid()"
        [attr.aria-label]="'browser.title' | translate"
        (keydown)="onListKeydown($event)"
      >
        @for (shader of filtered(); track shader.id) {
          @let current = shader.id === store.selectedId();
          <li>
            <button
              type="button"
              class="shader-row"
              [class.selected]="current"
              [attr.aria-current]="current ? 'true' : null"
              [title]="'browser.contextTip' | translate"
              [matContextMenuTriggerFor]="rowMenu"
              [matContextMenuTriggerData]="{ shader }"
              (click)="select(shader.id)"
            >
              @let preview = previews()[shader.id];
              @if (preview) {
                <img class="row-preview" [src]="preview" alt="" />
              } @else {
                <span class="row-preview row-preview-empty" aria-hidden="true">
                  <mat-icon>blur_on</mat-icon>
                </span>
              }
              <span class="row-text">
                <span class="row-title">
                  @let status = syncShown() ? sync.statuses()[shader.id] : undefined;
                  @if (status) {
                    <mat-icon
                      class="sync-icon"
                      [class.sync-alert]="status === 'error' || status === 'reauth-required'"
                      role="img"
                      [attr.aria-label]="syncLabels[status] | translate"
                      [matTooltip]="syncLabels[status] | translate"
                      >{{ syncIcons[status] }}</mat-icon
                    >
                  }
                  {{ shader.name }}
                </span>
                <span class="row-meta">{{ meta(shader) }}</span>
              </span>
            </button>
          </li>
        }
      </ul>
    }

    <mat-menu #rowMenu="matMenu">
      <ng-template matMenuContent let-shader="shader">
        <button
          mat-menu-item
          type="button"
          (click)="workspace.renameShader(shader.id, shader.name)"
        >
          <mat-icon>edit</mat-icon>
          <span>{{ 'action.rename' | translate }}</span>
        </button>
        <button
          mat-menu-item
          type="button"
          (click)="workspace.duplicateShader(shader.id, shader.name)"
        >
          <mat-icon>content_copy</mat-icon>
          <span>{{ 'action.duplicate' | translate }}</span>
        </button>
        <button
          mat-menu-item
          type="button"
          (click)="workspace.exportShader(shader.id, shader.name)"
        >
          <mat-icon>download</mat-icon>
          <span>{{ 'action.export' | translate }}</span>
        </button>
        @if (syncShown()) {
          @switch (sync.statuses()[shader.id]) {
            @case ('local-only') {
              <button mat-menu-item type="button" (click)="sync.upload([shader.id])">
                <mat-icon>cloud_upload</mat-icon>
                <span>{{ 'sync.upload' | translate }}</span>
              </button>
            }
            @case ('error') {
              <button mat-menu-item type="button" (click)="sync.retry(shader.id)">
                <mat-icon>refresh</mat-icon>
                <span>{{ 'sync.retry' | translate }}</span>
              </button>
            }
          }
        }
        <button
          mat-menu-item
          type="button"
          (click)="workspace.deleteShader(shader.id, shader.name)"
        >
          <mat-icon>delete</mat-icon>
          <span>{{ 'action.delete' | translate }}</span>
        </button>
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }

    .browser-header {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 6px 6px 6px 14px;
    }

    .browser-title {
      display: flex;
      align-items: baseline;
      flex: 1;
      gap: 8px;
      margin: 0;
      font: var(--mat-sys-title-small);
    }

    .count {
      color: var(--mat-sys-on-surface-variant);
      font: 10.5px / 1 var(--studio-font-mono);
    }

    .sync-progress {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    /* A field the height of a row, not a form field: it filters what is
       already on screen and is cleared as often as it is typed into. */
    .search {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 6px;
      height: 28px;
      margin: 0 10px 8px;
      padding: 0 8px;
      border-radius: var(--mat-sys-corner-small);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 7%, transparent);
      cursor: text;
      transition: background-color 140ms ease;
    }

    .search:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 11%, transparent);
    }

    .search:focus-within {
      box-shadow: inset 0 0 0 1px var(--mat-sys-primary);
    }

    .search mat-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      color: var(--mat-sys-on-surface-variant);
      font-size: 16px;
    }

    .search-input {
      flex: 1;
      min-width: 0;
      height: 100%;
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }

    .search-input::placeholder {
      color: var(--mat-sys-on-surface-variant);
    }

    .shader-list {
      flex: 1;
      min-height: 0;
      margin: 0;
      padding: 0 6px 8px;
      overflow-y: auto;
      list-style: none;
    }

    .shader-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 5px 8px;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: transparent;
      color: var(--mat-sys-on-surface);
      text-align: left;
      cursor: pointer;
      transition: background-color 140ms ease;
    }

    .shader-row:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 7%, transparent);
    }

    .shader-row:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .shader-row.selected {
      background: var(--mat-sys-secondary-container);
    }

    /* The open shader is marked twice: a tint, and a bar that still reads when
       the tint is too quiet against a bright preview. */
    .shader-row.selected::before {
      content: '';
      position: absolute;
      top: 8px;
      bottom: 8px;
      left: 0;
      width: 2px;
      border-radius: 1px;
      background: var(--mat-sys-primary);
    }

    /* A 16:9 frame, like the thing it is a picture of. */
    .row-preview {
      flex: 0 0 auto;
      width: 60px;
      aspect-ratio: 16 / 9;
      border-radius: 3px;
      object-fit: cover;
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--mat-sys-on-surface) 10%, transparent);
    }

    .row-preview-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--mat-sys-on-surface-variant);
    }

    .row-preview-empty mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
      opacity: 0.6;
    }

    .row-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .row-title,
    .row-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-title {
      font: var(--mat-sys-body-medium);
    }

    .row-meta {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .sync-icon {
      width: 14px;
      height: 14px;
      margin-inline-end: 3px;
      color: var(--mat-sys-on-surface-variant);
      font-size: 14px;
      vertical-align: -2px;
    }

    .sync-icon.sync-alert {
      color: var(--mat-sys-error);
    }

    /* Grid: the preview is the row, and the name sits under it. */
    .shader-list.grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
      align-content: start;
      gap: 6px;
      padding-inline: 10px;
    }

    .grid .shader-row {
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      padding: 5px;
    }

    .grid .row-preview {
      width: 100%;
    }

    .grid .row-preview-empty mat-icon {
      width: 20px;
      height: 20px;
      font-size: 20px;
    }

    .grid .row-meta {
      display: none;
    }

    .grid .row-title {
      font: var(--mat-sys-label-medium);
    }

    .grid .shader-row.selected::before {
      display: none;
    }

    .grid .shader-row.selected .row-preview {
      box-shadow: 0 0 0 2px var(--mat-sys-primary);
    }

    .empty {
      margin: 4px 16px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    @media (pointer: coarse) {
      .search {
        height: 40px;
      }

      .shader-row {
        padding-block: 8px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .search,
      .shader-row {
        transition: none;
      }
    }
  `,
})
export class ShaderBrowser {
  protected readonly i18n = inject(I18n);
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly sync = inject(DesktopSync);
  private readonly account = inject(DesktopAccount);
  private readonly preferences = inject(Preferences);
  private readonly auth = inject(AuthService);
  private readonly desktop = inject(DesktopPlatform);

  private readonly thumbnails = inject(ThumbnailAssets);

  protected readonly syncIcons: Record<SyncStatus, string> = {
    'local-only': 'cloud_off',
    synced: 'cloud_done',
    pending: 'cloud_upload',
    syncing: 'sync',
    'conflict-resolved': 'call_split',
    'reauth-required': 'lock',
    'other-account': 'no_accounts',
    error: 'error',
  };

  protected readonly syncLabels: Record<SyncStatus, TranslationKey> = {
    'local-only': 'sync.localOnly',
    synced: 'sync.synced',
    pending: 'sync.pending',
    syncing: 'sync.syncing',
    'conflict-resolved': 'sync.conflictResolved',
    'reauth-required': 'sync.reauthRequired',
    'other-account': 'sync.otherAccount',
    error: 'sync.error',
  };

  /** Sync icons and actions only with an account to sync with. */
  protected readonly syncShown = computed(() => {
    const status = this.account.state().status;
    return status === 'signed-in' || status === 'reauth-required';
  });

  protected readonly query = signal('');
  protected readonly grid = computed(() => this.preferences.value().browserView === 'grid');

  /** The desktop's library is local; on the web, writing needs a confirmed address. */
  private readonly writable = computed(() => this.desktop.available || this.auth.verified());

  /** Preview URL per shader id, for the shaders that have one. */
  protected readonly previews = computed(() => {
    const blobs = this.blobs();
    const previews: Record<string, string> = {};

    for (const shader of this.store.shaders()) {
      // On the web this is the URL itself; on desktop it is null until the
      // bytes have come over IPC, and `blobs` fills in behind it.
      const url = this.thumbnails.url(shader.id, shader.thumbnail) ?? blobs[shader.id];
      if (url) previews[shader.id] = url;
    }
    return previews;
  });

  /** Desktop only: blob URLs, filled in as the IPC reads land. */
  private readonly blobs = signal<Record<string, string>>({});

  /** Which `<id>:<capture>` pairs have already been asked for, so a re-save re-reads. */
  private readonly requested = new Set<string>();

  constructor() {
    effect(() => {
      for (const shader of this.store.shaders()) {
        if (!shader.thumbnail) continue;

        const key = `${shader.id}:${shader.thumbnail.updatedAt}`;
        if (this.requested.has(key)) continue;
        this.requested.add(key);
        void this.resolveBlob(shader.id, shader.thumbnail);
      }
    });

    // A shader opened without a preview gets one from what is on screen, once
    // it has had a moment to render. Switching away first cancels it; the
    // store decides whether what is on screen is fit to be photographed.
    //
    // Only where the library can be written. An account that has not confirmed
    // its address is read-only, and an upload nobody asked for would come back
    // 401 and open a sign-in dialog out of nowhere.
    effect((onCleanup) => {
      const record = this.store.record();
      if (!record || record.thumbnail || !this.writable()) return;

      const timer = setTimeout(
        () => this.store.captureMissingPreview(record.id),
        PREVIEW_SETTLE_MS,
      );
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async resolveBlob(id: string, thumbnail: ThumbnailMeta): Promise<void> {
    const url = await this.thumbnails.resolve(id, thumbnail);
    if (url === null) return;

    this.blobs.update((blobs) => ({ ...blobs, [id]: url }));
  }

  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    const shaders = this.store.shaders();
    if (!query) return shaders;

    return shaders.filter(
      (shader) =>
        shader.name.toLowerCase().includes(query) ||
        shader.description.toLowerCase().includes(query),
    );
  });

  protected meta(shader: { controlCount: number; presetCount: number }): string {
    const controls =
      shader.controlCount === 1
        ? this.i18n.t('browser.controlOne')
        : this.i18n.t('browser.controlMany', { count: shader.controlCount });
    const presets =
      shader.presetCount === 1
        ? this.i18n.t('browser.presetOne')
        : this.i18n.t('browser.presetMany', { count: shader.presetCount });
    return this.i18n.t('browser.meta', { controls, presets });
  }

  protected select(id: string): void {
    void this.workspace.selectShader(id);
  }

  protected toggleView(): void {
    this.preferences.patch({ browserView: this.grid() ? 'list' : 'grid' });
  }

  /** Arrow keys, Home and End move the focus between rows. */
  protected onListKeydown(event: KeyboardEvent): void {
    const rows = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.shader-row'),
    ];
    const current = rows.indexOf(event.target as HTMLElement);
    if (current < 0) return;

    // ponytail: every arrow steps one row, so Up/Down in the grid move along
    // the reading order instead of by a column. Count the columns if the grid
    // ever gets wide enough for that to matter.
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : step === undefined
            ? null
            : current + step;
    if (target === null) return;

    event.preventDefault();
    rows[Math.min(rows.length - 1, Math.max(0, target))].focus();
  }
}
