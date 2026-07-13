/**
 * Wire protocol between the MCP server (`mcp/server.ts`) and the browser tab
 * it drives (`app/core/mcp-bridge.ts`).
 *
 * The MCP server is the WebSocket server; the browser is the client. A single
 * `hello` announces which side just connected, then every exchange is a
 * request/response pair correlated by `id`, `AppResponse` being the only
 * thing ever sent back.
 *
 * `CommandPayloads` and `ControllerResultMap` are the two sources of truth —
 * the request union and every handler's signature (browser and server side)
 * are derived from them instead of being declared by hand.
 */

import type {
  ParamValue,
  Preset,
  RenderSettings,
  ShaderControl,
  ShaderParams,
  ShaderRecord,
  ShaderSummary,
} from './model';

export interface McpDiagnostic {
  severity: 'error' | 'warning';
  line: number;
  message: string;
  source: 'fragment' | 'vertex' | 'config';
}

/** Everything worth knowing about the session currently open in the browser. */
export interface McpStateSnapshot {
  selectedId: string | null;
  shaders: readonly ShaderSummary[];
  record: ShaderRecord | null;
  draft: {
    fragment: string;
    vertex: string;
    controlsText: string;
    render: RenderSettings;
  } | null;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  presets: readonly Preset[];
  activePresetId: string | null;
  dirty: boolean;
  hasErrors: boolean;
  diagnostics: readonly McpDiagnostic[];
}

export interface McpScreenshot {
  base64: string;
  mimeType: 'image/png';
}

type NoPayload = Record<string, never>;

/** One entry per command: its request payload and its result, side by side. */
interface CommandSpecs {
  listShaders: { payload: NoPayload; result: readonly ShaderSummary[] };
  selectShader: { payload: { shaderId: string }; result: McpStateSnapshot };
  getState: { payload: NoPayload; result: McpStateSnapshot };
  setFragment: { payload: { code: string }; result: readonly McpDiagnostic[] };
  setVertex: { payload: { code: string }; result: readonly McpDiagnostic[] };
  setControls: { payload: { text: string }; result: readonly McpDiagnostic[] };
  setParam: { payload: { key: string; value: ParamValue }; result: ShaderParams };
  resetParams: { payload: NoPayload; result: ShaderParams };
  listPresets: { payload: NoPayload; result: readonly Preset[] };
  applyPreset: { payload: { presetId: string }; result: McpStateSnapshot };
  savePreset: { payload: { name: string; withRender?: boolean }; result: readonly Preset[] };
  deletePreset: { payload: { presetId: string }; result: readonly Preset[] };
  save: { payload: NoPayload; result: McpStateSnapshot };
  revert: { payload: NoPayload; result: McpStateSnapshot };
  screenshot: { payload: NoPayload; result: McpScreenshot };
  getDiagnostics: { payload: NoPayload; result: readonly McpDiagnostic[] };
}

export type ControllerCommandType = keyof CommandSpecs;

/** The result a command resolves to, looked up by its `type`. */
export type ControllerResultMap = { [K in ControllerCommandType]: CommandSpecs[K]['result'] };

/** The discriminated union of every command, derived from `CommandSpecs`. */
export type ControllerCommand = {
  [K in ControllerCommandType]: { type: K } & CommandSpecs[K]['payload'];
}[ControllerCommandType];

export type ControllerRequest = { id: string } & ControllerCommand;

export type AppResponse<T extends ControllerCommandType = ControllerCommandType> =
  | { id: string; ok: true; result: ControllerResultMap[T] }
  | { id: string; ok: false; error: string };

export interface HelloMessage {
  hello: 'app' | 'controller';
}

export function isHelloMessage(value: unknown): value is HelloMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hello' in value &&
    (value.hello === 'app' || value.hello === 'controller')
  );
}
