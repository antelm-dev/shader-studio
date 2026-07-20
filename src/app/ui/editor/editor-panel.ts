import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { findPass } from '@shader-studio/shared/project';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import {
  EditorNavigation,
  resolveNavigationTarget,
  type EditorLocationRequest,
} from '../../editor/editor-navigation';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { DocumentStatus } from './document-status';
import { EditorTabs } from './editor-tabs';
import { EditorWindowControls } from './editor-window-controls';
import { PassConfigPanel } from '../inspector/pass-config-panel';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';

@Component({
  selector: 'app-editor-panel',
  imports: [
    CodeEditor,
    EditorTabs,
    EditorWindowControls,
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    PassConfigPanel,
    TranslatePipe,
  ],
  template: `
    <div
      class="editor-toolbar"
      [class.draggable]="dragEnabled()"
      [matContextMenuTriggerFor]="editorMenu"
      (pointerdown)="onToolbarPointerDown($event)"
    >
      <app-editor-tabs
        class="tabs"
        [activeId]="store.activeDoc()?.id ?? null"
        (select)="selectDoc($event)"
        (rename)="workspace.renameDocument($event)"
        (remove)="workspace.deleteDocument($event)"
        (newFile)="workspace.createFile()"
      />

      <div class="spacer"></div>

      @if (status.state() === 'unsaved' || status.state() === 'saving') {
        <span class="dirty" aria-live="polite">{{ status.label() }}</span>
      }

      @if (activePass()) {
        <button
          type="button"
          class="config-toggle"
          [matButton]="configOpen() ? 'tonal' : 'text'"
          [attr.aria-pressed]="configOpen()"
          [matTooltip]="'editor.passSettings' | translate"
          (click)="configOpen.set(!configOpen())"
        >
          <mat-icon>tune</mat-icon>
        </button>
      }

      <app-editor-window-controls />
    </div>

    <mat-menu #editorMenu="matMenu">
      <button
        mat-menu-item
        type="button"
        [disabled]="!status.canSave()"
        [matTooltip]="status.saveHint()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        <span>{{ (store.saving() ? 'action.saving' : 'action.saveShader') | translate }}</span>
        <span class="menu-hint">Ctrl+S</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.dirty() || store.saving()"
        (click)="store.revert()"
      >
        <mat-icon>undo</mat-icon>
        <span>{{ 'action.revert' | translate }}</span>
      </button>
      <mat-divider />
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.canAddBuffer()"
        (click)="store.addBufferPass()"
      >
        <mat-icon>layers</mat-icon>
        <span>{{ 'editor.newBuffer' | translate }}</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft()"
        (click)="workspace.createFile()"
      >
        <mat-icon>description</mat-icon>
        <span>{{ 'editor.newFile' | translate }}</span>
        <span class="menu-hint">Ctrl+N</span>
      </button>
      <mat-divider />
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft() || activeDoc()?.language !== 'glsl'"
        (click)="formatSource()"
      >
        <mat-icon>format_align_left</mat-icon>
        <span>{{ 'editor.formatGlsl' | translate }}</span>
        <span class="menu-hint">Shift+Alt+F</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.draft()"
        [matTooltip]="'editor.copyFullGlsl' | translate"
        (click)="workspace.copyFullGlsl()"
      >
        <mat-icon>content_copy</mat-icon>
        <span>{{ 'editor.copyGlsl' | translate }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>tune</mat-icon>
        <span>{{ 'action.appearance' | translate }}</span>
      </button>
    </mat-menu>

    <div class="editor-body" [class.collapsed]="collapsed()" [attr.inert]="collapsed() || null">
      @if (editorDoc(); as doc) {
        <app-code-editor
          class="editor"
          [doc]="doc"
          [liveIds]="liveIds()"
          [colorScheme]="preferences.resolved()"
          [appearance]="settings.effective()"
          [diagnostics]="activeDiagnostics()"
          (valueChange)="store.setDocSource($event.id, $event.value)"
        />

        @if (activePass(); as pass) {
          @if (configOpen()) {
            <app-pass-config-panel class="config" [pass]="pass" />
          }
        }
      } @else {
        <p class="empty">{{ 'editor.empty' | translate }}</p>
      }
    </div>
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
      gap: 6px;
      min-height: 34px;
      padding: 2px 5px 2px 7px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      user-select: none;
      cursor: context-menu;
    }

    .editor-toolbar.draggable {
      cursor: move;
    }

    .tabs {
      min-width: 0;
      flex: 1 1 auto;
    }

    .spacer {
      flex: 0 0 auto;
    }

    .dirty {
      color: var(--mat-sys-tertiary);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
    }

    .config-toggle {
      min-width: 0;
      height: 28px;
      padding-inline: 8px;
    }

    .editor-body {
      position: relative;
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .editor-body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
    }

    .editor {
      flex: 1;
      min-width: 0;
    }

    .config {
      flex: 0 0 268px;
      max-width: 50%;
    }

    /*
     * On a narrow panel the settings sit *under* the editor rather than beside
     * it: 268px of controls next to 200px of code is not an editor with a
     * sidebar, it is two things that have both stopped working.
     */
    @container (max-width: 640px) {
      .editor-body {
        flex-direction: column;
      }

      .config {
        flex: 0 0 auto;
        max-width: none;
        max-height: 45%;
        border-left: 0;
        border-top: 1px solid var(--mat-sys-outline-variant);
      }
    }

    .empty {
      display: grid;
      place-items: center;
      height: 100%;
      width: 100%;
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
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
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly status = inject(DocumentStatus);

  readonly collapsed = input(false);
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  private readonly editor = viewChild(CodeEditor);

  protected readonly configOpen = signal(false);

  protected readonly activeDoc = computed(() => this.store.activeDoc());

  /** The open document, in the shape the editor wants. */
  protected readonly editorDoc = computed<EditorDoc | null>(() => {
    const doc = this.activeDoc();
    return doc ? { id: doc.id, language: doc.language, value: doc.source } : null;
  });

  /** Every document that still exists — the editor drops the models of the rest. */
  protected readonly liveIds = computed(() => this.store.documents().map((doc) => doc.id));

  /** The open document, when it is a pass: what the settings panel configures. */
  protected readonly activePass = computed(() => {
    const doc = this.activeDoc();
    const project = this.store.project();
    if (!doc || !project || doc.kind !== 'pass') return null;

    const pass = findPass(project, doc.id);
    // Common is not rendered, so it has no channels, no target and nothing to
    // configure. Showing it an empty settings panel would only raise the question.
    return pass && pass.kind !== 'common' ? pass : null;
  });

  protected readonly activeDiagnostics = computed(() =>
    this.store.diagnosticsFor(this.activeDoc()?.id ?? ''),
  );

  private readonly editorNavigation = inject(EditorNavigation);

  constructor() {
    // The Problems panel does not hold a reference to `CodeEditor` — it asks
    // through `EditorNavigation` instead, and this is the one place that picks
    // the request up and acts on it, the same way `reveal` below used to for a
    // click on the (now removed) inline diagnostics list.
    effect(() => {
      const request = this.editorNavigation.request();
      if (!request) return;
      untracked(() => this.handleNavigation(request));
    });
  }

  relayout(): void {
    this.editor()?.layout();
  }

  focusEditor(): void {
    this.editor()?.focus();
  }

  protected selectDoc(id: string): void {
    this.store.selectDoc(id);
    queueMicrotask(() => this.relayout());
  }

  /**
   * Select the document a navigation request names and put the cursor on its
   * line.
   *
   * The reveal is *handed to* the editor rather than performed by the caller,
   * because the document it names is usually not mounted yet — mounting happens
   * in an effect, and effects have not run. `CodeEditor.revealIn` holds the
   * request until the model is in.
   */
  private handleNavigation(request: EditorLocationRequest): void {
    const resolved = resolveNavigationTarget(
      request,
      this.store.documents().map((doc) => doc.id),
      this.activeDoc()?.id ?? null,
    );
    if (!resolved) return;

    this.store.selectDoc(resolved.docId);

    if (resolved.reveal) this.editor()?.revealIn(resolved.docId, resolved.line);
    else this.focusEditor();

    queueMicrotask(() => this.relayout());
  }

  /** Format the source in the open tab. The config tab is JSON, and has none. */
  protected async formatSource(): Promise<void> {
    await this.editor()?.format();
  }

  protected onToolbarPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="tab"]')) return;

    this.dragStart.emit(event);
  }
}
