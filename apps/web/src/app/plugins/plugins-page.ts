import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';

import type { CustomEffect, ShaderControl, ShaderParams } from '@shadergrove/shared/model';
import {
  PLUGIN_LIMITS,
  effectContributionCandidate,
  validateEffectCandidate,
  type EffectContribution,
  type ExporterContribution,
  type ImporterContribution,
  type PluginContribution,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';
import { defaultParams } from '@shadergrove/shared/validate';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import { PAGE_STYLES } from '../publications/page';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption, type AdoptionResult } from './effect-adoption';
import {
  PluginInstallations,
  type InstalledPlugin,
  type PluginReview,
} from './plugin-installations';

type Message = { text: string; error: boolean };

/**
 * `/plugins`: the locally installed plugins, laid over the editor like
 * Explore so the open shader — the one effects are added to — stays where it is.
 *
 * Everything shown is built by the host from a package's manifest: its
 * identity, what it contributes, and for each importer or exporter a form made
 * from the simple controls it declares. A plugin never draws here, picks a
 * file, or writes one; the host does all three and keeps what comes back only
 * once it has validated — and for effects, compiled — it.
 */
@Component({
  selector: 'app-plugins-page',
  imports: [
    FormsModule,
    NgTemplateOutlet,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    RouterLink,
    TranslatePipe,
  ],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/">
        <mat-icon>arrow_back</mat-icon>
        {{ 'plugins.backToEditor' | translate }}
      </a>
      <h1>{{ 'plugins.title' | translate }}</h1>
    </header>

    <main [attr.aria-busy]="installations.loading()">
      <section class="install" [attr.aria-label]="'plugins.installFromFile' | translate">
        <button
          matButton="tonal"
          type="button"
          data-testid="plugin-pick"
          (click)="packageInput.click()"
        >
          <mat-icon>upload_file</mat-icon>
          {{ 'plugins.installFromFile' | translate }}
        </button>
        <input
          #packageInput
          hidden
          type="file"
          accept=".sgplugin.json,.json,application/json"
          data-testid="plugin-file"
          (change)="pickPackage(packageInput)"
        />
        <p class="hint">{{ 'plugins.installHint' | translate }}</p>

        @if (review(); as current) {
          <div
            class="review"
            data-testid="plugin-review"
            role="region"
            [attr.aria-label]="'plugins.review' | translate"
          >
            @if (current.ok) {
              @let manifest = current.plugin.manifest;
              <h2>
                {{ manifest.name }} <span class="muted">{{ manifest.id }}</span>
              </h2>
              <p>
                {{ 'plugins.version' | translate: { version: manifest.version } }} ·
                {{ 'plugins.by' | translate: { publisher: manifest.publisher } }} ·
                {{ 'plugins.license' | translate: { license: manifest.license } }}
              </p>
              <p class="warning">{{ 'plugins.unsigned' | translate }}</p>
              @if (current.replaces) {
                <p>{{ 'plugins.replaces' | translate: { version: current.replaces } }}</p>
              }
              <ul class="contributions">
                @for (contribution of manifest.contributions; track contribution.id) {
                  <li>
                    <strong>{{ kindLabel(contribution) }}</strong> — {{ contribution.name }}
                    <span class="muted">{{ detail(contribution) }}</span>
                  </li>
                }
              </ul>
              <p class="muted">{{ limits() }}</p>
              @if (!current.compatible) {
                <p class="error" role="alert">
                  {{
                    'plugins.incompatible'
                      | translate: { range: manifest.appVersionRange, version: appVersion }
                  }}
                </p>
              }
              <div class="actions">
                <button matButton type="button" (click)="review.set(null)">
                  {{ 'plugins.cancel' | translate }}
                </button>
                <button
                  matButton="filled"
                  type="button"
                  data-testid="plugin-install"
                  [disabled]="!current.compatible || busy() !== null"
                  (click)="install(current)"
                >
                  {{ 'plugins.install' | translate }}
                </button>
              </div>
            } @else {
              <p class="error" role="alert">{{ 'plugins.invalidPackage' | translate }}</p>
              <ul class="error">
                @for (error of current.errors; track $index) {
                  <li>{{ error }}</li>
                }
              </ul>
              <div class="actions">
                <button matButton type="button" (click)="review.set(null)">
                  {{ 'plugins.cancel' | translate }}
                </button>
              </div>
            }
          </div>
        }
      </section>

      @if (message(); as current) {
        <p class="message" [class.error]="current.error" role="status" data-testid="plugin-message">
          {{ current.text }}
        </p>
      }

      <h2 class="section">{{ 'plugins.installed' | translate }}</h2>
      @if (installations.plugins().length === 0 && !installations.loading()) {
        <p class="status">{{ 'plugins.empty' | translate }}</p>
      }

      @for (installed of installations.plugins(); track installed.id) {
        <article
          class="plugin"
          [attr.data-testid]="'plugin-' + installed.id"
          [attr.aria-label]="title(installed)"
        >
          <header>
            <div class="identity">
              <h3>{{ title(installed) }}</h3>
              @if (installed.plugin; as plugin) {
                <p class="muted">
                  {{ plugin.manifest.id }} ·
                  {{ 'plugins.version' | translate: { version: plugin.manifest.version } }} ·
                  {{ 'plugins.by' | translate: { publisher: plugin.manifest.publisher } }} ·
                  {{ 'plugins.license' | translate: { license: plugin.manifest.license } }}
                </p>
              }
              @if (installed.problem) {
                <p class="error" role="alert">{{ installed.problem }}</p>
              }
            </div>
            <mat-slide-toggle
              [attr.data-testid]="'plugin-enable-' + installed.id"
              [attr.aria-label]="'plugins.enable' | translate: { name: title(installed) }"
              [disabled]="installed.problem !== null"
              [ngModel]="installed.active"
              (ngModelChange)="setEnabled(installed, $event)"
            />
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'plugin-remove-' + installed.id"
              [attr.aria-label]="'plugins.remove' | translate: { name: title(installed) }"
              (click)="remove(installed)"
            >
              <mat-icon>delete</mat-icon>
            </button>
          </header>

          @if (installed.plugin; as plugin) {
            <ul class="contributions">
              @for (contribution of plugin.manifest.contributions; track contribution.id) {
                @let key = installed.id + '/' + contribution.id;
                <li class="contribution" [attr.data-testid]="'contribution-' + key">
                  <div>
                    <strong>{{ kindLabel(contribution) }}</strong> — {{ contribution.name }}
                    <span class="muted">{{ detail(contribution) }}</span>
                  </div>
                  @if (!installed.active) {
                    <p class="muted">{{ 'plugins.enableToUse' | translate }}</p>
                  } @else {
                    @switch (contribution.kind) {
                      @case ('effect') {
                        <button
                          matButton="tonal"
                          type="button"
                          [attr.data-testid]="'add-' + key"
                          [disabled]="busy() !== null"
                          (click)="addEffect(installed, asEffect(contribution))"
                        >
                          {{ 'plugins.addToShader' | translate }}
                        </button>
                      }
                      @case ('importer') {
                        @let importer = asImporter(contribution);
                        <ng-container
                          [ngTemplateOutlet]="paramsForm"
                          [ngTemplateOutletContext]="{ key, controls: importer.params }"
                        />
                        <button
                          matButton="tonal"
                          type="button"
                          [attr.data-testid]="'import-' + key"
                          [disabled]="busy() !== null"
                          (click)="importInput.click()"
                        >
                          {{ 'plugins.chooseFile' | translate }}
                        </button>
                        <input
                          #importInput
                          hidden
                          type="file"
                          [attr.data-testid]="'import-file-' + key"
                          [accept]="accept(importer)"
                          (change)="runImporter(installed, importer, importInput)"
                        />
                      }
                      @case ('exporter') {
                        @let exporter = asExporter(contribution);
                        @if (customEffects().length === 0) {
                          <p class="muted">{{ 'plugins.noCustomEffects' | translate }}</p>
                        } @else {
                          <label class="field">
                            <span>{{ 'plugins.exportEffect' | translate }}</span>
                            <select
                              [attr.data-testid]="'export-effect-' + key"
                              [ngModel]="chosenEffect(key)"
                              (ngModelChange)="chooseEffect(key, $event)"
                            >
                              @for (effect of customEffects(); track effect.instanceId) {
                                <option [value]="effect.instanceId">
                                  {{ effect.definition.name }}
                                </option>
                              }
                            </select>
                          </label>
                          <ng-container
                            [ngTemplateOutlet]="paramsForm"
                            [ngTemplateOutletContext]="{ key, controls: exporter.params }"
                          />
                          <button
                            matButton="tonal"
                            type="button"
                            [attr.data-testid]="'export-' + key"
                            [disabled]="busy() !== null"
                            (click)="runExporter(installed, exporter, key)"
                          >
                            {{ 'plugins.export' | translate }}
                          </button>
                        }
                      }
                    }
                  }
                </li>
              }
            </ul>
          }
        </article>
      }
    </main>

    <!-- A form built from the simple controls a contribution declares; values kept per contribution. -->
    <ng-template #paramsForm let-key="key" let-controls="controls">
      @for (control of asControls(controls); track control.key) {
        <label class="field">
          <span>{{ control.label ?? control.key }}</span>
          @switch (control.type) {
            @case ('number') {
              <input
                type="number"
                [min]="control.min"
                [max]="control.max"
                [step]="control.step ?? 'any'"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, +$event)"
              />
            }
            @case ('boolean') {
              <input
                type="checkbox"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, $event)"
              />
            }
            @case ('color') {
              <input
                type="color"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, $event)"
              />
            }
            @case ('select') {
              <select
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, +$event)"
              >
                @for (option of optionsOf(control); track option[0]) {
                  <option [ngValue]="option[1]">{{ option[0] }}</option>
                }
              </select>
            }
          }
        </label>
      }
    </ng-template>
  `,
  styles: `
    ${PAGE_STYLES}

    .install,
    .plugin {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium, 12px);
    }

    .install {
      align-items: flex-start;
    }

    .review {
      align-self: stretch;
      padding: 12px 16px;
      border-radius: var(--mat-sys-corner-small, 8px);
      background: var(--mat-sys-surface-container);
    }

    .review h2,
    .plugin h3 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }

    .plugin > header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .identity {
      flex: 1;
      min-width: 0;
    }

    .identity p,
    .review p,
    .hint {
      margin: 4px 0;
    }

    .section {
      margin: 24px 0 12px;
      font: var(--mat-sys-title-large);
    }

    .contributions {
      margin: 8px 0 0;
      padding-left: 18px;
    }

    .contribution {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      padding: 6px 0;
    }

    .field {
      display: flex;
      align-items: center;
      gap: 8px;
      font: var(--mat-sys-body-medium);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .muted,
    .hint {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .warning {
      color: var(--mat-sys-tertiary);
    }

    .error {
      color: var(--mat-sys-error);
    }

    .message {
      margin: 0 0 16px;
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class PluginsPage {
  protected readonly installations = inject(PluginInstallations);
  private readonly adoption = inject(EffectAdoption);
  private readonly store = inject(ShaderStore);
  private readonly desktop = inject(DesktopPlatform);
  private readonly i18n = inject(I18n);

  protected readonly appVersion = APP_VERSION;
  protected readonly review = signal<PluginReview | null>(null);
  protected readonly message = signal<Message | null>(null);
  /** The action under way, if any: one plugin call at a time. */
  protected readonly busy = signal<string | null>(null);

  private readonly params = signal<Record<string, ShaderParams>>({});
  private readonly chosen = signal<Record<string, string>>({});

  /** The open shader's custom effects — what an exporter can be pointed at. */
  protected readonly customEffects = computed(() =>
    (this.store.draft()?.render.postProcessing.effects ?? []).filter(
      (effect): effect is CustomEffect => effect.type === 'custom',
    ),
  );

  protected readonly limits = computed(() =>
    this.i18n.t('plugins.limits', {
      input: PLUGIN_LIMITS.fileBytes,
      output: PLUGIN_LIMITS.callOutputBytes,
      seconds: PLUGIN_LIMITS.callTimeoutMs / 1000,
    }),
  );

  // --- Installing -----------------------------------------------------------

  protected async pickPackage(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.message.set(null);
    if (file.size > PLUGIN_LIMITS.packageBytes) {
      this.review.set({
        ok: false,
        errors: [this.i18n.t('plugins.tooLarge', { max: PLUGIN_LIMITS.packageBytes })],
      });
      return;
    }
    this.review.set(this.installations.review(new Uint8Array(await file.arrayBuffer())));
  }

  protected async install(review: Extract<PluginReview, { ok: true }>): Promise<void> {
    await this.run('install', async () => {
      await this.installations.install(review);
      this.review.set(null);
      this.say('plugins.installedNotice', { name: review.plugin.manifest.name });
    });
  }

  protected async setEnabled(installed: InstalledPlugin, enabled: boolean): Promise<void> {
    await this.run('enable', () => this.installations.setEnabled(installed.id, enabled));
  }

  protected async remove(installed: InstalledPlugin): Promise<void> {
    await this.run('remove', async () => {
      await this.installations.remove(installed.id);
      this.say('plugins.removed', { name: this.title(installed) });
    });
  }

  // --- Using ----------------------------------------------------------------

  protected addEffect(installed: InstalledPlugin, contribution: EffectContribution): void {
    if (!installed.plugin) return;
    this.report(
      this.adoption.adopt(effectContributionCandidate(installed.plugin, contribution)),
      contribution.name,
    );
  }

  protected async runImporter(
    installed: InstalledPlugin,
    importer: ImporterContribution,
    input: HTMLInputElement,
  ): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // The picker's filter is a convenience; what counts is the name or type the host checks here —
    // and then the content, which the plugin parses and the host revalidates.
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!importer.extensions.includes(extension) && !importer.mime.includes(file.type)) {
      this.say('plugins.fileRefused', {}, true);
      return;
    }
    if (file.size > Math.min(importer.maxInputBytes, PLUGIN_LIMITS.fileBytes)) {
      this.say('plugins.fileTooLarge', {}, true);
      return;
    }
    const host = this.installations.host(installed.id);
    if (!host) return;
    const key = `${installed.id}/${importer.id}`;
    // The call is asynchronous: its result belongs to the profile, shader and plugin it started with.
    const profile = this.installations.profile();
    const shader = this.store.selectedId();
    await this.run(key, async () => {
      const result = await host.importFile(
        importer.id,
        await file.arrayBuffer(),
        this.valuesFor(key, importer.params),
      );
      if (
        this.installations.profile() !== profile ||
        this.store.selectedId() !== shader ||
        !this.installations.find(installed.id)?.active
      ) {
        this.say('plugins.contextChanged', {}, true);
        return;
      }
      const candidate = validateEffectCandidate(result.candidate);
      if (!candidate.ok) {
        this.say('plugins.failed', { message: candidate.errors[0] ?? '' }, true);
        return;
      }
      this.report(this.adoption.adopt(candidate.value), candidate.value.name);
    });
  }

  protected async runExporter(
    installed: InstalledPlugin,
    exporter: ExporterContribution,
    key: string,
  ): Promise<void> {
    const effect = this.customEffects().find((item) => item.instanceId === this.chosenEffect(key));
    const host = this.installations.host(installed.id);
    if (!effect || !host) return;
    await this.run(key, async () => {
      const { name, source, controls } = effect.definition;
      const result = await host.exportEffect(
        exporter.id,
        { name, source, controls, values: effect.values },
        this.valuesFor(key, exporter.params),
      );
      // The plugin only suggests a name. The extension is the one its manifest declared.
      const stem = result.fileName.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-') || 'effect';
      const filename = `${stem}${exporter.extension}`;
      const bytes = new Uint8Array(result.bytes);
      if (this.desktop.available) {
        if (!(await this.desktop.saveExport(filename, bytes, exporter.extension))) return;
      } else {
        download(new Blob([bytes], { type: result.mime }), filename);
      }
      this.say('plugins.exported', { name: filename });
    });
  }

  // --- Template helpers -------------------------------------------------------

  protected title(installed: InstalledPlugin): string {
    return installed.plugin?.manifest.name ?? installed.id;
  }

  protected kindLabel(contribution: PluginContribution): string {
    return this.i18n.t(
      contribution.kind === 'effect'
        ? 'plugins.kindEffect'
        : contribution.kind === 'importer'
          ? 'plugins.kindImporter'
          : 'plugins.kindExporter',
    );
  }

  protected detail(contribution: PluginContribution): string {
    switch (contribution.kind) {
      case 'effect':
        return this.i18n.t('plugins.controls', { count: contribution.controls.length });
      case 'importer':
        return this.i18n.t('plugins.accepts', {
          formats: [...contribution.extensions, ...contribution.mime].join(', '),
        });
      case 'exporter':
        return this.i18n.t('plugins.produces', {
          mime: contribution.mime,
          extension: contribution.extension,
        });
    }
  }

  protected accept(importer: ImporterContribution): string {
    return [...importer.extensions, ...importer.mime].join(',');
  }

  protected asEffect = (contribution: PluginContribution) => contribution as EffectContribution;
  protected asImporter = (contribution: PluginContribution) => contribution as ImporterContribution;
  protected asExporter = (contribution: PluginContribution) => contribution as ExporterContribution;
  protected asControls = (controls: unknown) => controls as ShaderControl[];

  protected optionsOf(control: ShaderControl): [string, number][] {
    return control.type === 'select' ? Object.entries(control.options) : [];
  }

  protected param(key: string, controls: ShaderControl[], name: string): unknown {
    return this.valuesFor(key, controls)[name];
  }

  protected setParam(key: string, controls: ShaderControl[], name: string, value: unknown): void {
    this.params.update((all) => ({
      ...all,
      [key]: { ...this.valuesFor(key, controls), [name]: value as ShaderParams[string] },
    }));
  }

  protected chosenEffect(key: string): string | undefined {
    return this.chosen()[key] ?? this.customEffects()[0]?.instanceId;
  }

  protected chooseEffect(key: string, instanceId: string): void {
    this.chosen.update((all) => ({ ...all, [key]: instanceId }));
  }

  private valuesFor(key: string, controls: ShaderControl[]): ShaderParams {
    return this.params()[key] ?? defaultParams(controls);
  }

  private report(result: AdoptionResult, name: string): void {
    if (result.ok) {
      this.say('plugins.added', { name });
      return;
    }
    switch (result.reason) {
      case 'no-shader':
        this.say('plugins.noShader', {}, true);
        return;
      case 'chain-full':
        this.say('plugins.chainFull', {}, true);
        return;
      case 'no-renderer':
        this.say('plugins.noRenderer', {}, true);
        return;
      case 'compile': {
        const first = result.diagnostics[0];
        const message = first
          ? first.line > 0
            ? `${first.line}: ${first.message}`
            : first.message
          : '';
        this.say('plugins.compileFailed', { message }, true);
        return;
      }
    }
  }

  private async run(key: string, action: () => Promise<void>): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(key);
    this.message.set(null);
    try {
      await action();
    } catch (error) {
      this.say(
        'plugins.failed',
        { message: error instanceof Error ? error.message : String(error) },
        true,
      );
    } finally {
      this.busy.set(null);
    }
  }

  private say(
    key: Parameters<I18n['t']>[0],
    params: Record<string, string | number> = {},
    error = false,
  ): void {
    this.message.set({ text: this.i18n.t(key, params), error });
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
