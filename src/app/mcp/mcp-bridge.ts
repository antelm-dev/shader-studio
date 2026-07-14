import { Injectable, inject } from '@angular/core';

import {
  ControllerRequestSchema,
  mcpError,
  type AppResponse,
  type ControllerRequest,
  type McpDiagnostic,
  type McpErrorCode,
  type McpScreenshot,
  type McpStateSnapshot,
} from '@shader-studio/shared/mcp-protocol';
import { DEFAULT_RENDER, type ShaderControl, type ShaderParams } from '@shader-studio/shared/model';
import type { CompileDiagnostic } from '@shader-studio/shared/diagnostic';
import { RendererHandle } from '../rendering/renderer-handle';
import { renderFrame } from '../rendering/frame-render';
import { ShaderStore } from '../workspace/shader-store';

const DEFAULT_PORT = 4310;
const RECONNECT_DELAY_MS = 2000;
const MCP_BRIDGE_PROTOCOL_VERSION = 2;

function toMcpDiagnostics(diagnostics: readonly CompileDiagnostic[]): McpDiagnostic[] {
  return diagnostics.map(({ severity, line, message, source, docId, docName }) => ({
    severity,
    line,
    message,
    source,
    ...(docId ? { docId } : {}),
    ...(docName ? { docName } : {}),
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

function messageKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null;
  return typeof value.kind === 'string' ? value.kind : null;
}

function rejectionReason(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('reason' in value)) return 'unknown reason';
  return typeof value.reason === 'string' ? value.reason : 'unknown reason';
}

function isControllerRequest(value: unknown): value is { id: string; type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'type' in value &&
    typeof value.type === 'string'
  );
}

/** A domain error with an MCP error code attached, so `handle`'s catch can report it precisely instead of always saying `INTERNAL`. */
class McpAppError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'McpAppError';
  }
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

  /**
   * Every incoming request is chained onto this so that two tool calls that
   * arrive close together apply to the store in the order they were
   * received, not the order their async work happens to finish in.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** Idempotent: safe to call more than once, only the first call connects. */
  start(port = DEFAULT_PORT): void {
    if (this.started) return;
    this.started = true;
    this.connect(port);
  }

  private connect(port: number): void {
    const socket = new WebSocket(`ws://${location.hostname}:${port}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          kind: 'hello',
          role: 'app',
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          appVersion: '1.0.0',
          sessionId: crypto.randomUUID(),
          token: localStorage.getItem('shaderStudioMcpToken') ?? '',
          capabilities: [],
        }),
      );
    });
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
    const kind = messageKind(message);
    if (kind === 'hello-ack') return;
    if (kind === 'hello-rejected') {
      console.warn(`[mcp-bridge] connection rejected: ${rejectionReason(message)}`);
      return;
    }

    if (!isControllerRequest(message)) return;
    const { id } = message;

    const validated = ControllerRequestSchema.safeParse(message);
    if (!validated.success) {
      this.reply({
        id,
        ok: false,
        error: mcpError('VALIDATION_ERROR', `Malformed "${message.type}" request.`),
      });
      return;
    }

    try {
      const result = await this.enqueue(() => this.execute(validated.data));
      this.reply({ id, ok: true, result } as AppResponse);
    } catch (error) {
      this.reply({
        id,
        ok: false,
        error:
          error instanceof McpAppError
            ? mcpError(error.code, error.message, { currentRevision: error.currentRevision })
            : mcpError('INTERNAL', error instanceof Error ? error.message : String(error)),
      });
    }
  }

  /** Runs `work` after every request already queued has settled, whichever way. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
        return toMcpDiagnostics((await this.store.compileNow()).diagnostics);
      case 'setVertex':
        this.store.setVertex(request.code);
        return toMcpDiagnostics((await this.store.compileNow()).diagnostics);
      case 'setControls':
        this.store.setControlsText(request.text);
        return toMcpDiagnostics((await this.store.compileNow()).diagnostics);
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
        if (!saved)
          throw new McpAppError('INTERNAL', 'Save failed — check the app notice for details');
        return this.snapshot();
      }
      case 'revert':
        this.store.revert();
        return this.snapshot();
      case 'screenshot':
        return this.screenshot();
      case 'getDiagnostics':
        return toMcpDiagnostics(this.store.diagnostics());

      // --- Project-aware commands ---------------------------------------------

      case 'getProject':
        this.assertShaderId(request.shaderId);
        return this.projectSnapshot();
      case 'getDocument':
        this.assertShaderId(request.shaderId);
        return this.documentSnapshot(request.documentId);
      case 'applyShaderPatch': {
        this.assertShaderId(request.shaderId);
        const result = await this.store.applyPatch(request.baseRevision, request.edits);
        if (!result.ok) {
          throw new McpAppError(result.code, result.message, result.currentRevision);
        }
        return { revision: result.revision, diagnostics: toMcpDiagnostics(result.diagnostics) };
      }
      case 'setParams': {
        this.assertShaderId(request.shaderId);
        this.requireSelected();
        const outcome = this.store.setParamsValidated(request.params);
        return { applied: outcome.applied, errors: outcome.errors, params: this.store.params() };
      }
      case 'compileProject': {
        this.assertShaderId(request.shaderId);
        this.requireSelected();
        const outcome = await this.store.compileNow(true);
        return {
          revision: outcome.revision,
          diagnostics: toMcpDiagnostics(outcome.diagnostics),
          hasErrors: outcome.diagnostics.some((entry) => entry.severity === 'error'),
        };
      }
      case 'renderFrame': {
        this.assertShaderId(request.shaderId);
        this.requireSelected();
        return this.renderFrameResult(request.time, request.width, request.height, request.params);
      }

      default:
        // Every `ControllerCommandType` is handled above, so `request` is `never`
        // here — reachable only if the shared protocol grows a command this
        // switch has not been updated for.
        throw new McpAppError(
          'INTERNAL',
          `mcp-bridge: command "${(request as ControllerRequest).type}" is not implemented`,
        );
    }
  }

  /** `shaderId` is an assertion, not a selector: the app only ever drives one open shader. */
  private assertShaderId(shaderId: string | undefined): void {
    if (shaderId !== undefined && shaderId !== this.store.selectedId()) {
      throw new McpAppError('NOT_FOUND', `"${shaderId}" is not the currently selected shader.`);
    }
  }

  private requireSelected(): string {
    const id = this.store.selectedId();
    if (!id) throw new McpAppError('NOT_FOUND', 'No shader is selected.');
    return id;
  }

  private projectSnapshot(): unknown {
    const shaderId = this.requireSelected();
    const record = this.store.record();

    const documents = this.store.documents().map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      name: doc.name,
      sourceLength: doc.source.length,
      ...(doc.passKind ? { passKind: doc.passKind } : {}),
      ...(doc.slot !== undefined ? { slot: doc.slot } : {}),
      ...(doc.enabled !== undefined ? { enabled: doc.enabled } : {}),
    }));

    return {
      shaderId,
      name: record?.name ?? shaderId,
      revision: this.store.draftRevision(),
      dirty: this.store.dirty(),
      documents,
      controls: [...this.store.controls()] as ShaderControl[],
      params: this.store.params(),
      presets: [...this.store.presets()],
      activePresetId: this.store.activePresetId(),
      render: this.store.draft()?.render ?? DEFAULT_RENDER,
      diagnostics: toMcpDiagnostics(this.store.allDiagnostics()),
      hasErrors: this.store.hasErrors(),
    };
  }

  private documentSnapshot(documentId: string): unknown {
    this.requireSelected();
    const doc = this.store.documents().find((entry) => entry.id === documentId);
    if (!doc) throw new McpAppError('NOT_FOUND', `Unknown document "${documentId}".`);

    return {
      id: doc.id,
      kind: doc.kind,
      name: doc.name,
      source: doc.source,
      revision: this.store.draftRevision(),
      diagnostics: toMcpDiagnostics(this.store.diagnosticsFor(doc.id)),
    };
  }

  private async renderFrameResult(
    time: number | undefined,
    width: number | undefined,
    height: number | undefined,
    params: ShaderParams | undefined,
  ): Promise<unknown> {
    const engine = this.renderer.engine();
    if (!engine) throw new McpAppError('INTERNAL', 'Nothing is rendering yet.');

    const frame = await renderFrame(engine, this.store.params(), { time, width, height, params });

    return {
      base64: await blobToBase64(frame.blob),
      mimeType: 'image/png',
      width: frame.width,
      height: frame.height,
      time: frame.time,
    };
  }

  private snapshot(): McpStateSnapshot {
    const draft = this.store.draft();
    return {
      selectedId: this.store.selectedId(),
      shaders: [...this.store.shaders()],
      record: structuredClone(this.store.record()) as McpStateSnapshot['record'],
      draft: draft
        ? {
            fragment: this.store.fragment(),
            vertex: this.store.vertex(),
            controlsText: draft.controlsText,
            render: draft.render,
          }
        : null,
      controls: [...this.store.controls()],
      params: this.store.params(),
      presets: [...this.store.presets()],
      activePresetId: this.store.activePresetId(),
      dirty: this.store.dirty(),
      hasErrors: this.store.hasErrors(),
      diagnostics: toMcpDiagnostics(this.store.diagnostics()),
    };
  }

  private async screenshot(): Promise<McpScreenshot> {
    const engine = this.renderer.engine();
    if (!engine) throw new McpAppError('INTERNAL', 'Nothing is rendering yet');

    const blob = await engine.screenshot();
    if (!blob) throw new McpAppError('INTERNAL', 'The current shader failed to produce a frame');

    return { base64: await blobToBase64(blob), mimeType: 'image/png' };
  }
}
