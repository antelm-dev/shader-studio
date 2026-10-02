import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import {
  PUBLICATION_LICENSES,
  PUBLICATION_LIMITS,
  SHARE_ALIKE_LICENSE,
  type PublicationLicense,
  type ShaderPublicationStatus,
} from '@shadergrove/shared/publication';
import { LIMITS } from '@shadergrove/shared/validate';
import { ApiError } from '../api/shader-api';
import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/keys';
import { TranslatePipe } from '../i18n/translate.pipe';
import { ShaderStore } from '../workspace/shader-store';
import { PublicationApi } from './publication-api';

export interface PublishDialogData {
  shaderId: string;
  name: string;
}

/**
 * Publishing one of your shaders, from My Shaders.
 *
 * What goes public is the shader as it was last *saved* — a frozen copy. The
 * dialog says so, refuses while the open shader has unsaved edits, and sends
 * the revision it is looking at so a save from somewhere else in the meantime
 * is a conflict rather than a surprise. Later edits stay private until
 * "Update publication" is pressed here again.
 */
@Component({
  selector: 'app-publish-dialog',
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'publish.title' | translate: { name: data.name } }}</h2>

    <mat-dialog-content>
      @if (status(); as current) {
        <p class="state" role="status">
          <mat-icon aria-hidden="true">{{ stateIcon() }}</mat-icon>
          {{ stateKey() | translate }}
        </p>
        @if (link(); as url) {
          <p class="link">
            <a [href]="url" target="_blank" rel="noopener">{{ url }}</a>
            <button matButton type="button" (click)="copyLink(url)">
              {{ 'explore.copyLink' | translate }}
            </button>
          </p>
        }
        @if (current.origin; as origin) {
          <p class="note">
            {{
              'explore.basedOn'
                | translate
                  : { title: origin.title, author: origin.authorLabel, license: origin.license }
            }}
          </p>
        }

        @if (!current.restricted) {
          <p class="note">{{ 'publish.snapshotHint' | translate }}</p>
          @if (unsaved()) {
            <p class="warning" role="alert">
              {{ 'publish.unsaved' | translate }}
              <button matButton type="button" [disabled]="busy()" (click)="save()">
                {{ 'action.saveShader' | translate }}
              </button>
            </p>
          }

          <mat-form-field appearance="outline">
            <mat-label>{{ 'publish.author' | translate }}</mat-label>
            <input
              matInput
              required
              [maxLength]="authorLength"
              [value]="author()"
              (input)="author.set(value($event))"
            />
            <mat-hint>{{ 'publish.authorHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'publish.license' | translate }}</mat-label>
            <select
              matNativeControl
              [disabled]="shareAlike()"
              [value]="license()"
              (change)="license.set(licenseOf($event))"
            >
              @for (option of licenses; track option) {
                <option [value]="option" [selected]="option === license()">{{ option }}</option>
              }
            </select>
            @if (shareAlike()) {
              <mat-hint>{{ 'publish.shareAlike' | translate }}</mat-hint>
            }
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'publish.attribution' | translate }}</mat-label>
            <textarea
              matInput
              rows="2"
              [maxLength]="attributionLength"
              [value]="attribution()"
              (input)="attribution.set(value($event))"
            ></textarea>
            <mat-hint>{{ 'publish.attributionHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-checkbox [checked]="rights()" (change)="rights.set($event.checked)">
            {{ 'publish.rights' | translate }}
          </mat-checkbox>
        }
      } @else if (!error()) {
        <mat-progress-bar mode="indeterminate" [attr.aria-label]="'explore.loading' | translate" />
      }
      @if (error(); as text) {
        <p class="warning" role="alert">{{ text }}</p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
      @if (status()?.publication?.ownerVisible) {
        <button matButton type="button" [disabled]="busy()" (click)="unpublish()">
          {{ 'publish.unpublish' | translate }}
        </button>
      }
      @if (status() && !status()?.restricted) {
        <button matButton="filled" type="button" [disabled]="!canPublish()" (click)="publish()">
          {{
            (status()?.publication?.ownerVisible ? 'publish.update' : 'publish.publish') | translate
          }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: min(480px, 78vw);
    }

    .state {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      font: var(--mat-sys-title-small);
    }

    .link {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0;
      overflow-wrap: anywhere;
      font: var(--mat-sys-body-small);
    }

    .note,
    .warning {
      margin: 0 0 6px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .warning {
      color: var(--mat-sys-error);
    }

    mat-form-field {
      width: 100%;
    }
  `,
})
export class PublishDialog {
  protected readonly data = inject<PublishDialogData>(MAT_DIALOG_DATA);
  private readonly api = inject(PublicationApi);
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);
  private readonly document = inject(DOCUMENT);

  protected readonly licenses = PUBLICATION_LICENSES;
  protected readonly authorLength = LIMITS.nameLength;
  protected readonly attributionLength = PUBLICATION_LIMITS.attributionLength;

  protected readonly status = signal<ShaderPublicationStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly author = signal(inject(AuthService).displayName());
  protected readonly license = signal<PublicationLicense>('CC-BY-4.0');
  protected readonly attribution = signal('');
  protected readonly rights = signal(false);

  /** Only the open shader can have edits the server has not seen. */
  protected readonly unsaved = computed(
    () => this.store.selectedId() === this.data.shaderId && this.store.dirty(),
  );
  protected readonly shareAlike = computed(
    () => this.status()?.origin?.license === SHARE_ALIKE_LICENSE,
  );
  protected readonly canPublish = computed(
    () => !this.busy() && !this.unsaved() && this.rights() && this.author().trim().length > 0,
  );

  protected readonly stateKey = computed<TranslationKey>(() => {
    const status = this.status();
    if (status?.restricted) return 'publish.stateRestricted';
    const publication = status?.publication;
    if (!publication) return 'publish.statePrivate';
    if (publication.moderatorHidden) return 'publish.stateHidden';
    return publication.ownerVisible ? 'publish.statePublic' : 'publish.stateUnpublished';
  });
  protected readonly stateIcon = computed(() => {
    const key = this.stateKey();
    if (key === 'publish.statePublic') return 'public';
    return key === 'publish.statePrivate' || key === 'publish.stateUnpublished' ? 'lock' : 'block';
  });
  /** The stable public address, once there is a publication the world can open. */
  protected readonly link = computed(() => {
    const publication = this.status()?.publication;
    return publication?.ownerVisible && !publication.moderatorHidden
      ? `${this.document.location.origin}/explore/${publication.id}`
      : null;
  });

  constructor() {
    void this.run(async () => this.show(await this.api.status(this.data.shaderId)));
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected licenseOf(event: Event): PublicationLicense {
    return (event.target as HTMLSelectElement).value as PublicationLicense;
  }

  protected save(): Promise<void> {
    return this.run(async () => void (await this.store.save()));
  }

  protected publish(): Promise<void> {
    return this.run(async () => {
      const publication = await this.api.publish(this.data.shaderId, {
        expectedRevision: this.revision(),
        authorLabel: this.author().trim(),
        license: this.license(),
        attribution: this.attribution(),
        rightsConfirmed: true,
      });
      this.status.update((status) => status && { ...status, publication });
    });
  }

  protected unpublish(): Promise<void> {
    return this.run(async () => {
      const publication = await this.api.unpublish(this.data.shaderId);
      this.status.update((status) => status && { ...status, publication });
    });
  }

  protected async copyLink(url: string): Promise<void> {
    await navigator.clipboard.writeText(url).catch(() => undefined);
  }

  /** The saved revision this tab knows: what the owner is looking at, not whatever is newest. */
  private revision(): number {
    const open = this.store.record();
    if (open?.id === this.data.shaderId) return open.revision;
    return this.store.shaders().find((shader) => shader.id === this.data.shaderId)?.revision ?? 0;
  }

  private show(status: ShaderPublicationStatus): void {
    const previous = status.publication;
    if (previous) {
      this.author.set(previous.authorLabel);
      this.license.set(previous.license);
      this.attribution.set(previous.attribution);
    }
    if (status.origin?.license === SHARE_ALIKE_LICENSE) this.license.set(SHARE_ALIKE_LICENSE);
    this.status.set(status);
  }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      const known: Record<number, TranslationKey> = {
        403: 'publish.restricted',
        409: 'publish.conflict',
        429: 'explore.rateLimited',
      };
      this.error.set(
        known[status]
          ? this.i18n.t(known[status])
          : error instanceof ApiError
            ? error.summary
            : String(error),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
