import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';

import {
  POST_PROCESSING_EFFECT_TYPES,
  addPostProcessingEffect,
  getBloomEffect,
  getVignetteEffect,
  movePostProcessingEffect,
  removePostProcessingEffect,
  resetPostProcessingEffect,
  setPostProcessingEffectEnabled,
  withBloomEffect,
  withPostProcessingEnabled,
  withVignetteEffect,
  type BloomEffect,
  type PostProcessingEffect,
  type PostProcessingEffectType,
  type RenderSettings,
  type VignetteEffect,
} from '@shader-studio/shared/model';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore } from '../../workspace/shader-store';

const EFFECT_LABEL_KEY: Record<PostProcessingEffectType, TranslationKey> = {
  bloom: 'rack.bloom',
  vignette: 'rack.vignette',
};

/**
 * The Effects Rack: the post-processing chain's only UI. It lives above the
 * shader's own parameter controls in the Controls tab rather than a tab of
 * its own — a chain of at most one Bloom and one Vignette does not earn a
 * cramped fourth tab, and it belongs next to the params it renders alongside.
 *
 * Every mutation reads the draft's `render`, runs it through one of the pure
 * chain helpers from `@shader-studio/shared/model`, and writes the whole
 * result back through `ShaderStore.setRender` — exactly like a parameter
 * edit: one immutable value, the draft marked dirty, surviving save/reload
 * and recovery the same way.
 */
@Component({
  selector: 'app-post-processing-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatSliderModule,
    MatSlideToggleModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  template: `
    <section class="rack" [attr.aria-label]="'rack.title' | translate">
      <header class="rack-header">
        <h3 class="rack-heading">{{ 'rack.title' | translate }}</h3>

        <mat-slide-toggle
          data-testid="pp-master-toggle"
          [attr.aria-label]="'rack.masterAria' | translate"
          [ngModel]="chainEnabled()"
          (ngModelChange)="setChainEnabled($event)"
        />

        <button
          matIconButton
          type="button"
          data-testid="pp-add"
          [matTooltip]="'rack.addAria' | translate"
          [attr.aria-label]="'rack.addAria' | translate"
          [matMenuTriggerFor]="addMenu"
        >
          <mat-icon>add</mat-icon>
        </button>
      </header>

      <mat-menu #addMenu="matMenu">
        @for (type of types; track type) {
          <button
            mat-menu-item
            type="button"
            [attr.data-testid]="'pp-add-' + type"
            [disabled]="!canAdd(type)"
            [matTooltip]="canAdd(type) ? '' : ('rack.addTypeDisabledHint' | translate)"
            (click)="add(type)"
          >
            <span>{{ label(type) }}</span>
          </button>
        }
      </mat-menu>

      @if (effects().length === 0) {
        <p class="empty">{{ 'rack.empty' | translate }}</p>
      }

      @for (effect of effects(); track effect.type; let first = $first; let last = $last) {
        <section
          class="effect"
          [class.effect-disabled]="!effect.enabled"
          [attr.data-testid]="'pp-effect-' + effect.type"
          draggable="true"
          (dragstart)="onDragStart($event, effect.type)"
          (dragover)="onDragOver($event, effect.type)"
          (drop)="onDrop($event, effect.type)"
          (dragend)="onDragEnd()"
        >
          <header class="effect-header">
            <mat-icon class="drag-handle" aria-hidden="true">drag_indicator</mat-icon>

            <mat-slide-toggle
              [attr.data-testid]="'pp-enable-' + effect.type"
              [attr.aria-label]="ariaFor('rack.enabledAria', effect.type)"
              [ngModel]="effect.enabled"
              (ngModelChange)="setEnabled(effect.type, $event)"
            >
              {{ label(effect.type) }}
            </mat-slide-toggle>

            <span class="spacer"></span>

            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-move-up-' + effect.type"
              [disabled]="first"
              [matTooltip]="ariaFor('rack.moveUpAria', effect.type)"
              [attr.aria-label]="ariaFor('rack.moveUpAria', effect.type)"
              (click)="move(effect.type, 'up')"
            >
              <mat-icon>arrow_upward</mat-icon>
            </button>
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-move-down-' + effect.type"
              [disabled]="last"
              [matTooltip]="ariaFor('rack.moveDownAria', effect.type)"
              [attr.aria-label]="ariaFor('rack.moveDownAria', effect.type)"
              (click)="move(effect.type, 'down')"
            >
              <mat-icon>arrow_downward</mat-icon>
            </button>
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-reset-' + effect.type"
              [matTooltip]="ariaFor('rack.resetAria', effect.type)"
              [attr.aria-label]="ariaFor('rack.resetAria', effect.type)"
              (click)="reset(effect.type)"
            >
              <mat-icon>restart_alt</mat-icon>
            </button>
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'pp-remove-' + effect.type"
              [matTooltip]="ariaFor('rack.removeAria', effect.type)"
              [attr.aria-label]="ariaFor('rack.removeAria', effect.type)"
              (click)="remove(effect.type)"
            >
              <mat-icon>close</mat-icon>
            </button>
          </header>

          @if (effect.type === 'bloom') {
            <div class="sliders">
              <label class="field">
                <span class="field-label">
                  {{ 'rack.strength' | translate }}
                  <span class="value">{{ effect.settings.strength.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="2" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.strength"
                    (ngModelChange)="setBloomSetting({ strength: $event })"
                  />
                </mat-slider>
              </label>
              <label class="field">
                <span class="field-label">
                  {{ 'rack.radius' | translate }}
                  <span class="value">{{ effect.settings.radius.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="1" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.radius"
                    (ngModelChange)="setBloomSetting({ radius: $event })"
                  />
                </mat-slider>
              </label>
              <label class="field">
                <span class="field-label">
                  {{ 'rack.threshold' | translate }}
                  <span class="value">{{ effect.settings.threshold.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="1" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.threshold"
                    (ngModelChange)="setBloomSetting({ threshold: $event })"
                  />
                </mat-slider>
              </label>
            </div>
          } @else {
            <div class="sliders">
              <label class="field">
                <span class="field-label">
                  {{ 'rack.intensity' | translate }}
                  <span class="value">{{ effect.settings.intensity.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="1" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.intensity"
                    (ngModelChange)="setVignetteSetting({ intensity: $event })"
                  />
                </mat-slider>
              </label>
              <label class="field">
                <span class="field-label">
                  {{ 'rack.softness' | translate }}
                  <span class="value">{{ effect.settings.softness.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="1" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.softness"
                    (ngModelChange)="setVignetteSetting({ softness: $event })"
                  />
                </mat-slider>
              </label>
              <label class="field">
                <span class="field-label">
                  {{ 'rack.roundness' | translate }}
                  <span class="value">{{ effect.settings.roundness.toFixed(2) }}</span>
                </span>
                <mat-slider [min]="0" [max]="1" [step]="0.01">
                  <input
                    matSliderThumb
                    [ngModel]="effect.settings.roundness"
                    (ngModelChange)="setVignetteSetting({ roundness: $event })"
                  />
                </mat-slider>
              </label>
            </div>
          }
        </section>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      padding: 0 12px;
      margin-bottom: 8px;
      border-bottom: 1px solid color-mix(in srgb, var(--mat-sys-outline-variant) 55%, transparent);
    }

    .rack {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 10px;
    }

    .rack-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .rack-heading {
      flex: 1;
      margin: 0;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }

    .empty {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .effect {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 4%, transparent);
    }

    .effect-disabled {
      opacity: 0.7;
    }

    .effect-header {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .drag-handle {
      flex: 0 0 auto;
      color: var(--mat-sys-on-surface-variant);
      cursor: grab;
    }

    .spacer {
      flex: 1;
    }

    .sliders {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .field-label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
    }

    .value {
      font-variant-numeric: tabular-nums;
      color: var(--mat-sys-primary);
    }

    mat-slider {
      width: 100%;
    }
  `,
})
export class PostProcessingPanel {
  protected readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);

  protected readonly types = POST_PROCESSING_EFFECT_TYPES;

  private readonly render = computed<RenderSettings | null>(
    () => this.store.draft()?.render ?? null,
  );
  protected readonly effects = computed<PostProcessingEffect[]>(
    () => this.render()?.postProcessing.effects ?? [],
  );
  protected readonly chainEnabled = computed(() => this.render()?.postProcessing.enabled ?? true);

  private dragging: PostProcessingEffectType | null = null;

  protected label(type: PostProcessingEffectType): string {
    return this.i18n.t(EFFECT_LABEL_KEY[type]);
  }

  protected ariaFor(key: TranslationKey, type: PostProcessingEffectType): string {
    return this.i18n.t(key, { name: this.label(type) });
  }

  protected canAdd(type: PostProcessingEffectType): boolean {
    return !this.effects().some((effect) => effect.type === type);
  }

  protected setChainEnabled(enabled: boolean): void {
    this.mutate((render) => withPostProcessingEnabled(render, enabled));
  }

  protected add(type: PostProcessingEffectType): void {
    if (!this.canAdd(type)) return;
    this.mutate((render) => addPostProcessingEffect(render, type));
  }

  protected remove(type: PostProcessingEffectType): void {
    this.mutate((render) => removePostProcessingEffect(render, type));
  }

  protected reset(type: PostProcessingEffectType): void {
    this.mutate((render) => resetPostProcessingEffect(render, type));
  }

  protected setEnabled(type: PostProcessingEffectType, enabled: boolean): void {
    this.mutate((render) => setPostProcessingEffectEnabled(render, type, enabled));
  }

  protected move(type: PostProcessingEffectType, direction: 'up' | 'down'): void {
    this.mutate((render) => movePostProcessingEffect(render, type, direction));
  }

  /**
   * Re-reads the effect from the render passed into `mutate` — never from a
   * template-bound closure — so a rapid string of edits (or a change made
   * elsewhere in the chain between renders) is never clobbered by a stale
   * snapshot of the effect's other fields.
   */
  protected setBloomSetting(patch: Partial<BloomEffect['settings']>): void {
    this.mutate((render) =>
      withBloomEffect(render, { enabled: getBloomEffect(render).enabled, ...patch }),
    );
  }

  protected setVignetteSetting(patch: Partial<VignetteEffect['settings']>): void {
    this.mutate((render) =>
      withVignetteEffect(render, { enabled: getVignetteEffect(render).enabled, ...patch }),
    );
  }

  // --- Drag reorder ---------------------------------------------------------
  // Mouse convenience only — the move-up/down buttons above are the
  // keyboard-operable path required for accessibility. With at most one
  // instance per type (Phase 1), dropping A onto B is always a swap, so this
  // rides on the same adjacent-swap helper the buttons use.

  protected onDragStart(event: DragEvent, type: PostProcessingEffectType): void {
    this.dragging = type;
    event.dataTransfer?.setData('text/plain', type);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(event: DragEvent, type: PostProcessingEffectType): void {
    if (!this.dragging || this.dragging === type) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onDrop(event: DragEvent, type: PostProcessingEffectType): void {
    event.preventDefault();
    const source = this.dragging;
    this.dragging = null;
    if (!source || source === type) return;

    const effects = this.effects();
    const from = effects.findIndex((effect) => effect.type === source);
    const to = effects.findIndex((effect) => effect.type === type);
    if (from < 0 || to < 0) return;
    this.move(source, from < to ? 'down' : 'up');
  }

  protected onDragEnd(): void {
    this.dragging = null;
  }

  private mutate(fn: (render: RenderSettings) => RenderSettings): void {
    const current = this.render();
    if (!current) return;
    this.store.setRender(fn(current));
  }
}
