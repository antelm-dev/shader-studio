import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  type Handshake,
  type McpStateSnapshot,
} from '@shader-studio/shared/mcp-protocol';

import { callApp, closeBridge, startBridge } from './bridge';
import { resetBridgeTokenForTests } from './token';

/**
 * These drive a real `bridge.ts` WebSocketServer on an OS-assigned port with
 * real `ws` clients — the same shape as `verify-bridge.ts`, but exercising the
 * failure paths that script never needed to: a bad handshake, a second
 * session, a payload the schema rejects, a session that vanishes mid-request.
 */

const TOKEN = 'test-token';

const MINIMAL_STATE: McpStateSnapshot = {
  selectedId: null,
  shaders: [],
  record: null,
  draft: null,
  controls: [],
  params: {},
  presets: [],
  activePresetId: null,
  dirty: false,
  hasErrors: false,
  diagnostics: [],
};

function handshake(overrides: Partial<Handshake> = {}): Handshake {
  return {
    kind: 'hello',
    role: 'app',
    protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
    appVersion: '1.0.0',
    sessionId: crypto.randomUUID(),
    token: TOKEN,
    capabilities: [],
    ...overrides,
  };
}

function connect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('open', () => resolve()));
}

function onceMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(String(raw))));
  });
}

function onceClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

async function open(port: number): Promise<WebSocket> {
  const socket = connect(port);
  await onceOpen(socket);
  return socket;
}

async function connectedApp(port: number): Promise<WebSocket> {
  const socket = await open(port);
  socket.send(JSON.stringify(handshake()));
  await onceMessage(socket); // hello-ack
  return socket;
}

describe('mcp bridge', () => {
  let wss: Awaited<ReturnType<typeof startBridge>>;
  let port: number;

  beforeEach(async () => {
    resetBridgeTokenForTests(TOKEN);
    wss = await startBridge(0);
    port = (wss.address() as AddressInfo).port;
  });

  afterEach(async () => {
    resetBridgeTokenForTests();
    await closeBridge(wss).catch(() => undefined);
  });

  it('rejects a handshake with the wrong token, instead of trusting the connection because it is on localhost', async () => {
    const socket = await open(port);
    socket.send(JSON.stringify(handshake({ token: 'wrong' })));

    const message = await onceMessage(socket);
    expect(message).toMatchObject({ kind: 'hello-rejected' });
    await onceClose(socket);
  });

  it('rejects a handshake that is not valid JSON', async () => {
    const socket = await open(port);
    socket.send('not json');

    const message = await onceMessage(socket);
    expect(message).toMatchObject({ kind: 'hello-rejected' });
  });

  it('rejects a handshake missing required fields', async () => {
    const socket = await open(port);
    socket.send(JSON.stringify({ kind: 'hello', role: 'app', token: TOKEN }));

    const message = await onceMessage(socket);
    expect(message).toMatchObject({ kind: 'hello-rejected' });
  });

  it('accepts a valid, correctly-tokened handshake', async () => {
    const socket = await open(port);
    socket.send(JSON.stringify(handshake()));

    const message = await onceMessage(socket);
    expect(message).toMatchObject({ kind: 'hello-ack' });
    socket.close();
  });

  it('rejects a second connection instead of silently replacing the active session', async () => {
    const first = await connectedApp(port);

    const second = await open(port);
    second.send(JSON.stringify(handshake()));
    const message = await onceMessage(second);
    expect(message).toMatchObject({ kind: 'hello-rejected' });

    // The first session is still the one driving requests.
    const result = callApp({ type: 'getState' }, 500);
    const request = (await onceMessage(first)) as { id: string };
    first.send(JSON.stringify({ id: request.id, ok: true, result: MINIMAL_STATE }));
    await expect(result).resolves.toMatchObject({ selectedId: null });

    first.close();
    second.close();
  });

  it('lets a new session connect once the previous one has disconnected', async () => {
    const first = await connectedApp(port);
    first.close();
    await onceClose(first);

    const second = await open(port);
    second.send(JSON.stringify(handshake()));
    const message = await onceMessage(second);
    expect(message).toMatchObject({ kind: 'hello-ack' });
    second.close();
  });

  it('ignores malformed messages and unknown response ids without crashing the bridge', async () => {
    const socket = await connectedApp(port);

    socket.send('not json');
    socket.send(JSON.stringify({ id: 'nobody-is-waiting-on-this', ok: true, result: {} }));

    // The bridge is still alive and can serve a real request afterward.
    const result = callApp({ type: 'getState' }, 500);
    const request = (await onceMessage(socket)) as { id: string };
    socket.send(JSON.stringify({ id: request.id, ok: true, result: MINIMAL_STATE }));
    await expect(result).resolves.toMatchObject({ selectedId: null });

    socket.close();
  });

  it('rejects pending requests immediately when the session disconnects', async () => {
    const socket = await connectedApp(port);

    const result = callApp({ type: 'getState' }, 5000);
    await onceMessage(socket); // the request landed; nothing answers it

    socket.close();

    await expect(result).rejects.toThrow();
  });

  it('rejects a request that times out with no response', async () => {
    const socket = await connectedApp(port);

    await expect(callApp({ type: 'getState' }, 50)).rejects.toThrow(/Timeout/);

    socket.close();
  });

  it('rejects the pending promise when the response does not match the command schema', async () => {
    const socket = await connectedApp(port);

    const result = callApp({ type: 'getState' }, 500);
    const request = (await onceMessage(socket)) as { id: string };
    socket.send(JSON.stringify({ id: request.id, ok: true, result: { nonsense: true } }));

    await expect(result).rejects.toThrow();

    socket.close();
  });

  it('rejects an application error response with its structured code intact', async () => {
    const socket = await connectedApp(port);

    const result = callApp(
      {
        type: 'applyShaderPatch',
        shaderId: 'demo',
        baseRevision: 1,
        edits: [{ documentId: '@vertex', start: 0, end: 0, text: '' }],
      },
      500,
    );
    const request = (await onceMessage(socket)) as { id: string };
    socket.send(
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: 'STALE_REVISION', message: 'stale', currentRevision: 3 },
      }),
    );

    await expect(result).rejects.toMatchObject({
      mcpError: { code: 'STALE_REVISION', currentRevision: 3 },
    });

    socket.close();
  });
});
