import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import { I18n, type TranslationParams } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import type {
  ExplorerCommandEvent,
  ExplorerContextCommand,
  ExplorerNode,
  ExplorerReorderIntent,
  ExplorerSelectEvent,
  ExplorerTree,
  ExplorerViewMode,
} from './contract';
import {
  mergeExpansionState,
  toggleExpanded,
  visibleExplorerRows,
  type ExplorerExpansionState,
} from './explorer-expansion';
import { explorerTranslationKey, type ExplorerI18nKey } from './explorer-i18n-keys';
import { resolveExplorerKeyboardAction } from './explorer-keyboard';
import { buildReorderIntent } from './explorer-reorder';

/**
 * Standalone editor-local file explorer panel.
 *
 * Renders an `ExplorerTree` from the projection layer and emits selection,
 * command, reorder, view, and collapse intents for integration to handle.
 */
@Component({
  selector: 'app-explorer-panel',
  imports: [
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  host: {
    role: 'complementary',
    '[attr.aria-label]': 'ex("ariaPanel")',
    class: 'explorer-panel',
  },
  template: `
    <header class="header">
      <h2 class="title">{{ ex('title') }}</h2>

      <div class="view-switch" role="tablist" [attr.aria-label]="ex('ariaViewSwitch')">
        @for (mode of viewModes; track mode) {
          <button
            type="button"
            role="tab"
            class="view-tab"
            [class.active]="tree().view === mode"
            [attr.aria-selected]="tree().view === mode"
            [attr.aria-controls]="'explorer-tree'"
            (click)="onViewChange(mode)"
          >
            {{ ex(mode === 'files' ? 'viewFiles' : 'viewPipeline') }}
          </button>
        }
      </div>

      <span class="spacer"></span>

      <button
        matIconButton
        type="button"
        class="icon-action"
        [matTooltip]="ex('createMenu')"
        [attr.aria-label]="ex('createMenu')"
        [matMenuTriggerFor]="createMenu"
      >
        <mat-icon>add</mat-icon>
      </button>

      <button
        matIconButton
        type="button"
        class="icon-action collapse"
        [matTooltip]="ex('collapse')"
        [attr.aria-label]="ex('collapseAria')"
        (click)="collapse.emit()"
      >
        <mat-icon>chevron_left</mat-icon>
      </button>
    </header>

    <mat-menu #createMenu="matMenu">
      <button
        mat-menu-item
        type="button"
        [disabled]="!canCreateBuffer()"
        [matTooltip]="canCreateBuffer() ? '' : ex('buffersFull')"
        (click)="emitCommand('create-buffer')"
      >
        <mat-icon>layers</mat-icon>
        <span>{{ ex('createBuffer') }}</span>
      </button>
      <button mat-menu-item type="button" (click)="emitCommand('create-file')">
        <mat-icon>description</mat-icon>
        <span>{{ ex('createFile') }}</span>
      </button>
    </mat-menu>

    @if (tree().emptyReason === 'loading') {
      <div class="state loading" role="status">
        <mat-spinner diameter="28" />
        <p>{{ ex('stateLoading') }}</p>
      </div>
    } @else if (tree().emptyReason === 'no-project') {
      <p class="state empty">{{ ex('stateNoProject') }}</p>
    } @else if (tree().emptyReason === 'no-documents') {
      <p class="state empty">{{ ex('stateNoDocuments') }}</p>
    } @else {
      <div
        #treeRoot
        id="explorer-tree"
        class="tree-scroll"
        tabindex="0"
        role="tree"
        [attr.aria-label]="ex('ariaTree')"
        (keydown)="onTreeKeydown($event)"
        (focusin)="onTreeFocusIn($event)"
      >
        <ul class="tree" role="presentation">
          @for (row of rows(); track row.node.id) {
            <li role="presentation">
              <div
                class="row"
                role="treeitem"
                [attr.id]="rowDomId(row.node.id)"
                [attr.data-node-id]="row.node.id"
                [attr.aria-level]="row.node.depth + 1"
                [attr.aria-expanded]="row.hasChildren ? row.expanded : null"
                [attr.aria-selected]="row.node.capabilities.selectable && row.node.status.active"
                [attr.aria-disabled]="row.node.status.disabled || null"
                [attr.aria-busy]="row.node.status.compiling || null"
                [attr.aria-label]="rowAriaLabel(row.node)"
                [class.active]="row.node.status.active"
                [class.disabled]="row.node.status.disabled"
                [class.selectable]="row.node.capabilities.selectable"
                [class.informational]="!row.node.capabilities.selectable"
                [class.focused]="focusedId() === row.node.id"
                [style.--explorer-depth]="row.node.depth"
                [attr.draggable]="row.node.capabilities.reorder || null"
                [matContextMenuTriggerFor]="rowMenu"
                [matContextMenuTriggerData]="{ node: row.node }"
                [tabindex]="focusedId() === row.node.id ? 0 : -1"
                (click)="onRowClick($event, row.node)"
                (dblclick)="onRowDblClick(row.node)"
                (dragstart)="onDragStart($event, row.node)"
                (dragover)="onDragOver($event, row.node)"
                (drop)="onDrop($event, row.node)"
                (dragend)="onDragEnd()"
              >
                @if (row.hasChildren) {
                  <button
                    type="button"
                    class="expand"
                    [attr.aria-label]="ex(row.expanded ? 'collapseGroup' : 'expandGroup')"
                    [attr.aria-expanded]="row.expanded"
                    (click)="onToggleExpand($event, row.node.id)"
                  >
                    <mat-icon aria-hidden="true">
                      {{ row.expanded ? 'expand_more' : 'chevron_right' }}
                    </mat-icon>
                  </button>
                } @else {
                  <span class="expand-spacer" aria-hidden="true"></span>
                }

                <mat-icon class="node-icon" aria-hidden="true">{{ row.node.icon }}</mat-icon>

                <span class="label" [class.struck]="row.node.status.disabled">
                  @if (row.node.labelKey; as labelKey) {
                    {{ label(labelKey) }}
                  } @else {
                    {{ row.node.name }}
                  }
                </span>

                <span class="status" aria-hidden="true">
                  @if (row.node.status.errorCount > 0) {
                    <span class="badge error">{{ row.node.status.errorCount }}</span>
                  } @else if (row.node.status.compiling) {
                    <span class="dot compiling"></span>
                  } @else if (row.node.status.dirty) {
                    <span class="dot dirty"></span>
                  } @else if (row.node.status.active) {
                    <span class="dot active"></span>
                  }
                </span>

                @if (hasRowCommands(row.node)) {
                  <button
                    type="button"
                    class="row-menu"
                    [attr.aria-label]="ex('rowActions')"
                    [matMenuTriggerFor]="rowMenu"
                    [matMenuTriggerData]="{ node: row.node }"
                    (click)="$event.stopPropagation()"
                  >
                    <mat-icon aria-hidden="true">more_vert</mat-icon>
                  </button>
                }
              </div>
            </li>
          }
        </ul>
      </div>
    }

    <mat-menu #rowMenu="matMenu">
      <ng-template matMenuContent let-node="node">
        <button
          mat-menu-item
          type="button"
          [disabled]="!node.capabilities.rename"
          (click)="emitNodeCommand('rename', node)"
        >
          <mat-icon>edit</mat-icon>
          <span>{{ ex('commandRename') }}</span>
        </button>
        <button
          mat-menu-item
          type="button"
          [disabled]="!node.capabilities.duplicate"
          (click)="emitNodeCommand('duplicate', node)"
        >
          <mat-icon>content_copy</mat-icon>
          <span>{{ ex('commandDuplicate') }}</span>
        </button>

        @if (node.capabilities.toggleEnabled) {
          <button
            mat-menu-item
            type="button"
            (click)="emitNodeCommand(node.status.disabled ? 'enable' : 'disable', node)"
          >
            <mat-icon>{{ node.status.disabled ? 'visibility' : 'visibility_off' }}</mat-icon>
            <span>
              {{ ex(node.status.disabled ? 'commandEnable' : 'commandDisable') }}
            </span>
          </button>
        }

        @if (node.capabilities.delete) {
          <mat-divider />
          <button
            mat-menu-item
            type="button"
            class="destructive"
            (click)="emitNodeCommand('delete', node)"
          >
            <mat-icon>delete</mat-icon>
            <span>{{ ex('commandDelete') }}</span>
          </button>
        }
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      background: color-mix(in srgb, var(--mat-sys-surface) 88%, transparent);
      border-inline-end: 1px solid
        color-mix(in srgb, var(--mat-sys-outline-variant) 55%, transparent);
    }

    .header {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      padding: 4px 4px 4px 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-outline-variant) 45%, transparent);
    }

    .title {
      margin: 0;
      font: var(--mat-sys-title-small);
      white-space: nowrap;
    }

    .view-switch {
      display: inline-flex;
      gap: 2px;
      margin-inline: 4px;
      padding: 2px;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 6%, transparent);
    }

    .view-tab {
      border: 0;
      border-radius: calc(var(--mat-sys-corner-small, 6px) - 2px);
      padding: 2px 8px;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      cursor: pointer;
    }

    .view-tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .view-tab:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 1px;
    }

    .spacer {
      flex: 1;
    }

    .icon-action {
      flex: 0 0 auto;
    }

    .tree-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 0;
      outline: none;
    }

    .tree {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 28px;
      padding-inline-end: 4px;
      padding-inline-start: calc(8px + var(--explorer-depth, 0) * 14px);
      border-radius: var(--mat-sys-corner-small, 6px);
      cursor: default;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface);
    }

    .row.selectable {
      cursor: pointer;
    }

    .row.selectable:hover,
    .row.focused {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .row.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .row.disabled .label.struck {
      opacity: 0.65;
      text-decoration: line-through;
    }

    .row.informational {
      color: var(--mat-sys-on-surface-variant);
    }

    .row:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .expand,
    .expand-spacer {
      flex: 0 0 20px;
      width: 20px;
      height: 20px;
    }

    .expand {
      display: inline-grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    .expand mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }

    .node-icon {
      flex: 0 0 auto;
      font-size: 16px;
      width: 16px;
      height: 16px;
    }

    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      min-width: 18px;
      justify-content: center;
    }

    .badge.error {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-small);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: transparent;
    }

    .dot.dirty {
      background: var(--mat-sys-tertiary);
    }

    .dot.active {
      background: color-mix(in srgb, var(--mat-sys-primary) 55%, transparent);
    }

    .dot.compiling {
      background: var(--mat-sys-on-surface-variant);
      animation: explorer-pulse 1s ease-in-out infinite;
    }

    @keyframes explorer-pulse {
      50% {
        opacity: 0.25;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dot.compiling {
        animation: none;
      }
    }

    .row-menu {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      opacity: 0;
      cursor: pointer;
    }

    .row:hover .row-menu,
    .row.focused .row-menu {
      opacity: 1;
    }

    .row-menu mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }

    .state {
      display: grid;
      place-items: center;
      gap: 12px;
      margin: 0;
      padding: 24px 16px;
      text-align: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    .state.empty {
      min-height: 120px;
    }

    .destructive {
      color: var(--mat-sys-error);
    }
  `,
})
export class ExplorerPanel {
  protected readonly i18n = inject(I18n);
  protected readonly viewModes: readonly ExplorerViewMode[] = ['files', 'pipeline'];

  readonly tree = input.required<ExplorerTree>();
  readonly canCreateBuffer = input(true);

  readonly viewChange = output<ExplorerViewMode>();
  readonly select = output<ExplorerSelectEvent>();
  readonly command = output<ExplorerCommandEvent>();
  readonly reorder = output<ExplorerReorderIntent>();
  readonly collapse = output<void>();

  private readonly treeRoot = viewChild<ElementRef<HTMLElement>>('treeRoot');
  private readonly expansion = signal<ExplorerExpansionState>(new Map());
  protected readonly focusedId = signal<string | null>(null);
  private dragging: ExplorerNode | null = null;

  protected readonly rows = computed(() =>
    visibleExplorerRows(this.tree().nodes, this.expansion()),
  );

  constructor() {
    effect(() => {
      const nodes = this.tree().nodes;
      this.expansion.update((current) => mergeExpansionState(nodes, current));
      const visible = visibleExplorerRows(nodes, this.expansion());
      const focused = this.focusedId();
      if (visible.length === 0) {
        this.focusedId.set(null);
      } else if (!focused || !visible.some((row) => row.node.id === focused)) {
        this.focusedId.set(visible[0]?.node.id ?? null);
      }
    });
  }

  protected ex(key: ExplorerI18nKey, params?: TranslationParams): string {
    return this.i18n.t(explorerTranslationKey(key), params);
  }

  protected label(key: string): string {
    return this.i18n.t(key as TranslationKey);
  }

  protected rowDomId(nodeId: string): string {
    return `explorer-row-${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }

  protected rowAriaLabel(node: ExplorerNode): string | null {
    const parts: string[] = [];
    if (node.labelKey) {
      parts.push(this.i18n.t(node.labelKey as never));
    } else if (node.name) {
      parts.push(node.name);
    }
    if (node.status.disabled) {
      parts.push(this.ex('statusDisabled'));
    }
    if (node.status.compiling) {
      parts.push(this.ex('statusCompiling'));
    }
    if (node.status.dirty) {
      parts.push(this.ex('statusUnsaved'));
    }
    if (node.status.errorCount > 0) {
      parts.push(this.ex('statusErrors', { count: node.status.errorCount }));
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }

  protected hasRowCommands(node: ExplorerNode): boolean {
    return (
      node.capabilities.rename ||
      node.capabilities.duplicate ||
      node.capabilities.delete ||
      node.capabilities.toggleEnabled
    );
  }

  protected onViewChange(mode: ExplorerViewMode): void {
    if (mode !== this.tree().view) this.viewChange.emit(mode);
  }

  protected onToggleExpand(event: MouseEvent, nodeId: string): void {
    event.stopPropagation();
    this.expansion.update((state) => toggleExpanded(state, nodeId));
  }

  protected onRowClick(event: MouseEvent, node: ExplorerNode): void {
    this.focusedId.set(node.id);
    if (!node.capabilities.selectable || !node.docId) return;
    if (event.detail > 1) return;
    this.select.emit({ docId: node.docId });
  }

  protected onRowDblClick(node: ExplorerNode): void {
    if (node.capabilities.rename && node.docId) {
      this.emitNodeCommand('rename', node);
    }
  }

  protected emitCommand(command: ExplorerContextCommand): void {
    this.command.emit({ command });
  }

  protected emitNodeCommand(command: ExplorerContextCommand, node: ExplorerNode): void {
    this.command.emit({ command, docId: node.docId });
  }

  protected onTreeKeydown(event: KeyboardEvent): void {
    const action = resolveExplorerKeyboardAction(event, this.rows(), this.focusedId());
    if (!action) return;

    switch (action.type) {
      case 'focus':
        event.preventDefault();
        this.focusRow(action.nodeId);
        break;
      case 'expand':
      case 'collapse':
        event.preventDefault();
        this.expansion.update((state) => toggleExpanded(state, action.nodeId));
        break;
      case 'activate':
        event.preventDefault();
        this.select.emit({ docId: action.docId });
        break;
      case 'open-menu':
        event.preventDefault();
        this.openRowMenu(action.nodeId);
        break;
    }
  }

  protected onTreeFocusIn(event: FocusEvent): void {
    const target = event.target as HTMLElement | null;
    const nodeId = target?.closest<HTMLElement>('[data-node-id]')?.dataset['nodeId'];
    if (nodeId) this.focusedId.set(nodeId);
  }

  protected onDragStart(event: DragEvent, node: ExplorerNode): void {
    if (!node.capabilities.reorder) {
      event.preventDefault();
      return;
    }
    this.dragging = node;
    event.dataTransfer?.setData('text/plain', node.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, node: ExplorerNode): void {
    const source = this.dragging;
    if (!source || !buildReorderIntent(source, node)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onDrop(event: DragEvent, node: ExplorerNode): void {
    const source = this.dragging;
    this.dragging = null;
    if (!source) return;
    const intent = buildReorderIntent(source, node);
    if (!intent) return;
    event.preventDefault();
    this.reorder.emit(intent);
  }

  protected onDragEnd(): void {
    this.dragging = null;
  }

  focusNode(nodeId?: string | null): void {
    const targetId = nodeId && this.rows().some((row) => row.node.id === nodeId) ? nodeId : this.focusedId();
    if (targetId) {
      this.focusRow(targetId);
      return;
    }

    const first = this.rows()[0]?.node.id;
    if (first) this.focusRow(first);
  }

  private focusRow(nodeId: string): void {
    this.focusedId.set(nodeId);
    const element = this.treeRoot()?.nativeElement.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"]`,
    );
    element?.focus();
  }

  private openRowMenu(nodeId: string): void {
    const element = this.treeRoot()?.nativeElement.querySelector<HTMLElement>(
      `[data-node-id="${nodeId}"] .row-menu`,
    );
    element?.click();
  }
}
