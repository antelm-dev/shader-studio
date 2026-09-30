import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';

import {
  PUBLICATION_LIMITS,
  type AdminPublicationDetail,
  type AdminPublicationSummary,
  type AdminReport,
  type ModerationAction,
  type ModerationAuditEntry,
  type PublicationStateFilter,
  type PublisherRestriction,
  type ReportStatusFilter,
} from '@shadergrove/shared/publication';
import { ApiError } from '../api/shader-api';
import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/keys';
import { TranslatePipe } from '../i18n/translate.pipe';
import { ExploreAccess } from '../publications/explore-access';
import { PAGE_STYLES } from '../publications/page';
import { AdminApi } from './admin-api';

type Tab = 'publications' | 'reports' | 'history';
type ActionKind = 'hide' | 'restore' | 'resolve' | 'restrict' | 'unrestrict';

/** A moderation write the operator has started and not yet confirmed. */
interface PendingAction {
  kind: ActionKind;
  /** A publication id, a report id or an account id, depending on `kind`. */
  targetId: string;
  /** What the confirmation names: a title, or an id. */
  subject: string;
}

const ACTION_LABELS: Record<ActionKind, TranslationKey> = {
  hide: 'admin.hide',
  restore: 'admin.restore',
  resolve: 'admin.resolve',
  restrict: 'admin.restrict',
  unrestrict: 'admin.unrestrict',
};

const AUDIT_LABELS: Record<ModerationAction, TranslationKey> = {
  'publication.hide': 'admin.hide',
  'publication.restore': 'admin.restore',
  'report.resolve': 'admin.resolve',
  'publisher.restrict': 'admin.restrict',
  'publisher.unrestrict': 'admin.unrestrict',
};

/**
 * `/admin/publications`: the moderator's view of Explore — every publication
 * whatever its visibility, the reports against them, publishing restrictions,
 * and the history of what was done and why.
 *
 * Three rules shape it:
 *
 *  - Everything on screen came from the server. After any write, confirmed or
 *    refused as stale, the lists are read again rather than patched locally, so
 *    the page never shows a success the server did not record.
 *  - A write needs a reason and the revision the operator was looking at. When
 *    someone else got there first the server says so; the view is refreshed and
 *    the reason is kept, so confirming again is a decision about the new state.
 *  - The records belong to a session. They are loaded only once the server has
 *    said this account moderates, and dropped the moment that stops being true
 *    — sign-out, expiry, another account — along with anything half-entered.
 *    Nothing is fetched during SSR, and nothing is retried on its own.
 */
@Component({
  selector: 'app-admin-publications-page',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    NgTemplateOutlet,
    RouterLink,
    TranslatePipe,
  ],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/">
        <mat-icon>arrow_back</mat-icon>
        {{ 'explore.backToEditor' | translate }}
      </a>
      <h1>{{ 'admin.title' | translate }}</h1>
      @if (admin()) {
        <div class="tabs" role="tablist">
          @for (entry of tabs; track entry.id) {
            <button
              matButton
              type="button"
              role="tab"
              [class.current]="tab() === entry.id"
              [attr.aria-selected]="tab() === entry.id"
              (click)="show(entry.id)"
            >
              {{ entry.label | translate }}
            </button>
          }
        </div>
        <button matButton type="button" [disabled]="busy()" (click)="refresh()">
          <mat-icon>refresh</mat-icon>
          {{ 'admin.refresh' | translate }}
        </button>
      }
    </header>

    <main [attr.aria-busy]="busy()">
      @if (!admin()) {
        <p class="status" role="status">
          {{ (auth.status() === 'loading' ? 'admin.loading' : 'admin.forbidden') | translate }}
        </p>
      } @else {
        @if (busy()) {
          <mat-progress-bar mode="indeterminate" [attr.aria-label]="'admin.loading' | translate" />
        }
        @if (problem(); as message) {
          <p class="problem" role="alert">{{ message }}</p>
        }

        @if (pending(); as action) {
          <form class="action" (submit)="confirm($event)">
            <h2>{{ actionLabels[action.kind] | translate }}: {{ action.subject }}</h2>
            @if (hints[action.kind]; as hint) {
              <p class="hint">{{ hint | translate }}</p>
            }
            <label for="admin-reason">{{ 'admin.reason' | translate }}</label>
            <textarea
              id="admin-reason"
              rows="2"
              required
              [maxLength]="reasonLength"
              [value]="reason()"
              (input)="reason.set(value($event))"
            ></textarea>
            <p class="hint">{{ 'admin.reasonRequired' | translate }}</p>
            <div class="row-actions">
              <button matButton type="button" (click)="cancel()">
                {{ 'action.cancel' | translate }}
              </button>
              <button matButton="filled" type="submit" [disabled]="busy() || !reason().trim()">
                {{ 'action.confirm' | translate }}
              </button>
            </div>
          </form>
        }

        @if (inspected(); as item) {
          <section class="inspect" [attr.aria-label]="item.title">
            <div class="row-head">
              <h2>{{ item.title }}</h2>
              <button matButton type="button" (click)="inspected.set(null)">
                {{ 'admin.closeInspect' | translate }}
              </button>
            </div>
            <ng-container
              [ngTemplateOutlet]="facts"
              [ngTemplateOutletContext]="{ $implicit: item }"
            />
            @if (item.description) {
              <p>{{ item.description }}</p>
            }
            @if (item.attribution) {
              <p class="meta">{{ 'explore.credits' | translate: { text: item.attribution } }}</p>
            }
            @if (item.derivedFrom; as source) {
              <p class="meta">
                {{
                  'explore.basedOn'
                    | translate
                      : { title: source.title, author: source.authorLabel, license: source.license }
                }}
              </p>
            }
            <div class="row-actions">
              <ng-container
                [ngTemplateOutlet]="moderate"
                [ngTemplateOutletContext]="{ $implicit: item }"
              />
              @if (restriction(); as state) {
                <button
                  matButton="tonal"
                  type="button"
                  [disabled]="busy()"
                  (click)="
                    start(
                      state.restricted ? 'unrestrict' : 'restrict',
                      item.ownerUserId,
                      item.ownerUserId
                    )
                  "
                >
                  {{ (state.restricted ? 'admin.unrestrict' : 'admin.restrict') | translate }}
                </button>
              }
            </div>

            <!-- Static on purpose: a reported snapshot is read, never executed, here. -->
            <div class="images">
              @if (item.hasThumbnail) {
                <img alt="" [src]="api.thumbnailUrl(item)" />
              }
              @for (channel of item.shader.channels; track $index) {
                @if (channel.ext !== null) {
                  <img alt="" [src]="api.textureUrl(item, $index)" />
                }
              }
            </div>
            <h3>{{ 'admin.sources' | translate }}</h3>
            @for (pass of item.shader.project.passes; track pass.id) {
              @if (pass.source) {
                <details>
                  <summary>{{ pass.name }}</summary>
                  <pre>{{ pass.source }}</pre>
                </details>
              }
            }

            <h3>{{ 'admin.reports' | translate }}</h3>
            <ng-container
              [ngTemplateOutlet]="reportList"
              [ngTemplateOutletContext]="{ $implicit: inspectedReports() }"
            />
            <h3>{{ 'admin.history' | translate }}</h3>
            <ng-container
              [ngTemplateOutlet]="auditList"
              [ngTemplateOutletContext]="{ $implicit: inspectedHistory() }"
            />
          </section>
        }

        @switch (tab()) {
          @case ('publications') {
            <form class="filters" role="search" (submit)="search($event, query.value)">
              <input
                #query
                type="search"
                [maxLength]="searchLength"
                [placeholder]="'admin.search' | translate"
                [attr.aria-label]="'admin.search' | translate"
              />
              <select
                [attr.aria-label]="'admin.publications' | translate"
                (change)="filter($event)"
              >
                <option value="all">{{ 'admin.stateAll' | translate }}</option>
                <option value="visible">{{ 'admin.stateVisible' | translate }}</option>
                <option value="hidden">{{ 'admin.stateHidden' | translate }}</option>
              </select>
            </form>
            <ul class="rows" [attr.aria-label]="'admin.publications' | translate">
              @for (item of publications(); track item.id) {
                <li>
                  <div class="row-head">
                    <strong>{{ item.title }}</strong>
                    <span class="row-actions">
                      <button
                        matButton
                        type="button"
                        [disabled]="busy()"
                        (click)="inspect(item.id)"
                      >
                        {{ 'admin.inspect' | translate }}
                      </button>
                      <ng-container
                        [ngTemplateOutlet]="moderate"
                        [ngTemplateOutletContext]="{ $implicit: item }"
                      />
                    </span>
                  </div>
                  <ng-container
                    [ngTemplateOutlet]="facts"
                    [ngTemplateOutletContext]="{ $implicit: item }"
                  />
                </li>
              } @empty {
                <li class="meta">{{ 'admin.empty' | translate }}</li>
              }
            </ul>
          }
          @case ('reports') {
            <div class="filters">
              <select [attr.aria-label]="'admin.reports' | translate" (change)="filter($event)">
                <option value="open">{{ 'admin.statusOpen' | translate }}</option>
                <option value="resolved">{{ 'admin.statusResolved' | translate }}</option>
                <option value="all">{{ 'admin.stateAll' | translate }}</option>
              </select>
            </div>
            <ng-container
              [ngTemplateOutlet]="reportList"
              [ngTemplateOutletContext]="{ $implicit: reports() }"
            />
          }
          @case ('history') {
            <ng-container
              [ngTemplateOutlet]="auditList"
              [ngTemplateOutletContext]="{ $implicit: history() }"
            />
          }
        }
        @if (nextCursor(); as cursor) {
          <button matButton="tonal" type="button" [disabled]="busy()" (click)="more(cursor)">
            {{ 'explore.loadMore' | translate }}
          </button>
        }
      }
    </main>

    <ng-template #facts let-item>
      <p class="meta">
        {{ 'explore.by' | translate: { author: item.authorLabel } }} · {{ item.license }} ·
        {{ 'admin.publicId' | translate: { id: item.id } }} ·
        {{ 'admin.owner' | translate: { id: item.ownerUserId } }}
      </p>
      <p class="badges">
        @if (item.moderatorHidden) {
          <span class="badge alert">{{ 'admin.badgeHidden' | translate }}</span>
        }
        @if (!item.ownerVisible) {
          <span class="badge">{{ 'admin.badgeUnpublished' | translate }}</span>
        }
        @if (item.publisherRestricted) {
          <span class="badge alert">{{ 'admin.badgeRestricted' | translate }}</span>
        }
        @if (item.openReports > 0) {
          <span class="badge">{{
            'admin.openReports' | translate: { count: item.openReports }
          }}</span>
        }
      </p>
    </ng-template>

    <ng-template #moderate let-item>
      <button
        matButton="tonal"
        type="button"
        [disabled]="busy()"
        (click)="start(item.moderatorHidden ? 'restore' : 'hide', item.id, item.title)"
      >
        {{ (item.moderatorHidden ? 'admin.restore' : 'admin.hide') | translate }}
      </button>
    </ng-template>

    <ng-template #reportList let-items>
      <ul class="rows" [attr.aria-label]="'admin.reports' | translate">
        @for (report of items; track report.id) {
          <li>
            <div class="row-head">
              <strong>{{ report.publicationTitle }}</strong>
              <span class="row-actions">
                <button
                  matButton
                  type="button"
                  [disabled]="busy()"
                  (click)="inspect(report.publicationId)"
                >
                  {{ 'admin.inspect' | translate }}
                </button>
                @if (report.status === 'open') {
                  <button
                    matButton="tonal"
                    type="button"
                    [disabled]="busy()"
                    (click)="start('resolve', report.id, report.publicationTitle)"
                  >
                    {{ 'admin.resolve' | translate }}
                  </button>
                }
              </span>
            </div>
            <p class="meta">
              {{ reasonLabel(report.reason) | translate }} · {{ date(report.createdAt) }} ·
              {{ 'admin.reporter' | translate: { id: report.reporterUserId } }}
            </p>
            @if (report.body) {
              <p>{{ report.body }}</p>
            }
            @if (report.resolution) {
              <p class="meta">{{ 'admin.resolution' | translate: { text: report.resolution } }}</p>
            }
          </li>
        } @empty {
          <li class="meta">{{ 'admin.empty' | translate }}</li>
        }
      </ul>
    </ng-template>

    <ng-template #auditList let-items>
      <ul class="rows" [attr.aria-label]="'admin.history' | translate">
        @for (entry of items; track entry.id) {
          <li>
            <strong>{{
              'admin.entry'
                | translate: { action: auditLabel(entry.action), actor: entry.actorUserId }
            }}</strong>
            <p class="meta">{{ date(entry.at) }} · {{ entry.targetType }} {{ entry.targetId }}</p>
            <p>{{ entry.reason }}</p>
          </li>
        } @empty {
          <li class="meta">{{ 'admin.empty' | translate }}</li>
        }
      </ul>
    </ng-template>
  `,
  styles: [
    PAGE_STYLES,
    `
      .tabs {
        display: flex;
        gap: 4px;
        margin-inline-start: auto;
      }

      .tabs .current {
        background: var(--mat-sys-secondary-container);
      }

      h2,
      h3 {
        margin: 0;
        font: var(--mat-sys-title-medium);
      }

      h3 {
        margin-top: 16px;
        font: var(--mat-sys-title-small);
      }

      .problem {
        color: var(--mat-sys-error);
        font: var(--mat-sys-body-medium);
      }

      .action,
      .inspect {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: 12px 0 20px;
        padding: 16px;
        border-radius: var(--mat-sys-corner-medium);
        background: var(--mat-sys-surface-container);
      }

      .action {
        border: 1px solid var(--mat-sys-primary);
      }

      textarea,
      .filters input,
      .filters select {
        padding: 8px;
        border: 1px solid var(--mat-sys-outline);
        border-radius: var(--mat-sys-corner-small);
        background: var(--mat-sys-surface);
        color: inherit;
        font: var(--mat-sys-body-medium);
      }

      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 12px 0;
      }

      .filters input {
        flex: 1 1 220px;
        max-width: 360px;
      }

      .rows {
        margin: 0 0 16px;
        padding: 0;
        list-style: none;
      }

      .rows li {
        padding: 10px 0;
        border-bottom: 1px solid var(--mat-sys-outline-variant);
      }

      .rows p,
      .inspect p {
        margin: 2px 0;
        overflow-wrap: anywhere;
      }

      .row-head,
      .row-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }

      .row-head {
        justify-content: space-between;
      }

      .meta,
      .hint {
        margin: 0;
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-body-small);
      }

      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .badge {
        padding: 1px 8px;
        border-radius: var(--mat-sys-corner-full);
        background: var(--mat-sys-surface-container-highest);
        font: var(--mat-sys-label-small);
      }

      .badge.alert {
        background: var(--mat-sys-error-container);
        color: var(--mat-sys-on-error-container);
      }

      .images {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .images img {
        width: 160px;
        aspect-ratio: 16 / 9;
        border-radius: var(--mat-sys-corner-small);
        object-fit: cover;
        background: #0b0b0c;
      }

      pre {
        max-height: 320px;
        margin: 6px 0;
        padding: 10px;
        overflow: auto;
        border-radius: var(--mat-sys-corner-small);
        background: var(--mat-sys-surface-container-lowest);
        font: 12px / 1.5 var(--studio-font-mono, monospace);
      }
    `,
  ],
})
export class AdminPublicationsPage {
  protected readonly api = inject(AdminApi);
  protected readonly auth = inject(AuthService);
  private readonly i18n = inject(I18n);
  private readonly access = inject(ExploreAccess).capabilities;

  protected readonly tabs: readonly { id: Tab; label: TranslationKey }[] = [
    { id: 'publications', label: 'admin.publications' },
    { id: 'reports', label: 'admin.reports' },
    { id: 'history', label: 'admin.history' },
  ];
  protected readonly actionLabels = ACTION_LABELS;
  /** What an action also does, said before it is confirmed rather than discovered after. */
  protected readonly hints: Partial<Record<ActionKind, TranslationKey>> = {
    restore: 'admin.restoreHint',
    restrict: 'admin.restrictHint',
    unrestrict: 'admin.unrestrictHint',
  };
  protected readonly reasonLength = PUBLICATION_LIMITS.reasonLength;
  protected readonly searchLength = PUBLICATION_LIMITS.searchLength;

  protected readonly admin = computed(() => this.access().admin);
  protected readonly tab = signal<Tab>('publications');
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);

  protected readonly publications = signal<readonly AdminPublicationSummary[]>([]);
  protected readonly reports = signal<readonly AdminReport[]>([]);
  protected readonly history = signal<readonly ModerationAuditEntry[]>([]);
  protected readonly nextCursor = signal<string | null>(null);

  protected readonly inspected = signal<AdminPublicationDetail | null>(null);
  protected readonly inspectedReports = signal<readonly AdminReport[]>([]);
  protected readonly inspectedHistory = signal<readonly ModerationAuditEntry[]>([]);
  protected readonly restriction = signal<PublisherRestriction | null>(null);

  protected readonly pending = signal<PendingAction | null>(null);
  protected readonly reason = signal('');

  private searchTerm = '';
  private stateFilter: PublicationStateFilter = 'all';
  private statusFilter: ReportStatusFilter = 'open';

  /** Bumped whenever the records are dropped, so an answer for the previous session lands nowhere. */
  private epoch = 0;
  private inFlight = 0;

  constructor() {
    // The only thing that loads anything: the server saying this account
    // moderates. Tracking the user too means a second moderator signing in on
    // the same tab starts from an empty page, not from the first one's.
    effect(() => {
      const admin = this.admin();
      this.auth.user();
      untracked(() => {
        this.clear();
        if (admin) void this.attempt(() => this.load(null));
      });
    });
  }

  // --- navigation within the page -------------------------------------------

  protected show(tab: Tab): void {
    // The filter controls are rebuilt with the tab, at their defaults.
    this.searchTerm = '';
    this.stateFilter = 'all';
    this.statusFilter = 'open';
    this.tab.set(tab);
    void this.attempt(() => this.load(null));
  }

  protected search(event: Event, term: string): void {
    event.preventDefault();
    this.searchTerm = term.trim();
    void this.attempt(() => this.load(null));
  }

  protected filter(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (this.tab() === 'publications') this.stateFilter = value as PublicationStateFilter;
    else this.statusFilter = value as ReportStatusFilter;
    void this.attempt(() => this.load(null));
  }

  protected more(cursor: string): void {
    void this.attempt(() => this.load(cursor));
  }

  protected refresh(): void {
    void this.attempt(() => this.reload());
  }

  protected inspect(id: string): void {
    void this.attempt(() => this.loadInspected(id));
  }

  // --- moderation -----------------------------------------------------------

  protected start(kind: ActionKind, targetId: string, subject: string): void {
    this.problem.set(null);
    // A reason typed for one action is not a reason for another.
    if (this.pending()?.kind !== kind || this.pending()?.targetId !== targetId) this.reason.set('');
    this.pending.set({ kind, targetId, subject });
  }

  protected cancel(): void {
    this.pending.set(null);
    this.reason.set('');
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    const action = this.pending();
    const reason = this.reason().trim();
    if (!action || !reason || this.busy()) return;

    const outcome = await this.attempt(() => this.apply(action, reason));
    if (outcome === 'ok') this.cancel();
    // Done, or refused as stale: either way the server's state is read again.
    // After a refusal the action and its reason stay, to be confirmed against
    // what is now on screen.
    if (outcome !== 'failed') await this.attempt(() => this.reload(), true);
  }

  private async apply(action: PendingAction, reason: string): Promise<void> {
    const id = action.targetId;
    switch (action.kind) {
      case 'hide':
      case 'restore': {
        const current =
          this.inspected()?.id === id
            ? this.inspected()
            : this.publications().find((item) => item.id === id);
        await this.api.moderate(id, {
          hidden: action.kind === 'hide',
          reason,
          expectedModerationRevision: current?.moderationRevision ?? 1,
        });
        return;
      }
      case 'resolve': {
        const report = [...this.reports(), ...this.inspectedReports()].find(
          (entry) => entry.id === id,
        );
        await this.api.resolve(id, { reason, expectedRevision: report?.revision ?? 1 });
        return;
      }
      case 'restrict':
      case 'unrestrict':
        await this.api.restrict(id, {
          restricted: action.kind === 'restrict',
          reason,
          expectedRevision: this.restriction()?.revision ?? 0,
        });
    }
  }

  // --- loading --------------------------------------------------------------

  private async reload(): Promise<void> {
    const open = this.inspected()?.id;
    await Promise.all([this.load(null), open ? this.loadInspected(open) : undefined]);
  }

  /** The page after `cursor` of the current tab, or its first page. */
  private async load(cursor: string | null): Promise<void> {
    const epoch = this.epoch;
    const tab = this.tab();
    const keep = <T>(current: readonly T[], page: readonly T[]) =>
      cursor ? [...current, ...page] : [...page];

    if (tab === 'publications') {
      const page = await this.api.publications({
        state: this.stateFilter,
        search: this.searchTerm,
        cursor,
      });
      if (epoch !== this.epoch) return;
      this.publications.update((current) => keep(current, page.publications));
      this.nextCursor.set(page.nextCursor);
    } else if (tab === 'reports') {
      const page = await this.api.reports({ status: this.statusFilter, cursor });
      if (epoch !== this.epoch) return;
      this.reports.update((current) => keep(current, page.reports));
      this.nextCursor.set(page.nextCursor);
    } else {
      const page = await this.api.audit({ cursor });
      if (epoch !== this.epoch) return;
      this.history.update((current) => keep(current, page.entries));
      this.nextCursor.set(page.nextCursor);
    }
  }

  private async loadInspected(id: string): Promise<void> {
    const epoch = this.epoch;
    const [publication, reports, history] = await Promise.all([
      this.api.publication(id),
      this.api.reports({ status: 'all', publicationId: id, cursor: null }),
      this.api.audit({ targetId: id, cursor: null }),
    ]);
    const restriction = await this.api.restriction(publication.ownerUserId);
    if (epoch !== this.epoch) return;
    this.inspected.set(publication);
    this.inspectedReports.set(reports.reports);
    this.inspectedHistory.set(history.entries);
    this.restriction.set(restriction);
  }

  private clear(): void {
    this.epoch += 1;
    this.publications.set([]);
    this.reports.set([]);
    this.history.set([]);
    this.nextCursor.set(null);
    this.inspected.set(null);
    this.inspectedReports.set([]);
    this.inspectedHistory.set([]);
    this.restriction.set(null);
    this.problem.set(null);
    this.cancel();
  }

  /**
   * Runs one request, or one batch of them, and turns its failure into a
   * message. `busy` is true while any is outstanding, which is what disables
   * every button — a second click cannot send the same write twice.
   */
  private async attempt(
    work: () => Promise<void>,
    keepProblem = false,
  ): Promise<'ok' | 'conflict' | 'failed'> {
    const epoch = this.epoch;
    if (!keepProblem) this.problem.set(null);
    this.inFlight += 1;
    this.busy.set(true);
    try {
      await work();
      return 'ok';
    } catch (error) {
      if (epoch !== this.epoch) return 'failed';
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 409) {
        this.problem.set(this.i18n.t('admin.conflict'));
        return 'conflict';
      }
      if (status === 401 || status === 403) {
        // The session ended or lost the role: nothing privileged stays on screen.
        this.clear();
        this.problem.set(this.i18n.t('admin.forbidden'));
      } else if (status === 404 && this.inspected()) {
        // The source shader or the account was deleted while it was open here.
        this.inspected.set(null);
        this.problem.set(this.i18n.t('admin.error'));
      } else {
        const detail = error instanceof ApiError ? error.summary : String(error);
        this.problem.set(`${this.i18n.t('admin.error')} ${detail}`);
      }
      return 'failed';
    } finally {
      this.inFlight -= 1;
      this.busy.set(this.inFlight > 0);
    }
  }

  // --- presentation ---------------------------------------------------------

  protected value(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected date(iso: string): string {
    return new Date(iso).toLocaleString(this.i18n.locale());
  }

  protected reasonLabel(reason: AdminReport['reason']): TranslationKey {
    return `explore.reason.${reason}`;
  }

  protected auditLabel(action: ModerationAction): string {
    return this.i18n.t(AUDIT_LABELS[action]);
  }
}
