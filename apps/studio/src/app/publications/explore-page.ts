import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';

import {
  PUBLICATION_LIMITS,
  type PublicationPage,
  type PublicationSummary,
} from '@shadergrove/shared/publication';
import { ApiError } from '../api/shader-api';
import { TranslatePipe } from '../i18n/translate.pipe';
import { PAGE_STYLES, serverState } from './page';
import { PublicationApi } from './publication-api';

type State = 'loading' | 'ready' | 'error' | 'unavailable';

/**
 * `/explore`: every public shader, newest first, for anyone — no session, no
 * sign-in prompt. The cards are static thumbnails; nothing is compiled or
 * rendered until a visitor opens one and asks for its preview.
 */
@Component({
  selector: 'app-explore-page',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, RouterLink, TranslatePipe],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/">
        <mat-icon>arrow_back</mat-icon>
        {{ 'explore.backToEditor' | translate }}
      </a>
      <h1>{{ 'explore.title' | translate }}</h1>
      <form class="search" role="search" (submit)="search($event, input.value)">
        <mat-icon aria-hidden="true">search</mat-icon>
        <input
          #input
          type="search"
          autocomplete="off"
          [maxLength]="searchLength"
          [placeholder]="'explore.search' | translate"
          [attr.aria-label]="'explore.search' | translate"
          [value]="query()"
        />
      </form>
    </header>

    <main [attr.aria-busy]="state() === 'loading'">
      @switch (state()) {
        @case ('unavailable') {
          <p class="status">{{ 'explore.unavailable' | translate }}</p>
        }
        @case ('error') {
          <p class="status" role="alert">
            {{ 'explore.loadError' | translate }}
            <button matButton="tonal" type="button" (click)="load(null)">
              {{ 'explore.retry' | translate }}
            </button>
          </p>
        }
        @default {
          @if (state() === 'ready' && publications().length === 0) {
            <p class="status">{{ (query() ? 'explore.noMatch' : 'explore.empty') | translate }}</p>
          }
          <ul class="cards" [attr.aria-label]="'explore.title' | translate">
            @for (item of publications(); track item.id) {
              <li>
                <a class="card" [routerLink]="['/explore', item.id]">
                  @if (item.hasThumbnail) {
                    <img class="thumb" loading="lazy" alt="" [src]="api.thumbnailUrl(item)" />
                  } @else {
                    <span class="thumb thumb-empty" aria-hidden="true">
                      <mat-icon>blur_on</mat-icon>
                    </span>
                  }
                  <span class="card-title">{{ item.title }}</span>
                  <span class="card-meta">
                    {{ 'explore.by' | translate: { author: item.authorLabel } }} ·
                    {{ item.license }}
                  </span>
                </a>
              </li>
            }
          </ul>
          @if (state() === 'loading') {
            <mat-progress-bar
              mode="indeterminate"
              [attr.aria-label]="'explore.loading' | translate"
            />
          } @else if (nextCursor(); as cursor) {
            <button matButton="tonal" type="button" class="more" (click)="load(cursor)">
              {{ 'explore.loadMore' | translate }}
            </button>
          }
        }
      }
    </main>
  `,
  styles: [
    PAGE_STYLES,
    `
      .search {
        display: flex;
        flex: 1 1 220px;
        align-items: center;
        gap: 6px;
        max-width: 420px;
        height: 36px;
        margin-inline-start: auto;
        padding: 0 10px;
        border-radius: var(--mat-sys-corner-full);
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      }

      .search:focus-within {
        box-shadow: inset 0 0 0 1px var(--mat-sys-primary);
      }

      .search input {
        flex: 1;
        min-width: 0;
        border: 0;
        outline: none;
        background: transparent;
        color: inherit;
        font: var(--mat-sys-body-medium);
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 16px;
        margin: 0 0 20px;
        padding: 0;
        list-style: none;
      }

      .card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        border-radius: var(--mat-sys-corner-medium);
        color: inherit;
        text-decoration: none;
      }

      .card:hover {
        background: color-mix(in srgb, var(--mat-sys-on-surface) 7%, transparent);
      }

      .card:focus-visible {
        outline: 2px solid var(--mat-sys-primary);
      }

      .thumb {
        width: 100%;
        aspect-ratio: 16 / 9;
        margin-bottom: 4px;
        border-radius: var(--mat-sys-corner-small);
        object-fit: cover;
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
      }

      .thumb-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--mat-sys-on-surface-variant);
      }

      .card-title {
        overflow: hidden;
        font: var(--mat-sys-title-small);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .card-meta {
        color: var(--mat-sys-on-surface-variant);
        font: var(--mat-sys-body-small);
      }
    `,
  ],
})
export class ExplorePage {
  protected readonly api = inject(PublicationApi);
  private readonly firstPage = serverState<PublicationPage>('explore');

  protected readonly searchLength = PUBLICATION_LIMITS.searchLength;
  protected readonly state = signal<State>('loading');
  protected readonly query = signal('');
  protected readonly publications = signal<readonly PublicationSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);

  /** The latest request wins: a slow page for an old search must not land on a new one. */
  private generation = 0;

  constructor() {
    const rendered = this.firstPage.take();
    if (rendered) this.show(rendered, []);
    else void this.load(null).then(() => this.publishFirstPage());
  }

  protected search(event: Event, value: string): void {
    event.preventDefault();
    this.query.set(value.trim());
    void this.load(null);
  }

  /** Loads the page after `cursor`, or starts over from the top when there is none. */
  protected async load(cursor: string | null): Promise<void> {
    const generation = ++this.generation;
    const shown = cursor ? this.publications() : [];
    this.publications.set(shown);
    this.state.set('loading');
    try {
      const page = await this.api.list(this.query(), cursor);
      if (generation === this.generation) this.show(page, shown);
    } catch (error) {
      if (generation !== this.generation) return;
      // The routes do not exist on a server with Explore turned off.
      const off = error instanceof ApiError && error.status === 404;
      this.state.set(off ? 'unavailable' : 'error');
    }
  }

  private show(page: PublicationPage, before: readonly PublicationSummary[]): void {
    this.publications.set([...before, ...page.publications]);
    this.nextCursor.set(page.nextCursor);
    this.state.set('ready');
  }

  private publishFirstPage(): void {
    if (this.state() !== 'ready') return;
    this.firstPage.put({ publications: [...this.publications()], nextCursor: this.nextCursor() });
  }
}
