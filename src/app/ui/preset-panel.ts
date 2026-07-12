import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ShaderStore } from '../core/shader-store';
import { Workspace } from './workspace';

@Component({
  selector: 'app-preset-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatChipsModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <header class="panel-header">
      <h2 class="panel-title">Presets</h2>
      <button
        matIconButton
        type="button"
        matTooltip="Save the current parameter values as a preset"
        aria-label="Save preset"
        [disabled]="!store.record()"
        (click)="workspace.savePreset()"
      >
        <mat-icon>bookmark_add</mat-icon>
      </button>
    </header>

    @if (store.presets().length === 0) {
      <p class="empty">No presets. Tune the parameters below, then save them here.</p>
    } @else {
      <mat-chip-listbox
        class="presets"
        aria-label="Presets"
        [value]="store.activePresetId()"
        (change)="apply($event.value)"
      >
        @for (preset of store.presets(); track preset.id) {
          <mat-chip-option
            class="preset-chip"
            [value]="preset.id"
            [selected]="preset.id === store.activePresetId()"
            title="Right-click to delete"
            [matContextMenuTriggerFor]="presetMenu"
            [matContextMenuTriggerData]="{ preset }"
          >
            {{ preset.name }}
          </mat-chip-option>
        }
      </mat-chip-listbox>
    }

    <mat-menu #presetMenu="matMenu">
      <ng-template matMenuContent let-preset="preset">
        <button
          mat-menu-item
          type="button"
          (click)="workspace.deletePreset(preset.id, preset.name)"
        >
          <mat-icon>delete</mat-icon>
          <span>Delete</span>
        </button>
      </ng-template>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .panel-title {
      margin: 0;
      font: var(--mat-sys-title-small);
    }

    .presets {
      --mdc-chip-container-height: 30px;
    }

    .preset-chip {
      cursor: context-menu;
    }

    .empty {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class PresetPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(Workspace);

  protected apply(presetId: string | null): void {
    if (presetId) this.store.applyPreset(presetId);
  }
}
