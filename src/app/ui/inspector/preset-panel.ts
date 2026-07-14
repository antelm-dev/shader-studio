import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import type { Preset } from '@shader-studio/shared/model';
import { ShaderStore } from '../../workspace/shader-store';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { WorkspaceActions } from '../workspace-actions';

/** The Presets tab. Its heading and its save action belong to `InspectorPanel`. */
@Component({
  selector: 'app-preset-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatChipsModule, MatIconModule, MatMenuModule, TranslatePipe],
  template: `
    @if (store.presets().length === 0) {
      <p class="empty">
        {{ 'inspector.presetsEmpty' | translate }}
      </p>
    } @else {
      <mat-chip-listbox
        class="presets"
        [attr.aria-label]="'inspector.presets' | translate"
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
          <span>{{ 'action.delete' | translate }}</span>
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
  protected readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);

  protected apply(presetId: string | null): void {
    if (presetId) this.store.applyPreset(presetId);
  }

  protected hint(preset: Preset): string {
    return this.i18n.t(preset.render ? 'inspector.presetWithRender' : 'inspector.presetValuesOnly');
  }
}
