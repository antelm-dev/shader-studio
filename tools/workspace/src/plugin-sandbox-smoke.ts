/**
 * Drives the dev-only `pluginSandboxProbe()` (apps/web/src/app/plugins) and
 * checks from outside the page what the page cannot see about itself:
 *
 * - no attempted request left the browser, and each CSP-governed one raised a
 *   violation for its own URL;
 * - terminate aborts the plugin's Worker, observed through the browser's
 *   worker lifecycle rather than through the (closed) message port.
 *
 * Chromium also reaps the Worker of a removed frame, so "the Worker closed"
 * cannot by itself tell `worker.terminate()` from an orphaned Worker. A second
 * run therefore keeps the frame attached, where only an explicit terminate can
 * stop the loop; the same run without `worker.terminate()` is the negative
 * control, and the check fails unless its surviving Worker is caught.
 */
import type { Browser, BrowserContext, Worker } from 'playwright';

interface ProbeReport {
  checks: Record<string, { ok: boolean; detail: unknown }>;
  attempted: { name: string; url: string; csp: boolean }[];
  violations: { directive: string; url: string }[];
}

type WorkerFate = 'closed' | 'survived' | 'missing';

interface Variant {
  keepFrame?: boolean;
  dropTerminate?: boolean;
}

const WORKER_CLOSE_TIMEOUT_MS = 3_000;

export async function checkPluginSandbox(browser: Browser, base: string): Promise<void> {
  const problems: string[] = [];

  const intact = await runProbe(browser, base, {});
  for (const [name, { ok, detail }] of Object.entries(intact.report.checks)) {
    if (!ok) problems.push(`${name}: ${JSON.stringify(detail)}`);
  }
  for (const { name, url, csp } of intact.report.attempted) {
    if (intact.sent.includes(url)) problems.push(`${name}: request left the browser (${url})`);
    const violated = intact.report.violations.some(
      (violation) => violation.url !== '' && url.startsWith(violation.url),
    );
    if (csp && !violated) problems.push(`${name}: no CSP violation recorded for ${url}`);
  }
  if (intact.fate !== 'closed') problems.push(`plugin Worker after terminate(): ${intact.fate}`);

  const kept = await runProbe(browser, base, { keepFrame: true });
  if (kept.fate !== 'closed') {
    problems.push(`with the frame attached, worker.terminate() did not stop it: ${kept.fate}`);
  }
  const control = await runProbe(browser, base, { keepFrame: true, dropTerminate: true });
  if (control.fate !== 'survived') {
    problems.push(`negative control went undetected: Worker without terminate was ${control.fate}`);
  }

  if (problems.length) {
    throw new Error(`plugin sandbox checks failed:\n  - ${problems.join('\n  - ')}`);
  }
}

async function runProbe(browser: Browser, base: string, variant: Variant) {
  const context = await browser.newContext();
  try {
    await applyVariant(context, variant);
    const sent: string[] = [];
    context.on('request', (request) => sent.push(request.url()));

    const page = await context.newPage();
    // A Worker spawned in the opaque-origin frame has an opaque blob URL.
    const workers: Worker[] = [];
    let closed = false;
    page.on('worker', (worker) => {
      if (!worker.url().startsWith('blob:null/')) return;
      workers.push(worker);
      worker.on('close', () => (closed = true));
    });

    await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction('typeof globalThis.pluginSandboxProbe === "function"', null, {
      timeout: 30_000,
    });
    const report = (await page.evaluate('globalThis.pluginSandboxProbe()')) as ProbeReport;

    const deadline = Date.now() + WORKER_CLOSE_TIMEOUT_MS;
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const fate: WorkerFate = workers.length !== 1 ? 'missing' : closed ? 'closed' : 'survived';
    return { report, sent, fate };
  } finally {
    await context.close();
  }
}

async function applyVariant(context: BrowserContext, variant: Variant): Promise<void> {
  if (variant.keepFrame) {
    await context.addInitScript('HTMLIFrameElement.prototype.remove = function () {};');
  }
  if (variant.dropTerminate) {
    await context.route('**/plugin-sandbox.js', async (route) => {
      const body = await (await route.fetch()).text();
      const disabled = body.replace('worker?.terminate();', '');
      if (disabled === body) throw new Error('negative control: worker.terminate() call not found');
      await route.fulfill({ body: disabled, contentType: 'text/javascript' });
    });
  }
}
