/**
 * The named host adapters protocol-2 contributions run against.
 *
 * A `projectImporter` that says `provider: "shadertoy-api/v1"` or a
 * `projectExporter` that says `runtime: "wallpaper-web/v1"` selects *host*
 * code by name. That code is registered here, by the app — never by a
 * package — and only ids in `SOURCE_PROVIDER_IDS` / `EXPORT_RUNTIME_IDS`
 * resolve, so naming an adapter grants a plugin nothing it did not have: no
 * fetch, no file access, no credential. A manifest naming an id the app has
 * not registered simply has nothing to run.
 */
import { Injectable, InjectionToken, inject, type Provider, type Type } from '@angular/core';

import {
  isExportRuntimeId,
  isSourceProviderId,
  type ExportRuntimeId,
  type SourceProviderId,
} from '@shadergrove/shared/plugin';
import type { Result } from '@shadergrove/shared/validate';
import type { TranslationKey } from '../i18n/keys';

/** A field the host renders for a provider. Credentials stay in the host. */
export interface ProviderField {
  key: string;
  kind: 'text' | 'credential';
  /** i18n key of the label. */
  label: TranslationKey;
  /** i18n key of a hint under the field, if any. */
  hint?: TranslationKey;
  placeholder?: string;
  maxLength: number;
  /** A host preference that keeps the value between imports (never sent to a plugin). */
  remember?: 'shadertoyApiKey';
}

/** The bounded document a provider fetched, as it goes to the Worker. */
export interface ProviderSource {
  /** The canonical id of what was fetched, e.g. a Shadertoy shader id. */
  sourceId: string;
  source: unknown;
}

/**
 * Host code that retrieves source documents and their assets for one kind of
 * `projectImporter`. Every request it makes is its own: it validates ids,
 * origins, paths, redirects and sizes, and it refuses asset references outside
 * its allow-list, whatever a plugin's candidate asks for.
 */
export interface SourceProvider {
  readonly id: SourceProviderId;
  readonly fields: readonly ProviderField[];
  /** Fetch the source document for these form values. */
  fetchSource(
    values: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<ProviderSource>;
  /** Fetch one asset a candidate requested. Rejects a reference it does not allow. */
  fetchAsset(asset: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** A texture the host owns, handed to a runtime with its bytes. */
export interface RuntimeTexture {
  slot: number;
  ext: string;
  bytes: Uint8Array;
}

/** What a runtime assembled: relative paths it chose and their bytes. */
export interface RuntimeOutput {
  /** A safe folder/archive stem. */
  stem: string;
  files: { path: string; bytes: Uint8Array }[];
}

/**
 * Host code that turns a `projectExporter`'s validated data into files. It
 * owns every executable template and every path; the plugin's data is only
 * ever embedded as data.
 */
export interface ExportRuntime {
  readonly id: ExportRuntimeId;
  assemble(data: unknown, textures: readonly RuntimeTexture[]): Result<RuntimeOutput>;
}

export const SOURCE_PROVIDERS = new InjectionToken<SourceProvider[]>('SOURCE_PROVIDERS');
export const EXPORT_RUNTIMES = new InjectionToken<ExportRuntime[]>('EXPORT_RUNTIMES');

/** Register host adapter implementations in the app's providers. */
export function provideHostAdapters(adapters: {
  sourceProviders?: Type<SourceProvider>[];
  exportRuntimes?: Type<ExportRuntime>[];
}): Provider[] {
  return [
    ...(adapters.sourceProviders ?? []).map(
      (useClass): Provider => ({ provide: SOURCE_PROVIDERS, useClass, multi: true }),
    ),
    ...(adapters.exportRuntimes ?? []).map(
      (useClass): Provider => ({ provide: EXPORT_RUNTIMES, useClass, multi: true }),
    ),
  ];
}

@Injectable({ providedIn: 'root' })
export class HostAdapters {
  private readonly providers = inject(SOURCE_PROVIDERS, { optional: true }) ?? [];
  private readonly runtimes = inject(EXPORT_RUNTIMES, { optional: true }) ?? [];

  /** The registered provider for a supported id, or `null`. */
  provider(id: unknown): SourceProvider | null {
    if (!isSourceProviderId(id)) return null;
    return this.providers.find((provider) => provider.id === id) ?? null;
  }

  /** The registered runtime for a supported id, or `null`. */
  runtime(id: unknown): ExportRuntime | null {
    if (!isExportRuntimeId(id)) return null;
    return this.runtimes.find((runtime) => runtime.id === id) ?? null;
  }
}
