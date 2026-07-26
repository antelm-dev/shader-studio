import type { RenderFrameOptions, ShaderStudioController } from '@shader-studio/shared/controller';
import type { ParamValue } from '@shader-studio/shared/model';
import type { TextEdit } from '@shader-studio/shared/mcp-protocol';

import { callApp, SCREENSHOT_TIMEOUT_MS } from './bridge.js';

/**
 * The `ShaderStudioController` implementation `server.ts` actually uses: a
 * thin, typed façade over `callApp`. Every method here is one WebSocket round
 * trip — the interface is what lets tool handlers be written against domain
 * operations instead of `{ type, ...payload }` objects.
 */
export class BridgeController implements ShaderStudioController {
  listShaders() {
    return callApp({ type: 'listShaders' });
  }

  selectShader(shaderId: string) {
    return callApp({ type: 'selectShader', shaderId });
  }

  getState() {
    return callApp({ type: 'getState' });
  }

  // --- Project-aware operations ---------------------------------------------

  getProject(shaderId?: string) {
    return callApp({ type: 'getProject', shaderId });
  }

  getDocument(documentId: string, shaderId?: string) {
    return callApp({ type: 'getDocument', documentId, shaderId });
  }

  applyPatch(shaderId: string, baseRevision: number, edits: readonly TextEdit[]) {
    return callApp({ type: 'applyShaderPatch', shaderId, baseRevision, edits: [...edits] });
  }

  setParams(params: Record<string, ParamValue>, shaderId?: string) {
    return callApp({ type: 'setParams', params, shaderId });
  }

  compileProject(shaderId?: string) {
    return callApp({ type: 'compileProject', shaderId });
  }

  renderFrame(options: RenderFrameOptions) {
    return callApp({ type: 'renderFrame', ...options }, SCREENSHOT_TIMEOUT_MS);
  }

  saveProject() {
    return callApp({ type: 'save' });
  }

  // --- Compatibility operations ----------------------------------------------

  setFragment(code: string) {
    return callApp({ type: 'setFragment', code });
  }

  setVertex(code: string) {
    return callApp({ type: 'setVertex', code });
  }

  setControls(text: string) {
    return callApp({ type: 'setControls', text });
  }

  setParam(key: string, value: ParamValue) {
    return callApp({ type: 'setParam', key, value });
  }

  resetParams() {
    return callApp({ type: 'resetParams' });
  }

  revert() {
    return callApp({ type: 'revert' });
  }

  getDiagnostics() {
    return callApp({ type: 'getDiagnostics' });
  }

  screenshot() {
    return callApp({ type: 'screenshot' }, SCREENSHOT_TIMEOUT_MS);
  }

  listPresets() {
    return callApp({ type: 'listPresets' });
  }

  applyPreset(presetId: string) {
    return callApp({ type: 'applyPreset', presetId });
  }

  savePreset(name: string, withRender?: boolean) {
    return callApp({ type: 'savePreset', name, withRender });
  }

  deletePreset(presetId: string) {
    return callApp({ type: 'deletePreset', presetId });
  }
}
