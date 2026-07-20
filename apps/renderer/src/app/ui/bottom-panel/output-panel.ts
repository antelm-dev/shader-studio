import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  PLATFORM_ID,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import {
  OutputLog,
  type OutputLogEntry,
  type OutputLogLevel,
  type OutputLogSource,
} from './output-log';

const SOURCE_KEYS: Record<OutputLogSource, TranslationKey> = {
  compiler: 'output.source.compiler',
  renderer: 'output.source.renderer',
  workspace: 'output.source.workspace',
  mcp: 'output.source.mcp',
};

const LEVEL_KEYS: Record<OutputLogLevel, TranslationKey> = {
  info: 'output.level.info',
  warning: 'output.level.warning',
  error: 'output.level.error',
};

/** How close to the bottom the user has to be for a new entry to auto-scroll. */
const AUTOSCROLL_THRESHOLD = 24;

/**
 * Structured application output — shader compiler and renderer messages
 * today, `OutputLog`'s other sources as they arrive.
 *
 * Auto-scrolls to a new entry only while the user is already at (or near) the
 * bottom. Scrolling up to read an earlier message opts out of it until they
 * scroll back down themselves — the same behaviour every log viewer and
 * terminal uses, and the only one that does not fight you for the wheel.
 */
@Component({
  selector: 'app-output-panel',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
  template: `
    <div class="toolbar">
      <span class="count" aria-live="polite">{{ entries().length }}</span>
      <span class="spacer"></span>
      <button
        matIconButton
        type="button"
        [matTooltip]="'panel.clearOutput' | translate"
        [attr.aria-label]="'panel.clearOutput' | translate"
        [disabled]="entries().length === 0"
        (click)="clear()"
      >
        <mat-icon>delete_sweep</mat-icon>
      </button>
    </div>

    <div class="log" #scrollHost (scroll)="onScroll()">
      @if (entries().length === 0) {
        <p class="empty">{{ 'panel.noOutput' | translate }}</p>
      } @else {
        @for (entry of entries(); track entry.id) {
          <div class="entry" [class]="entry.level">
            <span class="time">{{ formatTime(entry.timestamp) }}</span>
            <span class="source">{{ sourceLabel(entry.source) }}</span>
            <mat-icon class="level-icon" [attr.aria-label]="levelLabel(entry.level)">
              {{ levelIcon(entry.level) }}
            </mat-icon>
            <span class="message">{{ entry.message }}</span>
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
    }

    .toolbar {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 8px;
      padding: 2px 6px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .count {
      padding-inline: 6px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .spacer {
      flex: 1;
    }

    .log {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      margin: 0;
      padding: 16px;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }

    .entry {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 3px 10px;
      font: var(--mat-sys-body-small);
      font-family: 'JetBrains Mono', Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-outline-variant) 40%, transparent);
    }

    .time {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
    }

    .source {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
      text-transform: uppercase;
      font-size: 0.85em;
      letter-spacing: 0.04em;
    }

    .level-icon {
      align-self: center;
      flex: 0 0 auto;
      font-size: 15px;
      width: 15px;
      height: 15px;
      color: var(--mat-sys-on-surface-variant);
    }

    .entry.warning .level-icon {
      color: var(--mat-sys-tertiary);
    }

    .entry.error .level-icon {
      color: var(--mat-sys-error);
    }

    .entry.warning .message {
      color: var(--mat-sys-tertiary);
    }

    .entry.error .message {
      color: var(--mat-sys-error);
    }

    .message {
      color: var(--mat-sys-on-surface);
    }
  `,
})
export class OutputPanel {
  private readonly log = inject(OutputLog);
  private readonly i18n = inject(I18n);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly scrollHost = viewChild<ElementRef<HTMLDivElement>>('scrollHost');

  protected readonly entries = this.log.entries;

  /** Whether the viewport was at (or near) the bottom before the latest entry arrived. */
  private readonly stickToBottom = signal(true);

  constructor() {
    effect(() => {
      const count = this.entries().length;
      untracked(() => {
        void count;
        if (!this.isBrowser || !this.stickToBottom()) return;
        queueMicrotask(() => this.scrollToBottom());
      });
    });
  }

  protected clear(): void {
    this.log.clear();
    this.stickToBottom.set(true);
  }

  protected onScroll(): void {
    const el = this.scrollHost()?.nativeElement;
    if (!el) return;
    this.stickToBottom.set(
      el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_THRESHOLD,
    );
  }

  private scrollToBottom(): void {
    const el = this.scrollHost()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  protected formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  protected sourceLabel(source: OutputLogEntry['source']): string {
    return this.i18n.t(SOURCE_KEYS[source]);
  }

  protected levelLabel(level: OutputLogEntry['level']): string {
    return this.i18n.t(LEVEL_KEYS[level]);
  }

  protected levelIcon(level: OutputLogEntry['level']): string {
    switch (level) {
      case 'error':
        return 'error';
      case 'warning':
        return 'warning';
      default:
        return 'info';
    }
  }
}
