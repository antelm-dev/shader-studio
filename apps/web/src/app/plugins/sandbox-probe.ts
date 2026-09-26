/**
 * Feasibility probe for the plugin sandbox: loads a hostile plugin and reports
 * whether each escape attempt was blocked. Development builds expose it as
 * `pluginSandboxProbe()`; every entry in the result should be `ok: true`.
 */
import { PluginSandbox } from './plugin-sandbox';

const HOSTILE_PLUGIN = String.raw`
const violations = [];
self.addEventListener('securitypolicyviolation', (e) =>
  violations.push(e.effectiveDirective + ' ' + e.blockedURI));
const attempt = async (fn) => {
  try { await fn(); return 'allowed'; } catch (error) { return 'blocked: ' + (error?.name ?? error); }
};
const socket = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => { ws.close(); resolve(); };
  ws.onerror = () => reject(new Error('error'));
});
shaderStudio.handle('ping', () => ({ pong: true, origin: self.origin }));
shaderStudio.handle('violations', () => violations);
shaderStudio.handle('escape', async ({ appOrigin, socketUrl }) => ({
  // no-cors: a CORS failure must not pass for a block — the request itself must not leave.
  'fetch app origin': await attempt(() => fetch(appOrigin + '/', { mode: 'no-cors' })),
  'post app api': await attempt(() =>
    fetch(appOrigin + '/api/shaders', { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' })),
  'fetch internet': await attempt(() => fetch('https://example.com/', { mode: 'no-cors' })),
  'websocket localhost': await attempt(() => socket(socketUrl)),
  'importScripts remote': await attempt(() => importScripts('https://example.com/x.js')),
  // Firefox reports this with an async error event rather than a throw.
  'worker from app origin': await attempt(() => new Promise((resolve, reject) => {
    const worker = new Worker(appOrigin + '/plugin-sandbox.js?escape');
    worker.onerror = () => reject(new Error('error event'));
    setTimeout(resolve, 1500);
  })),
  indexedDB: await attempt(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('plugin-probe');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  })),
  caches: await attempt(() => caches.open('plugin-probe')),
  'electron bridge': typeof self.electron === 'undefined' ? 'blocked: absent' : 'allowed',
}));
shaderStudio.handle('spin', () => {
  for (let n = 1; ; n++) if (n % 20_000_000 === 0) shaderStudio.notify('alive');
});
`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSandboxProbe(): Promise<Record<string, { ok: boolean; detail: unknown }>> {
  const report: Record<string, { ok: boolean; detail: unknown }> = {};
  let heartbeats = 0;
  const sandbox = await PluginSandbox.start(HOSTILE_PLUGIN, { onEvent: () => heartbeats++ });

  const ping = (await sandbox.call('ping')) as { pong?: boolean; origin?: string };
  report['plugin runs'] = { ok: ping.pong === true, detail: ping };
  report['plugin origin is opaque'] = { ok: ping.origin === 'null', detail: ping.origin };
  report['frame document hidden from host'] = {
    ok: sandbox.element.contentDocument === null,
    detail: sandbox.element.contentDocument === null ? 'null' : 'readable',
  };

  // The desktop bundle is served from a custom scheme; aim at a local service instead.
  const socketUrl = location.protocol.startsWith('http')
    ? location.origin.replace(/^http/, 'ws') + '/'
    : 'ws://localhost:4321/';
  const escapes = (await sandbox.call('escape', {
    appOrigin: location.origin,
    socketUrl,
  })) as Record<string, string>;
  for (const [name, outcome] of Object.entries(escapes)) {
    report[name] = { ok: outcome.startsWith('blocked'), detail: outcome };
  }
  // Evidence that the network attempts died on CSP, not on an absent server.
  const violations = (await sandbox.call('violations')) as string[];
  report['csp violations recorded'] = { ok: violations.length > 0, detail: violations };

  // A second 'start' must not spawn another worker on a port someone else holds.
  const forged = new MessageChannel();
  let forgedReady = false;
  forged.port1.onmessage = () => (forgedReady = true);
  sandbox.element.contentWindow?.postMessage(
    { type: 'start', code: 'self.onmessage = (e) => e.ports[0].postMessage(1)' },
    '*',
    [forged.port2],
  );

  // An infinite loop keeps sending heartbeats until the frame is removed.
  const spinning = sandbox.call('spin', undefined, 60_000).catch((error: Error) => error.message);
  await wait(1_000);
  report['forged start ignored'] = {
    ok: !forgedReady,
    detail: forgedReady ? 'answered' : 'silent',
  };
  const beforeStop = heartbeats;
  sandbox.terminate('probe stop');
  await wait(1_000);
  report['loop was running'] = { ok: beforeStop > 0, detail: beforeStop };
  report['terminate stops the loop'] = {
    ok: heartbeats === beforeStop,
    detail: `${heartbeats - beforeStop} heartbeats after stop`,
  };
  report['pending call rejected'] = {
    ok: (await spinning) === 'probe stop',
    detail: await spinning,
  };
  const late = await sandbox.call('ping').then(
    () => 'answered',
    (error: Error) => error.message,
  );
  report['call after stop rejected'] = { ok: late === 'probe stop', detail: late };
  return report;
}
