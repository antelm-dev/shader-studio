import { Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';

import { INSPECTOR_TABS, type InspectorTab } from '@shader-studio/shared/panel-prefs';
import { ShaderStore } from '../../workspace/shader-store';
import { GuiPanel } from './gui-panel';
import { InspectorWindowControls } from './inspector-window-controls';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { PresetPanel } from './preset-panel';
import { TexturePanel } from './texture-panel';
import { SurfaceLayoutService } from '../../surfaces';
import { WorkspaceActions } from '../workspace-actions';

/**
 * The inspector: parameters, textures and presets, one at a time.
 *
 * They used to be three panels stacked in a single scrolling column, which meant
 * an empty texture grid and an empty preset list cost you vertical space on every
 * shader that used neither — and that the controls, the thing you actually came
 * to turn, started below the fold. Tabs are what buy that space back.
 *
 * `preserveContent` is load-bearing, not a nicety. Without it Material detaches
 * an inactive tab's portal and destroys the view inside it, which would tear down
 * lil-gui and re-run its build on every tab switch, losing which folders you had
 * open, and would make the texture panel re-resolve four thumbnails each time you
 * came back to it. The same "never tear it down" rule the editor shell lives by.
 *
 * The tab bar also carries the counts, so you can see there are two textures
 * bound without opening the tab to find out.
 */
@Component({
  selector: 'app-inspector-panel',
  imports: [
    GuiPanel,
    InspectorWindowControls,
    MatButtonModule,
    MatIconModule,
    MatTabsModule,
    MatTooltipModule,
    PresetPanel,
    TexturePanel,
    TranslatePipe,
  ],
  template: `
    <header
      class="inspector-header"
      [class.draggable]="dragEnabled()"
      (pointerdown)="onHeaderPointerDown($event)"
    >
      <button
        matIconButton
        type="button"
        class="collapse"
        [matTooltip]="'inspector.collapse' | translate"
        [attr.aria-label]="'inspector.collapseAria' | translate"
        (click)="collapse()"
      >
        <mat-icon>chevron_right</mat-icon>
      </button>

      <span class="spacer"></span>

      <!-- One action slot, belonging to whichever tab is open. Keeping it here
           rather than inside each panel is what stops the inspector growing a
           third row of headings. -->
      @switch (tab()) {
        @case ('controls') {
          <button
            matIconButton
            type="button"
            [matTooltip]="'inspector.resetTooltip' | translate"
            [attr.aria-label]="'inspector.resetAria' | translate"
            [disabled]="store.controls().length === 0"
            (click)="store.resetParams()"
          >
            <mat-icon>restart_alt</mat-icon>
          </button>
        }
        @case ('presets') {
          <!-- "Save parameter preset", never just "Save": the toolbar's Save
               writes the shader, and the two were previously both called Save. -->
          <button
            matIconButton
            type="button"
            [matTooltip]="'inspector.savePresetTooltip' | translate"
            [attr.aria-label]="'inspector.savePresetAria' | translate"
            [disabled]="!store.record()"
            (click)="workspace.savePreset()"
          >
            <mat-icon>bookmark_add</mat-icon>
          </button>
        }
      }

      <app-inspector-window-controls />
    </header>

    <mat-tab-group
      class="tabs"
      [class.collapsed]="collapsed()"
      [preserveContent]="true"
      [selectedIndex]="index()"
      (selectedIndexChange)="selectTab($event)"
    >
      <mat-tab>
        <ng-template mat-tab-label>
          {{ 'inspector.controls' | translate }}
          @if (store.controls().length; as count) {
            <span class="badge">{{ count }}</span>
          }
        </ng-template>
        <app-gui-panel />
      </mat-tab>

      <mat-tab>
        <ng-template mat-tab-label>
          {{ 'inspector.textures' | translate }}
          @if (boundChannels(); as bound) {
            <span class="badge">{{ bound }}/4</span>
          }
        </ng-template>
        <app-texture-panel />
      </mat-tab>

      <mat-tab>
        <ng-template mat-tab-label>
          {{ 'inspector.presets' | translate }}
          @if (store.presets().length; as count) {
            <span class="badge">{{ count }}</span>
          }
        </ng-template>
        <app-preset-panel />
      </mat-tab>
    </mat-tab-group>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      /* The rail does not scroll — the open tab does. An absolutely positioned
         resize separator on the edge would otherwise scroll away from it. */
      overflow: hidden;
    }

    .inspector-header {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 4px;
      user-select: none;
    }

    /* Draggable only while floating — see InspectorShell — mirroring the
       editor toolbar's own drag-region convention. */
    .inspector-header.draggable {
      cursor: move;
    }

    .spacer {
      flex: 1;
    }

    .tabs {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    /* Minimized: the header (and its window controls) stays visible so the
       inspector can be expanded again; only the tab content collapses. */
    .tabs.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
    }

    /* Material sizes the body to its content by default; here it has to take the
       height it is given and let the panel inside it scroll. */
    .tabs ::ng-deep .mat-mdc-tab-body-wrapper {
      flex: 1;
      min-height: 0;
    }

    .tabs ::ng-deep .mat-mdc-tab-body-content {
      box-sizing: border-box;
      height: 100%;
      overflow-y: auto;
      padding: 12px 0 4px;
    }

    /* Keep every preserved tab panel stretched to the full body height, even
       when its own content is short. */
    .tabs ::ng-deep .mat-mdc-tab-body-content > app-gui-panel,
    .tabs ::ng-deep .mat-mdc-tab-body-content > app-texture-panel,
    .tabs ::ng-deep .mat-mdc-tab-body-content > app-preset-panel {
      box-sizing: border-box;
      height: 100%;
    }

    /* Three tabs have to fit a 260px rail: the label is what gives, not the
       target size. */
    .tabs ::ng-deep .mat-mdc-tab {
      flex-grow: 1;
      min-width: 0;
      padding: 0 8px;
      --mat-tab-header-label-text-size: var(--mat-sys-label-medium-size);
    }

    .badge {
      margin-left: 6px;
      padding: 0 6px;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
      line-height: 18px;
    }
  `,
})
export class InspectorPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);

  private readonly layout = inject(SurfaceLayoutService);

  /** Hides the tab content while the surface is minimized; header stays put. */
  readonly collapsed = input(false);
  /** Drag-enabled while floating — see InspectorShell. */
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  protected readonly tab = computed<InspectorTab>(() => this.layout.inspectorTab());
  protected readonly index = computed(() => INSPECTOR_TABS.indexOf(this.tab()));

  /** How many of the four channels have an image bound. */
  protected readonly boundChannels = computed(
    () => this.store.channels().filter((channel) => channel.ext !== null).length,
  );

  protected selectTab(index: number): void {
    const tab = INSPECTOR_TABS[index];
    if (tab) this.layout.setInspectorTab(tab);
  }

  protected collapse(): void {
    this.layout.close(this.layout.inspectorId);
  }

  protected onHeaderPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="menuitem"]')) return;

    this.dragStart.emit(event);
  }
}
