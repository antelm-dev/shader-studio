import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { ShaderStore } from '../core/shader-store';
import { Workspace } from './workspace';

/**
 * The shader collection.
 *
 * A single-select list, so `mat-nav-list` would be wrong: this is a listbox
 * whose selection drives the whole app. Arrow keys move through it, Enter and
 * Space select, and each row carries its own overflow menu.
 */
@Component({
  selector: 'app-shader-browser',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatMenuModule,
    MatTooltipModule,
  ],
  template: `
    <header class="browser-header">
      <h2 class="browser-title">Shaders</h2>
      <button
        matIconButton
        type="button"
        matTooltip="New shader"
        aria-label="Create a new shader"
        (click)="workspace.createShader()"
      >
        <mat-icon>add</mat-icon>
      </button>
    </header>

    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="search">
      <mat-icon matPrefix>search</mat-icon>
      <mat-label>Filter</mat-label>
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
        {{ store.shaders().length === 0 ? 'No shaders yet.' : 'No shader matches that filter.' }}
      </p>
    } @else {
      <mat-selection-list
        class="shader-list"
        aria-label="Shaders"
        [multiple]="false"
        (selectionChange)="select($event.options[0].value)"
      >
        @for (shader of filtered(); track shader.id) {
          <mat-list-option
            [value]="shader.id"
            [selected]="shader.id === store.selectedId()"
            togglePosition="before"
          >
            <span matListItemTitle class="row-title">{{ shader.name }}</span>
            <span matListItemLine class="row-meta">
              {{ shader.controlCount }} control{{ shader.controlCount === 1 ? '' : 's' }} ·
              {{ shader.presetCount }} preset{{ shader.presetCount === 1 ? '' : 's' }}
            </span>

            <button
              matIconButton
              type="button"
              class="row-actions"
              [attr.aria-label]="'Actions for ' + shader.name"
              [matMenuTriggerFor]="rowMenu"
              [matMenuTriggerData]="{ shader }"
              (click)="$event.stopPropagation()"
            >
              <mat-icon>more_vert</mat-icon>
            </button>
          </mat-list-option>
        }
      </mat-selection-list>
    }

    <!--
      One menu for the whole list, given the row's shader as context. Declaring
      it inside the list option instead would project a stray element into the
      row and break its layout.
    -->
    <mat-menu #rowMenu="matMenu">
      <ng-template matMenuContent let-shader="shader">
        <button mat-menu-item type="button" (click)="workspace.renameShader(shader.id, shader.name)">
          <mat-icon>edit</mat-icon>
          <span>Rename</span>
        </button>
        <button
          mat-menu-item
          type="button"
          (click)="workspace.duplicateShader(shader.id, shader.name)"
        >
          <mat-icon>content_copy</mat-icon>
          <span>Duplicate</span>
        </button>
        <button mat-menu-item type="button" (click)="workspace.exportShader(shader.id, shader.name)">
          <mat-icon>download</mat-icon>
          <span>Export</span>
        </button>
        <button mat-menu-item type="button" (click)="workspace.deleteShader(shader.id, shader.name)">
          <mat-icon>delete</mat-icon>
          <span>Delete</span>
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
      justify-content: space-between;
      gap: 8px;
      padding: 12px 8px 4px 16px;
    }

    .browser-title {
      margin: 0;
      font: var(--mat-sys-title-medium);
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

    .row-title {
      font: var(--mat-sys-body-large);
    }

    .row-meta {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    /*
     * MatListOption has no [matListItemMeta] outlet (MatListItem does), so an
     * overflow button can only be projected into the unscoped-content slot,
     * where it stacks underneath the text. Take it out of flow and pin it to
     * the trailing edge, which is where a meta action belongs anyway.
     */
    .shader-list ::ng-deep mat-list-option {
      position: relative;
    }

    .shader-list ::ng-deep .mat-mdc-list-item-unscoped-content {
      position: static;
    }

    .row-actions {
      position: absolute;
      top: 50%;
      right: 4px;
      transform: translateY(-50%);
    }

    /* Keep long names from running underneath the button. */
    .shader-list ::ng-deep .mdc-list-item__content {
      padding-right: 40px;
    }

    .empty {
      margin: 8px 16px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class ShaderBrowser {
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(Workspace);

  protected readonly query = signal('');

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

  protected select(id: string): void {
    void this.workspace.selectShader(id);
  }
}
