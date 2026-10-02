/**
 * Shadertoy Import — the Worker side.
 *
 * Runs in the isolated plugin Worker with no network: the host's
 * `shadertoy-api/v1` provider has already fetched the shader's JSON with the
 * user's key (which never reaches this code), and resolves the textures this
 * returns as requests. This only converts data to a project candidate.
 */
import {
  convertShadertoyPaste,
  convertShadertoySource,
} from '@shadergrove/shared/shadertoy-convert';
import type { ProjectImportInput } from '@shadergrove/shared/plugin';

shaderStudio.handle('projectImporter:shadertoy', (params) => {
  const input = params as ProjectImportInput;
  if (input?.mode === 'paste') {
    return convertShadertoyPaste(String(input.name ?? ''), String(input.text ?? ''));
  }
  if (input?.mode === 'provider' && input.provider === 'shadertoy-api/v1') {
    return convertShadertoySource(input.source, String(input.sourceId ?? ''));
  }
  throw new Error('Unsupported import input');
});
