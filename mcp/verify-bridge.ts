import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import {
  HandshakeAckSchema,
  MCP_BRIDGE_PROTOCOL_VERSION,
  type ControllerRequest,
  type Handshake,
} from '@shader-studio/shared/mcp-protocol';

import { callApp, closeBridge, resetBridgeForTests, startBridge } from './bridge.js';
import { resetBridgeTokenForTests } from './token.js';

const PORT = Number(process.env['SHADER_STUDIO_MCP_PORT'] ?? 4311);
const TOKEN = 'verify-bridge-token';

function messageText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

async function main(): Promise<void> {
  resetBridgeTokenForTests(TOKEN);
  const wss = await startBridge(PORT);

  const app = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve, reject) => {
    app.once('open', () => {
      const handshake: Handshake = {
        kind: 'hello',
        role: 'app',
        protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
        appVersion: '1.0.0',
        sessionId: randomUUID(),
        token: TOKEN,
        capabilities: [],
      };
      app.send(JSON.stringify(handshake));
    });
    app.once('message', (raw) => {
      const ack = HandshakeAckSchema.safeParse(JSON.parse(messageText(raw)));
      if (ack.success) resolve();
      else reject(new Error('Handshake was rejected'));
    });
    app.once('error', reject);
  });

  app.on('message', (raw) => {
    const request = JSON.parse(messageText(raw)) as ControllerRequest;

    switch (request.type) {
      case 'getState':
        app.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              selectedId: 'demo',
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
            },
          }),
        );
        break;
      case 'setParam':
        app.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { [request.key]: request.value },
          }),
        );
        break;
      case 'setFragment':
        app.send(JSON.stringify({ id: request.id, ok: true, result: [] }));
        break;
      case 'screenshot':
        app.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' },
          }),
        );
        break;
      default:
        app.send(
          JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'INTERNAL', message: `Unhandled ${request.type}` },
          }),
        );
    }
  });

  const state = await callApp({ type: 'getState' });
  if (state.selectedId !== 'demo') {
    throw new Error('getState round-trip failed');
  }

  const params = await callApp({ type: 'setParam', key: 'speed', value: 2.5 });
  if (params['speed'] !== 2.5) {
    throw new Error('setParam round-trip failed');
  }

  const diagnostics = await callApp({
    type: 'setFragment',
    code: 'void main(){ gl_FragColor = vec4(1.0); }',
  });
  if (!Array.isArray(diagnostics)) {
    throw new Error('setFragment round-trip failed');
  }

  const frame = await callApp({ type: 'screenshot' });
  if (frame.mimeType !== 'image/png' || !frame.base64) {
    throw new Error('screenshot round-trip failed');
  }

  console.log('mcp bridge verification passed');
  app.close();
  resetBridgeForTests();
  resetBridgeTokenForTests();
  await closeBridge(wss);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
