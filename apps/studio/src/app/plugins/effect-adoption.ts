import { Injectable, inject } from '@angular/core';

import {
  addPostProcessingEffect,
  canAddPostProcessingEffect,
  createCustomEffect,
} from '@shadergrove/shared/model';
import type { EffectCandidate } from '@shadergrove/shared/plugin';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { RendererHandle } from '../rendering/renderer-handle';
import { ShaderStore } from '../workspace/shader-store';

export type AdoptionResult =
  | { ok: true }
  | { ok: false; reason: 'no-shader' | 'chain-full' | 'no-renderer' }
  | { ok: false; reason: 'compile'; diagnostics: CompileDiagnostic[] };

/**
 * Puts an effect a plugin offered into the open shader — an `effect`
 * contribution, or an importer's candidate the caller has already validated.
 *
 * Nothing is adopted the driver has not compiled first: the candidate is
 * probed off screen, and only then copied, whole, into the draft's chain. The
 * copy is the shader's from then on; the plugin can be updated or removed
 * without touching it.
 */
@Injectable({ providedIn: 'root' })
export class EffectAdoption {
  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);

  adopt(candidate: EffectCandidate): AdoptionResult {
    const render = this.store.draft()?.render;
    if (!render) return { ok: false, reason: 'no-shader' };
    if (!canAddPostProcessingEffect(render)) return { ok: false, reason: 'chain-full' };
    const engine = this.renderer.engine();
    if (!engine) return { ok: false, reason: 'no-renderer' };

    const effect = createCustomEffect({
      instanceId: 'candidate',
      enabled: true,
      name: candidate.name,
      source: candidate.source,
      controls: candidate.controls,
      values: candidate.values,
    });
    const diagnostics = engine
      .probeCustomEffect(effect)
      .filter((diagnostic) => diagnostic.severity === 'error');
    if (diagnostics.length > 0) return { ok: false, reason: 'compile', diagnostics };

    // `addPostProcessingEffect` gives the copy an id of its own in this chain.
    this.store.setRender(addPostProcessingEffect(render, effect));
    return { ok: true };
  }
}
