import type { ShaderControl } from '@shadergrove/shared/model';

/** The control schema, formatted the way the config tab edits it. */
export function controlsToText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}
