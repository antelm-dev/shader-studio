import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { CodeEditor } from '../editor/code-editor';
import { Preferences } from '../core/preferences';
import type { CompileDiagnostic, DiagnosticSource } from '../core/diagnostic';
import { ShaderStore } from '../core/shader-store';

/** One tab per buffer, which is also the set of things a diagnostic can point at. */
type Tab = DiagnosticSource;

/**
 * The source editor: fragment GLSL, vertex GLSL, and the control schema.
 *
 * Edits flow straight into the draft, and the preview recompiles behind a short
 * debounce — there is no "run" button, because the whole point is that the
 * background *is* the shader you are editing. A shader that fails to compile
 * leaves the last good one on screen and reports why in the diagnostics strip.
 */
@Component({
  selector: 'app-editor-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeEditor, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="editor-toolbar">
      <nav class="tabs" role="tablist" aria-label="Shader source">
        @for (option of tabs; track option.id) {
          <button
            matButton
            type="button"
            role="tab"
            class="tab"
            [class.active]="tab() === option.id"
            [attr.aria-selected]="tab() === option.id"
            (click)="tab.set(option.id)"
          >
            {{ option.label }}
            @if (errorCount(option.id); as count) {
              <span class="tab-errors" [attr.aria-label]="count + ' errors'">{{ count }}</span>
            }
          </button>
        }
      </nav>

      <div class="spacer"></div>

      @if (store.dirty()) {
        <span class="dirty" aria-live="polite">Unsaved changes</span>
      }

      <button
        matButton
        type="button"
        matTooltip="Discard your edits and reload the saved shader"
        [disabled]="!store.dirty() || store.saving()"
        (click)="store.revert()"
      >
        <mat-icon>undo</mat-icon>
        Revert
      </button>

      <button
        matButton="filled"
        type="button"
        [disabled]="!store.dirty() || store.saving() || !store.configValid()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        {{ store.saving() ? 'Saving…' : 'Save' }}
      </button>
    </div>

    <div class="editor-body">
      @if (store.draft(); as draft) {
        <!-- Each tab keeps its own editor so switching does not reset the cursor. -->
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'fragment'"
          language="glsl"
          [value]="draft.fragment"
          [colorScheme]="preferences.value().colorScheme"
          [diagnostics]="diagnosticsFor('fragment')"
          (valueChange)="store.setFragment($event)"
        />
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'vertex'"
          language="glsl"
          [value]="draft.vertex"
          [colorScheme]="preferences.value().colorScheme"
          [diagnostics]="diagnosticsFor('vertex')"
          (valueChange)="store.setVertex($event)"
        />
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'config'"
          language="json"
          [value]="draft.controlsText"
          [colorScheme]="preferences.value().colorScheme"
          [diagnostics]="diagnosticsFor('config')"
          (valueChange)="store.setControlsText($event)"
        />
      } @else {
        <p class="empty">Select a shader to edit it.</p>
      }
    </div>

    @if (visibleDiagnostics().length > 0) {
      <ul class="diagnostics" aria-label="Diagnostics" aria-live="polite">
        @for (diagnostic of visibleDiagnostics(); track $index) {
          <li class="diagnostic" [class.warning]="diagnostic.severity === 'warning'">
            <mat-icon class="diagnostic-icon">
              {{ diagnostic.severity === 'warning' ? 'warning' : 'error' }}
            </mat-icon>
            <span class="diagnostic-where">
              {{ diagnostic.source }}@if (diagnostic.line) {<span>:{{ diagnostic.line }}</span>}
            </span>
            <span class="diagnostic-message">{{ diagnostic.message }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      background: var(--mat-sys-surface-container-lowest);
    }

    .editor-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .tabs {
      display: flex;
      gap: 2px;
    }

    .tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .tab-errors {
      display: inline-grid;
      place-items: center;
      min-width: 18px;
      height: 18px;
      margin-left: 6px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-small);
    }

    .spacer {
      flex: 1;
    }

    .dirty {
      color: var(--mat-sys-tertiary);
      font: var(--mat-sys-label-medium);
    }

    .editor-body {
      position: relative;
      flex: 1;
      min-height: 0;
    }

    .editor {
      position: absolute;
      inset: 0;
    }

    /* Hidden rather than removed: destroying the editor would lose undo history. */
    .editor.hidden {
      visibility: hidden;
      pointer-events: none;
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }

    .diagnostics {
      flex: 0 0 auto;
      max-height: 132px;
      overflow-y: auto;
      margin: 0;
      padding: 4px 0;
      list-style: none;
      border-top: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container);
    }

    .diagnostic {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 3px 12px;
      font: var(--mat-sys-body-small);
      font-family: 'JetBrains Mono', Consolas, monospace;
    }

    .diagnostic-icon {
      align-self: center;
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--mat-sys-error);
    }

    .diagnostic.warning .diagnostic-icon {
      color: var(--mat-sys-tertiary);
    }

    .diagnostic-where {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
    }

    .diagnostic-message {
      color: var(--mat-sys-on-surface);
      overflow-wrap: anywhere;
    }
  `,
})
export class EditorPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);

  protected readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'fragment', label: 'Fragment' },
    { id: 'vertex', label: 'Vertex' },
    { id: 'config', label: 'Config' },
  ];

  protected readonly tab = signal<Tab>('fragment');

  protected readonly visibleDiagnostics = computed(() =>
    this.store.diagnostics().filter((diagnostic) => diagnostic.source === this.tab()),
  );

  protected diagnosticsFor(source: Tab): CompileDiagnostic[] {
    return this.store.diagnostics().filter((diagnostic) => diagnostic.source === source);
  }

  protected errorCount(source: Tab): number {
    return this.store
      .diagnostics()
      .filter((diagnostic) => diagnostic.source === source && diagnostic.severity === 'error')
      .length;
  }
}
