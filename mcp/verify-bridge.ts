import { callApp, closeBridge, resetBridgeForTests, startBridge } from './bridge.js';
import type { ControllerRequest } from '../src/shared/mcp-protocol.js';
import { WebSocket } from 'ws';

const PORT = Number(process.env['SHADER_STUDIO_MCP_PORT'] ?? 4311);

async function main(): Promise<void> {
  const wss = await startBridge(PORT);

  const app = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise<void>((resolve, reject) => {
    app.once('open', () => {
      app.send(JSON.stringify({ hello: 'app' }));
      resolve();
    });
    app.once('error', reject);
  });

  app.on('message', (raw) => {
    const request = JSON.parse(String(raw)) as ControllerRequest;

    switch (request.type) {
      case 'getState':
        app.send(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { selectedId: 'demo', dirty: false, hasErrors: false },
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
        app.send(JSON.stringify({ id: request.id, ok: false, error: `Unhandled ${request.type}` }));
    }
  });

  const state = await callApp({ type: 'getState' });
  if ((state as { selectedId: string }).selectedId !== 'demo') {
    throw new Error('getState round-trip failed');
  }

  const params = await callApp({ type: 'setParam', key: 'speed', value: 2.5 });
  if ((params as { speed: number }).speed !== 2.5) {
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
  await closeBridge(wss);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
