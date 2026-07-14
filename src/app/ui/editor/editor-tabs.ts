import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ShaderStore, type EditorDocument } from '../core/shader-store';

/** What a tab is doing, which is what its dot is coloured for. */
export type TabState = 'idle' | 'compiling' | 'error' | 'ok';

/**
 * The tab bar.
 *
 * Two things it has to get right, both of them about *telling things apart*.
 *
 * The first is passes versus files. A render pass is a stage of the pipeline; a
 * file is text that gets `#include`d into one. They are edited the same way and
 * they are emphatically not the same kind of object, so they are separated by a
 * rule, given different icons, and only passes get a state dot — a file does not
 * compile, so a file cannot be compiling.
 *
 * The second is the state of each pass, which is the thing you actually watch
 * while you work: modified, compiling, compiled, failed. That has to be legible
 * at a glance and out of the corner of your eye, so it is a dot and a colour
 * rather than a word.
 */
@Component({
  selector: 'app-editor-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDividerModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <div class="tabs" role="tablist" aria-label="Shader documents">
      @for (group of groups(); track group.kind) {
        @if (group.divider) {
          <mat-divider class="group-divider" vertical />
        }

        @for (doc of group.docs; track doc.id) {
          <button
            type="button"
            role="tab"
            class="tab"
            [class.active]="doc.id === activeId()"
            [class.disabled-pass]="doc.enabled === false"
            [attr.aria-selected]="doc.id === activeId()"
            [attr.draggable]="reorderable(doc)"
            [matTooltip]="tooltip(doc)"
            [matContextMenuTriggerFor]="tabMenu"
            [matContextMenuTriggerData]="{ doc }"
            (click)="select.emit(doc.id)"
            (dblclick)="onRename(doc)"
            (dragstart)="onDragStart($event, doc)"
            (dragover)="onDragOver($event, doc)"
            (drop)="onDrop($event, doc)"
          >
            <mat-icon class="tab-icon" aria-hidden="true">{{ icon(doc) }}</mat-icon>
            <span class="tab-name">{{ doc.name }}</span>

            @if (doc.kind === 'pass' || doc.kind === 'vertex' || doc.kind === 'config') {
              @if (errorCount(doc.id); as count) {
                <span class="badge error" [attr.aria-label]="count + ' errors'">{{ count }}</span>
              } @else {
                <span class="dot" [class]="state(doc)" aria-hidden="true"></span>
              }
            }
          </button>
        }
      }

      <button
        type="button"
        class="tab add"
        matTooltip="Add a buffer or a file"
        aria-label="Add a buffer or a file"
        [matMenuTriggerFor]="addMenu"
      >
        <mat-icon aria-hidden="true">add</mat-icon>
      </button>
    </div>

    <mat-menu #addMenu="matMenu">
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.canAddBuffer()"
        [matTooltip]="store.canAddBuffer() ? '' : 'All four buffer slots (A–D) are already in use'"
        (click)="store.addBufferPass()"
      >
        <mat-icon>layers</mat-icon>
        <span>New buffer pass</span>
      </button>
      <button mat-menu-item type="button" (click)="newFile.emit()">
        <mat-icon>description</mat-icon>
        <span>New file…</span>
        <span class="menu-hint">Ctrl+N</span>
      </button>
    </mat-menu>

    <mat-menu #tabMenu="matMenu">
      <ng-template matMenuContent let-doc="doc">
        <button mat-menu-item type="button" [disabled]="!renameable(doc)" (click)="onRename(doc)">
          <mat-icon>edit</mat-icon>
          <span>Rename…</span>
        </button>
        <button
          mat-menu-item
          type="button"
          [disabled]="!duplicable(doc)"
          (click)="onDuplicate(doc)"
        >
          <mat-icon>content_copy</mat-icon>
          <span>Duplicate</span>
        </button>

        @if (doc.passKind === 'buffer') {
          <button
            mat-menu-item
            type="button"
            (click)="store.setPassEnabledById(doc.id, doc.enabled === false)"
          >
            <mat-icon>{{ doc.enabled === false ? 'visibility' : 'visibility_off' }}</mat-icon>
            <span>{{ doc.enabled === false ? 'Enable' : 'Disable' }}</span>
          </button>
        }

        @if (deletable(doc)) {
          <mat-divider />
          <button mat-menu-item type="button" class="destructive" (click)="remove.emit(doc)">
            <mat-icon>delete</mat-icon>
            <span>Delete…</span>
          </button>
        }
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    .tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: min-content;
    }

    .group-divider {
      height: 18px;
      margin-inline: 5px;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      height: 28px;
      max-width: 168px;
      padding-inline: 9px;
      border: 0;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      cursor: pointer;
    }

    .tab:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    /* A disabled buffer is still editable — it just is not in the picture. */
    .tab.disabled-pass .tab-name,
    .tab.disabled-pass .tab-icon {
      opacity: 0.5;
      text-decoration: line-through;
    }

    .tab-icon {
      flex: 0 0 auto;
      width: 15px;
      height: 15px;
      font-size: 15px;
    }

    .tab-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tab.add {
      color: var(--mat-sys-on-surface-variant);
      padding-inline: 6px;
    }

    .badge {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      font: var(--mat-sys-label-small);
    }

    .badge.error {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }

    .dot {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: transparent;
    }

    /* Unsaved. The one state that persists, so it is the one that is solid. */
    .dot.idle {
      background: var(--mat-sys-tertiary);
    }

    .dot.ok {
      background: color-mix(in srgb, var(--mat-sys-primary) 55%, transparent);
    }

    .dot.compiling {
      background: var(--mat-sys-on-surface-variant);
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      50% {
        opacity: 0.25;
      }
    }

    /* Someone who asked their OS for less motion means it here too. */
    @media (prefers-reduced-motion: reduce) {
      .dot.compiling {
        animation: none;
      }
    }

    .destructive {
      color: var(--mat-sys-error);
    }

    .menu-hint {
      margin-left: auto;
      padding-left: 24px;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class EditorTabs {
  protected readonly store = inject(ShaderStore);

  readonly activeId = input<string | null>(null);

  readonly select = output<string>();
  readonly rename = output<EditorDocument>();
  readonly remove = output<EditorDocument>();
  readonly newFile = output<void>();

  /**
   * Passes, then files, then the two that belong to neither. Rendered as three
   * groups with a rule between them, because "this is a stage of the pipeline"
   * and "this is a file the pipeline includes" is the distinction the whole tab
   * bar exists to make.
   */
  protected readonly groups = computed(() => {
    const documents = this.store.documents();

    const of = (...kinds: EditorDocument['kind'][]): EditorDocument[] =>
      documents.filter((document) => kinds.includes(document.kind));

    return [
      { kind: 'pass' as const, divider: false, docs: of('pass') },
      { kind: 'file' as const, divider: true, docs: of('file') },
      { kind: 'other' as const, divider: true, docs: of('vertex', 'config') },
    ].filter((group) => group.docs.length > 0);
  });

  protected icon(doc: EditorDocument): string {
    if (doc.kind === 'file') return 'description';
    if (doc.kind === 'vertex') return 'change_history';
    if (doc.kind === 'config') return 'data_object';

    switch (doc.passKind) {
      case 'image':
        return 'image';
      case 'common':
        return 'share';
      default:
        return 'layers';
    }
  }

  protected tooltip(doc: EditorDocument): string {
    switch (doc.passKind) {
      case 'image':
        return 'The Image pass — what ends up on screen';
      case 'common':
        return 'Shared GLSL, included in every pass automatically';
      case 'buffer':
        return doc.enabled === false
          ? `Buffer ${doc.slot} — disabled, so it does not render`
          : `Buffer ${doc.slot} — renders to a texture other passes can sample`;
      default:
        break;
    }

    if (doc.kind === 'file') return `A source file. Include it with #include "${doc.name}"`;
    if (doc.kind === 'vertex') return 'The vertex shader, shared by every pass';
    return 'The control schema that drives the inspector';
  }

  protected errorCount(id: string): number {
    return this.store.errorCountFor(id);
  }

  /**
   * A tab's state is only ever about *this* pass. A project where Buffer B fails
   * to compile shows an error on Buffer B and a healthy Image pass, which is the
   * truth: the Image pass is still rendering, with the last Buffer B that worked.
   */
  protected state(doc: EditorDocument): TabState {
    if (this.store.compiling().has(doc.id)) return 'compiling';
    if (this.store.errorCountFor(doc.id) > 0) return 'error';
    return this.store.dirty() ? 'idle' : 'ok';
  }

  // The Image and Common passes are fixtures of the pipeline: there is always
  // exactly one of each, so they cannot be renamed, copied, moved or deleted.
  protected renameable(doc: EditorDocument): boolean {
    return doc.passKind === 'buffer' || doc.kind === 'file';
  }

  protected duplicable(doc: EditorDocument): boolean {
    return (doc.passKind === 'buffer' && this.store.canAddBuffer()) || doc.kind === 'file';
  }

  protected deletable(doc: EditorDocument): boolean {
    return doc.passKind === 'buffer' || doc.kind === 'file';
  }

  protected reorderable(doc: EditorDocument): boolean {
    return this.renameable(doc);
  }

  protected onRename(doc: EditorDocument): void {
    if (this.renameable(doc)) this.rename.emit(doc);
  }

  protected onDuplicate(doc: EditorDocument): void {
    if (doc.kind === 'file') this.store.duplicateSourceFile(doc.id);
    else this.store.duplicateBufferPass(doc.id);
  }

  // --- Reordering ---------------------------------------------------------
  //
  // Buffers reorder among buffers and files among files; a buffer dragged onto a
  // file goes nowhere. The two lists mean different things, and an order that
  // mixed them would not be an order of anything.

  private dragging: EditorDocument | null = null;

  protected onDragStart(event: DragEvent, doc: EditorDocument): void {
    if (!this.reorderable(doc)) {
      event.preventDefault();
      return;
    }
    this.dragging = doc;
    event.dataTransfer?.setData('text/plain', doc.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, doc: EditorDocument): void {
    const source = this.dragging;
    if (!source || !this.sameList(source, doc)) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onDrop(event: DragEvent, doc: EditorDocument): void {
    const source = this.dragging;
    this.dragging = null;
    if (!source || source.id === doc.id || !this.sameList(source, doc)) return;

    event.preventDefault();

    if (source.kind === 'file') {
      const index = this.store.project()?.files.findIndex((file) => file.id === doc.id) ?? -1;
      if (index >= 0) this.store.moveSourceFile(source.id, index);
      return;
    }

    const index = this.store.buffers().findIndex((pass) => pass.id === doc.id);
    if (index >= 0) this.store.movePassTo(source.id, index);
  }

  private sameList(a: EditorDocument, b: EditorDocument): boolean {
    if (a.kind === 'file') return b.kind === 'file';
    return a.passKind === 'buffer' && b.passKind === 'buffer';
  }
}
