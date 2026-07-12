import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { CodeEditor } from '../editor/code-editor';
import { EditorSettings } from '../editor/editor-settings';
import { Preferences } from '../core/preferences';
import type { CompileDiagnostic, DiagnosticSource } from '../core/diagnostic';
import { ShaderStore } from '../core/shader-store';
import { EditorWindowControls } from './editor-window-controls';

/** One tab per buffer, which is also the set of things a diagnostic can point at. */
type Tab = DiagnosticSource;

/**
 * The source editor: fragment GLSL, vertex GLSL, and the control schema.
 *
 * Edits flow straight into the draft, and the preview recompiles behind a short
 * debounce — there is no "run" button, because the whole point is that the
 * background *is* the shader you are editing. A shader that fails to compile
 * leaves the last good one on screen and reports why in the diagnostics strip.
 *
 * The panel knows nothing about where it is. It is docked, floating, maximized
 * or collapsed entirely at `EditorShell`'s discretion; all it is told is whether
 * to collapse its body and whether its toolbar should behave as a drag handle.
 * That ignorance is what lets the shell move it between modes without ever
 * recreating it — and an editor that is never recreated is an editor that never
 * loses your undo history.
 */
@Component({
  selector: 'app-editor-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CodeEditor,
    EditorWindowControls,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  template: `
    <!-- The toolbar doubles as the floating window's title bar. dragStart only
         fires for presses on the bar itself, never on a control inside it. -->
    <div
      class="editor-toolbar"
      [class.draggable]="dragEnabled()"
      (pointerdown)="onToolbarPointerDown($event)"
    >
      <nav class="tabs" role="tablist" aria-label="Shader source">
        @for (option of tabs; track option.id) {
          <button
            matButton
            type="button"
            role="tab"
            class="tab"
            [class.active]="tab() === option.id"
            [attr.aria-selected]="tab() === option.id"
            (click)="selectTab(option.id)"
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
        class="action"
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
        class="action"
        matTooltip="Save the source and config (Ctrl+S)"
        [disabled]="!store.dirty() || store.saving() || !store.configValid()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        {{ store.saving() ? 'Saving…' : 'Save' }}
      </button>

      <app-editor-window-controls />
    </div>

    <!-- Hidden, never removed. Collapsing the editor must not cost you the
         undo stack you spent the last twenty minutes building. -->
    <div class="editor-body" [class.collapsed]="collapsed()" [attr.inert]="collapsed() || null">
      @if (store.draft(); as draft) {
        <!-- Each tab keeps its own editor so switching does not reset the cursor. -->
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'fragment'"
          language="glsl"
          [value]="draft.fragment"
          [colorScheme]="preferences.value().colorScheme"
          [appearance]="settings.effective()"
          [diagnostics]="diagnosticsFor('fragment')"
          (valueChange)="store.setFragment($event)"
        />
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'vertex'"
          language="glsl"
          [value]="draft.vertex"
          [colorScheme]="preferences.value().colorScheme"
          [appearance]="settings.effective()"
          [diagnostics]="diagnosticsFor('vertex')"
          (valueChange)="store.setVertex($event)"
        />
        <app-code-editor
          class="editor"
          [class.hidden]="tab() !== 'config'"
          language="json"
          [value]="draft.controlsText"
          [colorScheme]="preferences.value().colorScheme"
          [appearance]="settings.effective()"
          [diagnostics]="diagnosticsFor('config')"
          (valueChange)="store.setControlsText($event)"
        />
      } @else {
        <p class="empty">Select a shader to edit it.</p>
      }
    </div>

    @if (visibleDiagnostics().length > 0 && !collapsed()) {
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
      /* The bar is a drag surface when floating; its own text should not select
         out from under the gesture. The code below it is untouched. */
      user-select: none;
    }

    .editor-toolbar.draggable {
      cursor: move;
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
      white-space: nowrap;
    }

    .editor-body {
      position: relative;
      flex: 1;
      min-height: 0;
    }

    /* Collapsed, not destroyed: zero height, no hit area, still alive. */
    .editor-body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
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

    /* Narrow panels lose the wordy buttons before they lose the window controls:
       Save is also on the app toolbar and bound to Ctrl+S, but there is nowhere
       else to un-maximize from. */
    @container (max-width: 560px) {
      .action {
        display: none;
      }
    }
  `,
  host: {
    style: 'container-type: inline-size',
  },
})
export class EditorPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly settings = inject(EditorSettings);

  /** Collapse to just the toolbar, keeping every editor alive underneath. */
  readonly collapsed = input(false);

  /** Whether a press on the toolbar should begin a window drag. */
  readonly dragEnabled = input(false);

  readonly dragStart = output<PointerEvent>();

  private readonly editors = viewChildren(CodeEditor);

  protected readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'fragment', label: 'Fragment' },
    { id: 'vertex', label: 'Vertex' },
    { id: 'config', label: 'Config' },
  ];

  protected readonly tab = signal<Tab>('fragment');

  protected readonly visibleDiagnostics = computed(() =>
    this.store.diagnostics().filter((diagnostic) => diagnostic.source === this.tab()),
  );

  /**
   * Re-measure every tab, including the hidden ones.
   *
   * Monaco lays itself out from the size of its container, and a container that
   * was `visibility: hidden` or zero-height while the window was resized has been
   * measuring nothing. Without this, restoring a collapsed editor or switching to
   * a tab that was hidden during a drag shows a correctly-sized box with the text
   * still laid out for the *old* one.
   */
  relayout(): void {
    for (const editor of this.editors()) editor.layout();
  }

  /** Focus the tab the user is actually looking at. */
  focusEditor(): void {
    const index = this.tabs.findIndex((option) => option.id === this.tab());
    this.editors()[index]?.focus();
  }

  protected selectTab(tab: Tab): void {
    this.tab.set(tab);
    // The editor we are about to reveal has been sitting at `visibility: hidden`
    // and may have missed a resize while it was there.
    queueMicrotask(() => this.relayout());
  }

  /**
   * Begin a drag — but only from the bar itself.
   *
   * A press that started on a button, a tab or the dirty badge is that control's
   * business, and hijacking it would make every click a one-pixel window move.
   */
  protected onToolbarPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="tab"]')) return;

    this.dragStart.emit(event);
  }

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
