/**
 * The UI and icon fonts ship with the app. Load it in a fresh context (no
 * cache) where every request that leaves 127.0.0.1/localhost is aborted, and
 * check that Inter, JetBrains Mono and Material Symbols still load, no font
 * request failed, and no visible icon shows its ligature text instead of a
 * glyph.
 */
import type { Browser } from 'playwright';

const LOCAL = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//;
const REQUIRED_FAMILIES = [
  'Inter Variable',
  'JetBrains Mono Variable',
  'Material Symbols Outlined',
];

export async function checkOfflineFonts(browser: Browser, base: string): Promise<void> {
  const context = await browser.newContext();
  const problems: string[] = [];
  try {
    await context.route(
      (url) => !LOCAL.test(url.href) && !url.protocol.startsWith('data'),
      (route) => route.abort('internetdisconnected'),
    );
    const page = await context.newPage();
    // Remote fonts (the editor's Google font picker) are expected to fail here.
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'font' && LOCAL.test(request.url())) {
        problems.push(`font request failed: ${request.url()}`);
      }
    });

    await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.locator('mat-icon').first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate('document.fonts.ready');

    const report = (await page.evaluate(`(() => {
      const loaded = [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => face.family.replace(/^["']|["']$/g, ''));
      // An icon whose name is not a ligature renders as text wider than its box.
      const unrendered = [...document.querySelectorAll('mat-icon.mat-ligature-font')]
        .filter((icon) => icon.getClientRects().length && icon.scrollWidth > icon.clientWidth + 1)
        .map((icon) => icon.textContent.trim());
      return { loaded, unrendered };
    })()`)) as { loaded: string[]; unrendered: string[] };

    for (const family of REQUIRED_FAMILIES) {
      if (!report.loaded.includes(family)) problems.push(`${family} did not load`);
    }
    for (const name of report.unrendered) problems.push(`icon "${name}" rendered as text`);
  } finally {
    await context.close();
  }
  if (problems.length) throw new Error(`Offline font check failed:\n  ${problems.join('\n  ')}`);
}
