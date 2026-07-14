import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';

import {
  CHANNEL_INDICES,
  type ChannelBinding,
  type ChannelIndex,
  type PassResolutionMode,
  type RenderPass,
  type TextureFilterMode,
  type TextureWrapMode,
} from '@shader-studio/shared';

import { ShaderStore } from '../core/shader-store';

/**
 * How a channel is described in the one dropdown that sets it.
 *
 * Flattening "what kind of thing" and "which one" into a single list of options
 * is the whole point: a channel *is* one thing at a time, and asking the user to
 * pick a kind and then a target — through two controls that can disagree — turns
 * a one-click decision into a small state machine they have to keep in their head.
 */
interface ChannelOption {
  key: string;
  label: string;
  binding: ChannelBinding;
  group: 'none' | 'buffer' | 'texture';
}

@Component({
  selector: 'app-pass-config-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    @if (pass(); as target) {
      <div class="panel">
        <header>
          <mat-icon aria-hidden="true">tune</mat-icon>
          <h3>{{ target.name }}</h3>

          @if (target.kind === 'buffer') {
            <span class="slot" [matTooltip]="'Shaders sample this buffer as Buffer ' + target.slot">
              Buffer {{ target.slot }}
            </span>
          }
        </header>

        <!-- Channels. The Image pass has them too: it is a pass like any other. -->
        <section>
          <h4>Channels</h4>

          @for (channel of channels; track channel) {
            <div class="channel">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>iChannel{{ channel }}</mat-label>
                <mat-select
                  [value]="optionKey(target, channel)"
                  (valueChange)="setChannel(target, channel, $event)"
                >
                  @for (option of options(target); track option.key) {
                    <mat-option [value]="option.key">{{ option.label }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-checkbox
                class="feedback"
                [disabled]="!isBuffer(target, channel)"
                [checked]="hasFeedback(target, channel)"
                [matTooltip]="feedbackHint(target, channel)"
                (change)="setFeedback(target, channel, $event.checked)"
              >
                Feedback
              </mat-checkbox>
            </div>
          }
        </section>

        <!-- Only a buffer has a target of its own; the Image pass is the canvas. -->
        @if (target.kind === 'buffer') {
          <section>
            <h4>Resolution</h4>

            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Mode</mat-label>
              <mat-select [value]="target.resolution.mode" (valueChange)="setMode(target, $event)">
                <mat-option value="viewport">Match the canvas</mat-option>
                <mat-option value="scaled">A fraction of the canvas</mat-option>
                <mat-option value="fixed">A fixed size</mat-option>
              </mat-select>
            </mat-form-field>

            @if (target.resolution.mode === 'scaled') {
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Scale</mat-label>
                <input
                  matInput
                  type="number"
                  min="0.05"
                  max="4"
                  step="0.05"
                  [value]="target.resolution.scale"
                  (change)="setScale(target, $event)"
                />
              </mat-form-field>
            }

            @if (target.resolution.mode === 'fixed') {
              <div class="pair">
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>Width</mat-label>
                  <input
                    matInput
                    type="number"
                    min="1"
                    max="4096"
                    [value]="target.resolution.width"
                    (change)="setSize(target, 'width', $event)"
                  />
                </mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>Height</mat-label>
                  <input
                    matInput
                    type="number"
                    min="1"
                    max="4096"
                    [value]="target.resolution.height"
                    (change)="setSize(target, 'height', $event)"
                  />
                </mat-form-field>
              </div>
            }

            <p class="hint">
              Changing the size reallocates the buffer, which clears it. A feedback buffer starts
              its history again.
            </p>
          </section>

          <section>
            <h4>Sampling</h4>

            <div class="pair">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Filter</mat-label>
                <mat-select [value]="target.filter" (valueChange)="setFilter(target, $event)">
                  <mat-option value="linear">Linear</mat-option>
                  <mat-option value="nearest">Nearest</mat-option>
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Wrap</mat-label>
                <mat-select [value]="target.wrap" (valueChange)="setWrap(target, $event)">
                  <mat-option value="clamp">Clamp</mat-option>
                  <mat-option value="repeat">Repeat</mat-option>
                  <mat-option value="mirror">Mirror</mat-option>
                </mat-select>
              </mat-form-field>
            </div>
          </section>
        }

        @if (errors().length > 0) {
          <section class="errors" aria-live="polite">
            @for (error of errors(); track $index) {
              <p class="error">
                <mat-icon aria-hidden="true">error</mat-icon>
                <span>{{ error }}</span>
              </p>
            }
          </section>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      overflow-y: auto;
      background: var(--mat-sys-surface-container-low);
      border-left: 1px solid var(--mat-sys-outline-variant);
    }

    .panel {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 12px;
    }

    header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    header mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
      color: var(--mat-sys-primary);
    }

    h3 {
      flex: 1;
      margin: 0;
      font: var(--mat-sys-title-small);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .slot {
      flex: 0 0 auto;
      padding: 2px 7px;
      border-radius: 9px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-small);
    }

    section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    h4 {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .channel {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .feedback {
      margin-left: 2px;
      font: var(--mat-sys-body-small);
    }

    .pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .errors {
      padding-top: 4px;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .error {
      display: flex;
      gap: 6px;
      margin: 0;
      color: var(--mat-sys-error);
      font: var(--mat-sys-body-small);
    }

    .error mat-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
  `,
})
export class PassConfigPanel {
  private readonly store = inject(ShaderStore);

  /** The pass being configured — the open tab, when it is a pass. */
  readonly pass = input<RenderPass | null>(null);

  protected readonly channels = CHANNEL_INDICES;

  /** The wiring problems that belong to this pass: a dangling or circular binding. */
  protected readonly errors = computed(() => {
    const pass = this.pass();
    if (!pass) return [];

    return this.store
      .projectErrors()
      .filter((error) => error.passId === pass.id)
      .map((error) => error.message);
  });

  /**
   * Everything this channel could be pointed at.
   *
   * A buffer can name itself — that is what feedback is for, and leaving it out
   * of the list would make the single most common use of a buffer impossible to
   * express. What it cannot do is name itself *without* feedback, and that is
   * caught by the graph and reported, rather than being hidden here: a rule the
   * user can break and be told about beats a control that silently cannot.
   */
  protected options(pass: RenderPass): ChannelOption[] {
    const buffers = this.store.buffers();

    return [
      { key: 'none', label: 'Nothing', binding: { kind: 'none' }, group: 'none' as const },

      ...buffers.map((buffer) => ({
        key: `buffer:${buffer.id}`,
        label:
          buffer.id === pass.id
            ? `${buffer.name} (itself — needs feedback)`
            : buffer.enabled
              ? buffer.name
              : `${buffer.name} (disabled)`,
        binding: { kind: 'buffer' as const, passId: buffer.id, feedback: buffer.id === pass.id },
        group: 'buffer' as const,
      })),

      ...CHANNEL_INDICES.map((slot) => ({
        key: `texture:${slot}`,
        label: `Texture ${slot}${this.store.channels()[slot].ext ? '' : ' (empty)'}`,
        binding: { kind: 'texture' as const, slot },
        group: 'texture' as const,
      })),
    ];
  }

  protected optionKey(pass: RenderPass, channel: ChannelIndex): string {
    const binding = pass.channels[channel];
    switch (binding.kind) {
      case 'buffer':
        return `buffer:${binding.passId}`;
      case 'texture':
        return `texture:${binding.slot}`;
      default:
        return 'none';
    }
  }

  protected setChannel(pass: RenderPass, channel: ChannelIndex, key: string): void {
    const option = this.options(pass).find((entry) => entry.key === key);
    if (!option) return;

    // Keep the feedback flag when only the target changed, so re-pointing a
    // feedback channel at another buffer does not silently make it a dependency.
    const current = pass.channels[channel];
    const binding =
      option.binding.kind === 'buffer' && current.kind === 'buffer'
        ? { ...option.binding, feedback: current.feedback || option.binding.feedback }
        : option.binding;

    this.store.setChannel(pass.id, channel, binding);
  }

  protected isBuffer(pass: RenderPass, channel: ChannelIndex): boolean {
    return pass.channels[channel].kind === 'buffer';
  }

  protected hasFeedback(pass: RenderPass, channel: ChannelIndex): boolean {
    const binding = pass.channels[channel];
    return binding.kind === 'buffer' && binding.feedback;
  }

  protected feedbackHint(pass: RenderPass, channel: ChannelIndex): string {
    if (!this.isBuffer(pass, channel)) return 'Only a buffer has a previous frame to read';

    const binding = pass.channels[channel];
    const self = binding.kind === 'buffer' && binding.passId === pass.id;

    return self
      ? 'Read the frame this buffer drew last tick. Required when a buffer samples itself.'
      : 'Read the frame that buffer drew last tick, instead of this one — which also breaks a dependency loop.';
  }

  protected setFeedback(pass: RenderPass, channel: ChannelIndex, feedback: boolean): void {
    const binding = pass.channels[channel];
    if (binding.kind !== 'buffer') return;

    this.store.setChannel(pass.id, channel, { ...binding, feedback });
  }

  // --- Target -------------------------------------------------------------

  protected setMode(pass: RenderPass, mode: PassResolutionMode): void {
    this.store.setPassResolutionById(pass.id, { mode });
  }

  protected setScale(pass: RenderPass, event: Event): void {
    const scale = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(scale)) this.store.setPassResolutionById(pass.id, { scale });
  }

  protected setSize(pass: RenderPass, axis: 'width' | 'height', event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.store.setPassResolutionById(pass.id, { [axis]: value });
  }

  protected setFilter(pass: RenderPass, filter: TextureFilterMode): void {
    this.store.setPassSamplingById(pass.id, { filter });
  }

  protected setWrap(pass: RenderPass, wrap: TextureWrapMode): void {
    this.store.setPassSamplingById(pass.id, { wrap });
  }
}
