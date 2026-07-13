import { Injectable, inject } from '@angular/core';

import type {
  AppResponse,
  ControllerRequest,
  McpDiagnostic,
  McpScreenshot,
  McpStateSnapshot,
} from '@shader-studio/shared/mcp-protocol';
import { isHelloMessage } from '@shader-studio/shared/mcp-protocol';
import type { CompileDiagnostic } from './diagnostic';
import { RECOMPILE_DEBOUNCE_MS } from '../rendering/shader-canvas';
import { RendererHandle } from '../rendering/renderer-handle';
import { ShaderStore } from './shader-store';

const DEFAULT_PORT = 4310;
const RECONNECT_DELAY_MS = 2000;
/** Long enough for `shader-canvas`'s recompile debounce to have landed. */
const RECOMPILE_SETTLE_MS = RECOMPILE_DEBOUNCE_MS + 150;

function assertNever(value: never): never {
  throw new Error(`mcp-bridge: unhandled command "${(value as ControllerRequest).type}"`);
}

function toMcpDiagnostics(diagnostics: readonly CompileDiagnostic[]): readonly McpDiagnostic[] {
  return diagnostics.map(({ severity, line, message, source }) => ({
    severity,
    line,
    message,
    source,
  }));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the screenshot'));
    reader.readAsDataURL(blob);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lets the `mcp/server.ts` process drive this tab's `ShaderStore` live —
 * edit the draft, tweak params, apply presets, grab a screenshot — so an
 * agent can "see" and reshape whatever is currently on screen.
 *
 * Dev tooling only. `App` gates `start()` behind `isDevMode()`; nothing here
 * runs in a production build or during SSR (both never call it).
 */
@Injectable({ providedIn: 'root' })
export class McpBridge {
  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);

  private socket: WebSocket | null = null;
  private started = false;

  /** Idempotent: safe to call more than once, only the first call connects. */
  start(port = DEFAULT_PORT): void {
    if (this.started) return;
    this.started = true;
    this.connect(port);
  }

  private connect(port: number): void {
    const socket = new WebSocket(`ws://${location.hostname}:${port}`);
    this.socket = socket;

    socket.addEventListener('open', () => socket.send(JSON.stringify({ hello: 'app' })));
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      void this.handle(event.data);
    });
    socket.addEventListener('close', () => {
      this.socket = null;
      setTimeout(() => this.connect(port), RECONNECT_DELAY_MS);
    });
    // A refused connection also fires `close` right after — nothing extra to
    // do here beyond swallowing it, since the MCP server is optional tooling
    // that may simply not be running.
    socket.addEventListener('error', () => {});
  }

  private async handle(data: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (isHelloMessage(message)) return;

    const request = message as ControllerRequest;
    try {
      const result = await this.execute(request);
      this.reply({ id: request.id, ok: true, result } as AppResponse);
    } catch (error) {
      this.reply({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reply(response: AppResponse): void {
    this.socket?.send(JSON.stringify(response));
  }

  private async execute(request: ControllerRequest): Promise<unknown> {
    switch (request.type) {
      case 'listShaders':
        return this.store.shaders();
      case 'selectShader':
        await this.store.select(request.shaderId);
        return this.snapshot();
      case 'getState':
        return this.snapshot();
      case 'setFragment':
        this.store.setFragment(request.code);
        return this.diagnosticsAfterSettle();
      case 'setVertex':
        this.store.setVertex(request.code);
        return this.diagnosticsAfterSettle();
      case 'setControls':
        this.store.setControlsText(request.text);
        return this.diagnosticsAfterSettle();
      case 'setParam':
        this.store.setParam(request.key, request.value);
        return this.store.params();
      case 'resetParams':
        this.store.resetParams();
        return this.store.params();
      case 'listPresets':
        return this.store.presets();
      case 'applyPreset':
        this.store.applyPreset(request.presetId);
        return this.snapshot();
      case 'savePreset':
        await this.store.savePreset(request.name, request.withRender);
        return this.store.presets();
      case 'deletePreset':
        await this.store.deletePreset(request.presetId);
        return this.store.presets();
      case 'save': {
        const saved = await this.store.save();
        if (!saved) throw new Error('Save failed — check the app notice for details');
        return this.snapshot();
      }
      case 'revert':
        this.store.revert();
        return this.snapshot();
      case 'screenshot':
        return this.screenshot();
      case 'getDiagnostics':
        return toMcpDiagnostics(this.store.diagnostics());
      default:
        return assertNever(request);
    }
  }

  private snapshot(): McpStateSnapshot {
    const draft = this.store.draft();
    return {
      selectedId: this.store.selectedId(),
      shaders: this.store.shaders(),
      record: this.store.record(),
      draft: draft
        ? {
            fragment: draft.fragment,
            vertex: draft.vertex,
            controlsText: draft.controlsText,
            render: draft.render,
          }
        : null,
      controls: this.store.controls(),
      params: this.store.params(),
      presets: this.store.presets(),
      activePresetId: this.store.activePresetId(),
      dirty: this.store.dirty(),
      hasErrors: this.store.hasErrors(),
      diagnostics: toMcpDiagnostics(this.store.diagnostics()),
    };
  }

  private async diagnosticsAfterSettle(): Promise<readonly McpDiagnostic[]> {
    await wait(RECOMPILE_SETTLE_MS);
    return toMcpDiagnostics(this.store.diagnostics());
  }

  private async screenshot(): Promise<McpScreenshot> {
    const engine = this.renderer.engine();
    if (!engine) throw new Error('Nothing is rendering yet');

    const blob = await engine.screenshot();
    if (!blob) throw new Error('The current shader failed to produce a frame');

    return { base64: await blobToBase64(blob), mimeType: 'image/png' };
  }
}
