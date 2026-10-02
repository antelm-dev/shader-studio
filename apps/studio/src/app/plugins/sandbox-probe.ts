/**
 * Feasibility probe for the plugin sandbox: loads a hostile plugin and reports
 * whether each escape attempt was blocked. Development builds expose it as
 * `pluginSandboxProbe()`; `tools/workspace/src/plugin-sandbox-smoke.ts` drives
 * it in CI.
 *
 * What the page itself cannot see is left to the harness: whether a request
 * left the browser, and whether the Worker was actually destroyed on
 * terminate — silence on a closed port proves neither.
 */
import { validatePluginPackage } from '@shadergrove/shared';

import { PluginCallError, PluginHost } from './plugin-host';
import { PluginSandbox } from './plugin-sandbox';

const HOSTILE_PLUGIN = String.raw`
const violations = [];
self.addEventListener('securitypolicyviolation', (e) =>
  violations.push({ directive: e.effectiveDirective, url: e.blockedURI }));
// An attempt that neither fails nor completes may already have sent its request.
const attempt = (fn) => Promise.race([
  Promise.resolve().then(fn).then(
    () => 'allowed',
    (error) => 'blocked: ' + (error?.name ?? error),
  ),
  new Promise((resolve) => setTimeout(resolve, 3000, 'no answer')),
]);
const settle = async (attempts) =>
  Object.fromEntries(await Promise.all(
    Object.entries(attempts).map(async ([name, fn]) => [name, await attempt(fn)])));
const socket = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => { ws.close(); resolve(); };
  ws.onerror = () => reject(new Error('error'));
});
shaderStudio.handle('echo', ({ bytes }) => ({ length: bytes.byteLength, bytes }));
shaderStudio.handle('ping', () => ({ pong: true, origin: self.origin }));
shaderStudio.handle('violations', () => violations);
// no-cors: a CORS failure must not pass for a block — the request itself must not leave.
shaderStudio.handle('network', (targets) => settle({
  'fetch app origin': () => fetch(targets.app, { mode: 'no-cors' }),
  'post app api': () =>
    fetch(targets.api, { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' }),
  'fetch internet': () => fetch(targets.internet, { mode: 'no-cors' }),
  'websocket localhost': () => socket(targets.socket),
  'importScripts remote': () => importScripts(targets.script),
  // Firefox reports this with an async error event rather than a throw.
  'worker from app origin': () => new Promise((resolve, reject) => {
    const worker = new Worker(targets.worker);
    worker.onerror = () => reject(new Error('error event'));
    setTimeout(resolve, 1500);
  }),
}));
shaderStudio.handle('storage', () => settle({
  indexedDB: () => new Promise((resolve, reject) => {
    const request = indexedDB.open('plugin-probe');
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  }),
  caches: () => caches.open('plugin-probe'),
  'electron bridge': () => {
    if (typeof self.electron !== 'undefined') return;
    throw new Error('absent');
  },
}));
shaderStudio.handle('spin', () => {
  for (let n = 1; ; n++) if (n % 20_000_000 === 0) shaderStudio.notify('alive');
});
`;

export interface SandboxProbeReport {
  checks: Record<string, { ok: boolean; detail: unknown }>;
  /** Every URL the plugin tried; none may leave the browser. `csp` ones must also be CSP violations. */
  attempted: { name: string; url: string; csp: boolean }[];
  violations: { directive: string; url: string }[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSandboxProbe(): Promise<SandboxProbeReport> {
  const checks: SandboxProbeReport['checks'] = {};
  let heartbeats = 0;
  const sandbox = await PluginSandbox.start(HOSTILE_PLUGIN, { onEvent: () => heartbeats++ });

  const ping = (await sandbox.call('ping')) as { pong?: boolean; origin?: string };
  checks['plugin runs'] = { ok: ping.pong === true, detail: ping };
  checks['plugin origin is opaque'] = { ok: ping.origin === 'null', detail: ping.origin };
  checks['frame document hidden from host'] = {
    ok: sandbox.element.contentDocument === null,
    detail: sandbox.element.contentDocument === null ? 'null' : 'readable',
  };

  // The desktop bundle is served from a custom scheme; aim at a local service instead.
  const socket = location.protocol.startsWith('http')
    ? location.origin.replace(/^http/, 'ws') + '/'
    : 'ws://localhost:4321/';
  const targets = {
    app: `${location.origin}/?plugin-probe`,
    api: `${location.origin}/api/shaders?plugin-probe`,
    internet: 'https://example.com/?plugin-probe',
    socket: `${socket}?plugin-probe`,
    script: 'https://example.com/plugin-probe.js',
    worker: `${location.origin}/plugin-sandbox.js?plugin-probe`,
  };
  const attempted: SandboxProbeReport['attempted'] = [
    { name: 'fetch app origin', url: targets.app, csp: true },
    { name: 'post app api', url: targets.api, csp: true },
    { name: 'fetch internet', url: targets.internet, csp: true },
    { name: 'websocket localhost', url: targets.socket, csp: true },
    { name: 'importScripts remote', url: targets.script, csp: true },
    // Refused by the same-origin rule for Worker scripts, before CSP applies.
    { name: 'worker from app origin', url: targets.worker, csp: false },
  ];
  const outcomes = {
    ...((await sandbox.call('network', targets)) as Record<string, string>),
    ...((await sandbox.call('storage')) as Record<string, string>),
  };
  for (const [name, outcome] of Object.entries(outcomes)) {
    checks[name] = { ok: outcome.startsWith('blocked'), detail: outcome };
  }
  const violations = (await sandbox.call('violations')) as SandboxProbeReport['violations'];

  // Buffers move both ways: detached here once sent, and detached in the Worker once returned.
  const sent = new ArrayBuffer(1024);
  const echoed = (await sandbox.call('echo', { bytes: sent }, { transfer: [sent] })) as {
    length: number;
    bytes: ArrayBuffer;
  };
  checks['sent buffer transferred'] = { ok: sent.byteLength === 0, detail: sent.byteLength };
  checks['returned buffer arrives'] = {
    ok: echoed.length === 1024 && echoed.bytes.byteLength === 1024,
    detail: echoed.length,
  };

  // A second 'start' must not spawn another worker on a port someone else holds.
  const forged = new MessageChannel();
  let forgedReady = false;
  forged.port1.onmessage = () => (forgedReady = true);
  sandbox.element.contentWindow?.postMessage(
    { type: 'start', code: 'self.onmessage = (e) => e.ports[0].postMessage(1)' },
    '*',
    [forged.port2],
  );

  // Leave the plugin spinning; the harness checks that terminate destroys its Worker.
  const spinning = sandbox
    .call('spin', undefined, { timeoutMs: 60_000 })
    .catch((error: Error) => error.message);
  await wait(1_000);
  checks['forged start ignored'] = {
    ok: !forgedReady,
    detail: forgedReady ? 'answered' : 'silent',
  };
  checks['loop was running'] = { ok: heartbeats > 0, detail: heartbeats };
  await sandbox.terminate('probe stop');
  checks['frame removed'] = {
    ok: !sandbox.element.isConnected,
    detail: sandbox.element.isConnected,
  };
  checks['pending call rejected'] = {
    ok: (await spinning) === 'probe stop',
    detail: await spinning,
  };
  const late = await sandbox.call('ping').then(
    () => 'answered',
    (error: Error) => error.message,
  );
  checks['call after stop rejected'] = { ok: late === 'probe stop', detail: late };
  return { checks, attempted, violations };
}

const HOST_PLUGIN = String.raw`
shaderStudio.handle('importer:echo', ({ bytes, params }) =>
  ({ candidate: { length: bytes.byteLength, gain: params.gain } }));
shaderStudio.handle('importer:bloat', () => ({ candidate: 'x'.repeat(5000) }));
shaderStudio.handle('importer:silent', () => new Promise(() => {}));
shaderStudio.handle('importer:flood', () => { for (;;) shaderStudio.notify('x'.repeat(70000)); });
shaderStudio.handle('exporter:text', () =>
  ({ bytes: new ArrayBuffer(4), mime: 'text/plain', fileName: 'effect.fs' }));
`;

const hostPackage = validatePluginPackage({
  manifest: {
    id: 'probe.host',
    version: '1.0.0',
    protocolVersion: 1,
    appVersionRange: '>=0.0.0',
    name: 'Probe',
    publisher: 'Shadergrove',
    license: 'Apache-2.0',
    contributions: [
      ...['echo', 'bloat', 'silent', 'flood'].map((id) => ({
        kind: 'importer',
        id,
        name: id,
        mime: [],
        extensions: ['.fs'],
        maxInputBytes: 4096,
        maxOutputBytes: 4096,
        params: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
      })),
      {
        kind: 'exporter',
        id: 'text',
        name: 'text',
        mime: 'text/plain',
        extension: '.fs',
        maxInputBytes: 4096,
        maxOutputBytes: 4096,
        params: [],
      },
    ],
  },
  code: HOST_PLUGIN,
});

/**
 * Drives the real `PluginHost` against real Workers. The harness then checks
 * that every Worker it started is gone, including the ones the host had to
 * kill (no answer, event flood).
 */
export async function runHostProbe(): Promise<Record<string, { ok: boolean; detail: unknown }>> {
  if (!hostPackage.ok) throw new Error(hostPackage.errors.join('; '));
  const host = new PluginHost(hostPackage.value, { timeoutMs: 1_500 });
  const checks: Record<string, { ok: boolean; detail: unknown }> = {};
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (error: unknown) => (error instanceof PluginCallError ? error.code : String(error)),
    );

  const bytes = new ArrayBuffer(64);
  const imported = await host.importFile('echo', bytes, { gain: 9 });
  checks['import round trip'] = {
    ok: JSON.stringify(imported) === '{"candidate":{"length":64,"gain":2}}',
    detail: imported,
  };
  checks['import buffer transferred'] = { ok: bytes.byteLength === 0, detail: bytes.byteLength };

  const exported = await host.exportEffect('text', { name: 'e' });
  checks['export result valid'] = {
    ok: exported.bytes.byteLength === 4 && exported.fileName === 'effect.fs',
    detail: exported.fileName,
  };

  for (const [id, expected] of [
    ['bloat', 'output-too-large'],
    ['flood', 'events-exceeded'],
    ['silent', 'Error: Plugin did not answer importer:silent in time'],
  ] as const) {
    const outcome = await code(host.importFile(id, new ArrayBuffer(1)));
    checks[`${id} rejected`] = { ok: outcome === expected, detail: outcome };
  }
  return checks;
}
