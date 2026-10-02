import { Injectable, inject } from '@angular/core';

import { PROJECT_LIMITS } from '@shadergrove/shared/plugin';
import { isShadertoyAssetPath, parseShadertoyId } from '@shadergrove/shared/shadertoy-api';
import { ShaderApi } from '../../api/shader-api';
import type { ProviderSource, SourceProvider } from '../host-adapters';

/**
 * The `shadertoy-api/v1` source provider: the host half of the installed
 * Shadertoy plugin.
 *
 * It renders an id/URL field and an API-key field (the key is a credential:
 * remembered in the host's own preferences, sent once to the server or main
 * process to fetch the document, and never to the plugin). Retrieval itself —
 * origin, path, redirects, size and time bounds — runs where the app already
 * fetched Shadertoy: the web server or the desktop main process.
 */
@Injectable()
export class ShadertoyApiProvider implements SourceProvider {
  private readonly api = inject(ShaderApi);

  readonly id = 'shadertoy-api/v1' as const;
  readonly fields = [
    {
      key: 'idOrUrl',
      kind: 'text',
      label: 'shadertoy.idOrUrl',
      placeholder: 'https://www.shadertoy.com/view/XsBSRR',
      maxLength: 256,
    },
    {
      key: 'apiKey',
      kind: 'credential',
      label: 'shadertoy.apiKey',
      hint: 'shadertoy.apiKeyHint',
      maxLength: 128,
    },
  ] as const;

  async fetchSource(
    values: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<ProviderSource> {
    // Checked here too, so a bad id never leaves the page.
    const id = parseShadertoyId(values['idOrUrl'] ?? '');
    const apiKey = (values['apiKey'] ?? '').trim();
    if (!apiKey) throw new Error('A Shadertoy API key is required.');
    const result = await this.api.fetchShadertoySource(id, apiKey, signal);
    signal.throwIfAborted();
    if (result?.sourceId !== id) throw new Error('Unexpected response from Shadertoy.');
    if (JSON.stringify(result.source ?? null).length > PROJECT_LIMITS.sourceBytes) {
      throw new Error('The Shadertoy response is too large.');
    }
    return { sourceId: id, source: result.source };
  }

  async fetchAsset(asset: string, signal: AbortSignal): Promise<Uint8Array> {
    if (!isShadertoyAssetPath(asset)) throw new Error('not a Shadertoy texture path');
    const bytes = await this.api.fetchShadertoyAsset(asset, signal);
    signal.throwIfAborted();
    return bytes;
  }
}
