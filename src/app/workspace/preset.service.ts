import { Injectable, inject } from '@angular/core';

import type {
  Preset,
  RenderSettings,
  ShaderControl,
  ShaderParams,
} from '@shader-studio/shared/model';
import { sanitizeParams } from '@shader-studio/shared/validate';
import { ShaderApi } from '../api/shader-api';

export interface PresetApplyPlan {
  params: ShaderParams;
  render: RenderSettings | null;
  presetId: string;
}

/**
 * The preset half of `ShaderStore`: applying a preset's values onto the
 * current control schema, and the API calls that save or delete one.
 * `ShaderStore` still owns writing the result back to its own signals,
 * refreshing the list, and surfacing the notice.
 */
@Injectable({ providedIn: 'root' })
export class PresetService {
  private readonly api = inject(ShaderApi);

  /**
   * Projects a preset's values onto the *current* schema, so a preset stored
   * against an older set of controls still applies cleanly — anything it does
   * not mention falls back to that control's default. Returns `null` if the
   * preset no longer exists.
   */
  planApply(
    presets: readonly Preset[],
    controls: readonly ShaderControl[],
    presetId: string,
  ): PresetApplyPlan | null {
    const preset = presets.find((entry) => entry.id === presetId);
    if (!preset) return null;

    return {
      params: sanitizeParams(controls, preset.values),
      render: preset.render ? structuredClone(preset.render) : null,
      presetId: preset.id,
    };
  }

  /**
   * Capture the live params under a name. `render` also stores the render
   * settings currently in the draft, which is what makes a preset able to
   * bring its own bloom back with it.
   */
  async save(
    recordId: string,
    name: string,
    values: ShaderParams,
    render: RenderSettings | undefined,
    existing: readonly Preset[],
  ): Promise<{ preset: Preset; presets: Preset[] }> {
    const preset = await this.api.savePreset(recordId, name, values, render);
    const presets = existing.some((entry) => entry.id === preset.id)
      ? existing.map((entry) => (entry.id === preset.id ? preset : entry))
      : [...existing, preset];
    return { preset, presets };
  }

  async delete(recordId: string, presetId: string, existing: readonly Preset[]): Promise<Preset[]> {
    await this.api.deletePreset(recordId, presetId);
    return existing.filter((preset) => preset.id !== presetId);
  }
}
