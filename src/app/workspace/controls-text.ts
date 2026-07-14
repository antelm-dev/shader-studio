import type { ShaderControl } from '@shader-studio/shared/model';

/** The control schema, formatted the way the config tab edits it. */
export function controlsToText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}
