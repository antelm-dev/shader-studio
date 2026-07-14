/**
 * The domain operations an MCP tool actually needs, named for what they do
 * rather than for the wire command that happens to carry them.
 *
 * This is the seam goal 7 asks for: `mcp/server.ts` registers tools against
 * this interface, `mcp/controller.ts` implements it over the WebSocket bridge,
 * and nothing in between (tool registration, transport, Angular state,
 * rendering) has to know about the others. A future transport — Electron IPC,
 * an in-process controller for tests — only has to implement this interface,
 * not touch `server.ts`.
 *
 * Pure TypeScript: no `zod`, no `ws`, no Angular. Just the shared model types.
 */

import type {
  CompileResult,
  DocumentSnapshot,
  McpScreenshot,
  McpStateSnapshot,
  PatchResult,
  ProjectSnapshot,
  RenderFrameResult,
  SetParamsResult,
  TextEdit,
} from './protocol';
import type { ParamValue, Preset, ShaderSummary } from '../model';
export interface RenderFrameOptions {
  shaderId?: string;
  time?: number;
  width?: number;
  height?: number;
  params?: Record<string, ParamValue>;
}

export interface ShaderStudioController {
  listShaders(): Promise<readonly ShaderSummary[]>;
  selectShader(shaderId: string): Promise<McpStateSnapshot>;
  getState(): Promise<McpStateSnapshot>;

  // --- Project-aware operations ---------------------------------------------

  getProject(shaderId?: string): Promise<ProjectSnapshot>;
  getDocument(documentId: string, shaderId?: string): Promise<DocumentSnapshot>;
  applyPatch(
    shaderId: string,
    baseRevision: number,
    edits: readonly TextEdit[],
  ): Promise<PatchResult>;
  setParams(params: Record<string, ParamValue>, shaderId?: string): Promise<SetParamsResult>;
  compileProject(shaderId?: string): Promise<CompileResult>;
  renderFrame(options: RenderFrameOptions): Promise<RenderFrameResult>;
  saveProject(): Promise<McpStateSnapshot>;

  // --- Compatibility operations ----------------------------------------------

  setFragment(code: string): Promise<McpStateSnapshot['diagnostics']>;
  setVertex(code: string): Promise<McpStateSnapshot['diagnostics']>;
  setControls(text: string): Promise<McpStateSnapshot['diagnostics']>;
  setParam(key: string, value: ParamValue): Promise<Record<string, ParamValue>>;
  resetParams(): Promise<Record<string, ParamValue>>;
  revert(): Promise<McpStateSnapshot>;
  getDiagnostics(): Promise<McpStateSnapshot['diagnostics']>;
  screenshot(): Promise<McpScreenshot>;

  listPresets(): Promise<readonly Preset[]>;
  applyPreset(presetId: string): Promise<McpStateSnapshot>;
  savePreset(name: string, withRender?: boolean): Promise<readonly Preset[]>;
  deletePreset(presetId: string): Promise<readonly Preset[]>;
}
