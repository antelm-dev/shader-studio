// Runs inside the opaque-origin plugin frame (see app/plugins/plugin-sandbox.ts).
// Its only job is to start the plugin's Worker and hand it the host's
// MessagePort; the frame itself never runs plugin code.
(() => {
  // Prepended to the plugin bundle. Exposes `shaderStudio.handle` for requests
  // and `shaderStudio.notify` for one-way events, both over the host's port.
  const PRELUDE = `(() => {
  const handlers = new Map();
  let port;
  self.shaderStudio = Object.freeze({
    handle(method, fn) { handlers.set(method, fn); },
    notify(data) { port?.postMessage({ type: 'event', data }); },
  });
  self.onmessage = (event) => {
    self.onmessage = null;
    port = event.ports[0];
    port.onmessage = async ({ data }) => {
      const id = data?.id;
      try {
        const fn = handlers.get(data?.method);
        if (!fn) throw new Error('Unknown method: ' + data?.method);
        port.postMessage({ type: 'result', id, result: await fn(data.params) });
      } catch (error) {
        port.postMessage({ type: 'result', id, error: String(error?.message ?? error) });
      }
    };
    port.postMessage({ type: 'ready' });
  };
})();
`;

  const fail = (message) => parent.postMessage({ type: 'sandbox-error', message }, '*');

  addEventListener('message', function start(event) {
    if (event.source !== parent || event.data?.type !== 'start' || !event.ports[0]) return;
    removeEventListener('message', start);
    try {
      const blob = new Blob([PRELUDE, event.data.code], { type: 'text/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onerror = (error) => fail(error.message || 'Plugin worker failed to load');
      worker.postMessage(null, [event.ports[0]]);
    } catch (error) {
      fail(String(error?.message ?? error));
    }
  });
})();
