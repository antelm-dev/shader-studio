import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ShaderStore } from '../core/shader-store';
import { Workspace } from './workspace';

/**
 * Presets for the open shader.
 *
 * A preset is a named snapshot of the parameter values, so the panel sits
 * directly above the generated GUI: you turn the knobs, then capture them.
 * Applying one is a purely local operation — no round trip, nothing saved —
 * which is what makes flicking between looks feel instant.
 */
@Component({
  selector: 'app-preset-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatChipsModule, MatIconModule, MatTooltipModule],
  template: `
    <header class="panel-header">
      <h2 class="panel-title">Presets</h2>
      <button
        matButton
        type="button"
        matTooltip="Save the current parameter values as a preset"
        [disabled]="!store.record()"
        (click)="workspace.savePreset()"
      >
        <mat-icon>bookmark_add</mat-icon>
        Save
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
          <mat-chip-option [value]="preset.id" [selected]="preset.id === store.activePresetId()">
            {{ preset.name }}
            <button
              matChipRemove
              type="button"
              [attr.aria-label]="'Delete preset ' + preset.name"
              (click)="remove($event, preset.id, preset.name)"
            >
              <mat-icon>cancel</mat-icon>
            </button>
          </mat-chip-option>
        }
      </mat-chip-listbox>
    }
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

  /** A chip listbox emits null when the selected chip is toggled off. */
  protected apply(presetId: string | null): void {
    if (presetId) this.store.applyPreset(presetId);
  }

  protected remove(event: Event, presetId: string, name: string): void {
    // Otherwise the chip's own click would also select the preset being deleted.
    event.stopPropagation();
    void this.workspace.deletePreset(presetId, name);
  }
}
