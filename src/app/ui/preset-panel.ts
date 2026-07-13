import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import type { Preset } from '../../shared/model';
import { ShaderStore } from '../core/shader-store';
import { Workspace } from './workspace';

/** The Presets tab. Its heading and its save action belong to `InspectorPanel`. */
@Component({
  selector: 'app-preset-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatChipsModule, MatIconModule, MatMenuModule],
  template: `
    @if (store.presets().length === 0) {
      <p class="empty">
        No presets yet. Tune the parameters, then save them with the bookmark button above.
      </p>
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
            [title]="hint(preset)"
            [matContextMenuTriggerFor]="presetMenu"
            [matContextMenuTriggerData]="{ preset }"
          >
            @if (preset.render) {
              <mat-icon matChipAvatar aria-hidden="true">blur_on</mat-icon>
            }
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
      padding: 0 12px;
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

  protected hint(preset: Preset): string {
    return preset.render
      ? 'Restores the parameter values and the render settings. Right-click to delete'
      : 'Restores the parameter values. Right-click to delete';
  }
}
