import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import type { SyncStatus } from '@shader-studio/desktop-api/contracts';
import type { ThumbnailMeta } from '@shader-studio/shared/model';
import { DesktopSync } from '../../desktop/desktop-sync';
import { ShaderStore } from '../../workspace/shader-store';
import { ThumbnailAssets } from '../../assets/thumbnail-assets';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';

@Component({
  selector: 'app-shader-browser',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  template: `
    <header class="browser-header">
      <h2 class="browser-title">{{ 'browser.title' | translate }}</h2>
      @if (sync.progress(); as progress) {
        <span class="sync-progress" role="status">{{ 'sync.progress' | translate: progress }}</span>
      }
      @if (hasLocalOnly()) {
        <button
          matIconButton
          type="button"
          [matTooltip]="'sync.uploadAll' | translate"
          [attr.aria-label]="'sync.uploadAll' | translate"
          (click)="sync.uploadAll()"
        >
          <mat-icon>cloud_upload</mat-icon>
        </button>
      }
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

    <mat-form-field appearance="fill" subscriptSizing="dynamic" class="search">
      <mat-icon matPrefix>search</mat-icon>
      <mat-label>{{ 'browser.filter' | translate }}</mat-label>
      <input
        matInput
        type="search"
        autocomplete="off"
        [ngModel]="query()"
        (ngModelChange)="query.set($event)"
      />
    </mat-form-field>

    @if (filtered().length === 0) {
      <p class="empty">
        {{ (store.shaders().length === 0 ? 'browser.empty' : 'browser.noMatch') | translate }}
      </p>
    } @else {
      <mat-selection-list
        class="shader-list"
        [attr.aria-label]="'browser.title' | translate"
        [multiple]="false"
        [hideSingleSelectionIndicator]="true"
        (selectionChange)="select($event.options[0].value)"
      >
        @for (shader of filtered(); track shader.id) {
          <mat-list-option
            class="shader-row"
            [class.selected]="shader.id === store.selectedId()"
            [value]="shader.id"
            [selected]="shader.id === store.selectedId()"
            [title]="'browser.contextTip' | translate"
            [matContextMenuTriggerFor]="rowMenu"
            [matContextMenuTriggerData]="{ shader }"
          >
            @let preview = previews()[shader.id];
            @if (preview) {
              <img matListItemAvatar class="row-preview" [src]="preview" alt="" />
            } @else {
              <span matListItemAvatar class="row-preview row-preview-empty" aria-hidden="true">
                <mat-icon>image</mat-icon>
              </span>
            }
            <span matListItemTitle class="row-title">
              @let status = sync.statuses()[shader.id];
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
            <span matListItemLine class="row-meta">{{ meta(shader) }}</span>
          </mat-list-option>
        }
      </mat-selection-list>
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
        @if (uploadable(shader.id)) {
          <button mat-menu-item type="button" (click)="sync.upload([shader.id])">
            <mat-icon>cloud_upload</mat-icon>
            <span>{{ 'sync.upload' | translate }}</span>
          </button>
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
      gap: 4px;
      padding: 12px 8px 4px 16px;
    }

    .browser-title {
      flex: 1;
      margin: 0;
      font: var(--mat-sys-title-medium);
    }

    .sync-progress {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .search {
      margin: 4px 12px 8px;
    }

    .shader-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding-top: 0;
    }

    .shader-row {
      cursor: context-menu;
      transition: background-color 120ms ease;
      /* Reserve the width of a 16:9 preview in the leading slot, not a square. */
      --mat-list-list-item-leading-avatar-size: 64px;
    }

    /*
     * A leading avatar is a round 40px portrait by Material's own rules, and a
     * shader preview is a 16:9 frame. Overriding both takes the same
     * specificity Material uses (class + class), hence the doubled selector.
     */
    .shader-row .row-preview.row-preview {
      width: 64px;
      height: 36px;
      border-radius: 4px;
      object-fit: cover;
      background: var(--mat-sys-surface-container-highest);
    }

    .row-preview-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--mat-sys-on-surface-variant);
    }

    .row-preview-empty mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
      opacity: 0.6;
    }

    .shader-row.selected {
      background: color-mix(in srgb, var(--mat-sys-primary) 16%, transparent);
    }

    .shader-row.selected:hover {
      background: color-mix(in srgb, var(--mat-sys-primary) 22%, transparent);
    }

    .row-title {
      font: var(--mat-sys-body-large);
    }

    .sync-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      vertical-align: -2px;
      margin-inline-end: 4px;
      color: var(--mat-sys-on-surface-variant);
    }

    .sync-icon.sync-alert {
      color: var(--mat-sys-error);
    }

    .row-meta {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .empty {
      margin: 8px 16px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class ShaderBrowser {
  protected readonly i18n = inject(I18n);
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly sync = inject(DesktopSync);
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

  protected readonly hasLocalOnly = computed(() =>
    Object.values(this.sync.statuses()).includes('local-only'),
  );

  /** Unlinked, or a failed upload to retry; the main process skips anything linked. */
  protected uploadable(id: string): boolean {
    const status = this.sync.statuses()[id];
    return status === 'local-only' || status === 'error';
  }

  protected readonly query = signal('');

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
}
