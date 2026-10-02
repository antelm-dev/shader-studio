// The official Shadertoy and Wallpaper Engine plugins, end to end in the
// browser: discovered under Available, installed (off), switched on, run from
// Installed — paste and API imports, a ZIP export of the open draft — kept
// across a reload, and removed. The old menu shortcuts lead to Plugins when the
// plugin is missing and use it when it is on. Shadertoy itself is never
// contacted: the app's own provider routes are answered by the test, which is
// also how it sees exactly what the browser sent to the server.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

test.describe.configure({ timeout: 300_000 });

const SHADERTOY = 'dev.shadergrove.shadertoy';
const WALLPAPER = 'dev.shadergrove.wallpaper-engine';
const IMPORTER = `${SHADERTOY}/shadertoy`;
const EXPORTER = `${WALLPAPER}/wallpaper-engine`;

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../plugins/official/shadertoy/fixtures/multipass.json'),
    'utf8',
  ),
) as unknown;

/**
 * Importing writes to the library, which an unverified account may not do.
 * The test account lives in the server's throwaway store (see `serve.ts`), so
 * it is verified there directly.
 */
test.beforeAll(() => {
  // `node:sqlite` is newer than this project's Node typings; only these calls are used.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...values: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(tmpdir(), 'shadergrove-e2e', 'shader-studio.sqlite'));
  try {
    db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run('e2e@example.test');
  } finally {
    db.close();
  }
});

async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
}

async function menuItem(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  const direct = page.getByRole('menuitem', { name });
  if (!(await direct.isVisible())) {
    await page.getByRole('menuitem', { name: /Import & export/ }).click();
  }
  await page.getByRole('menuitem', { name }).click();
}

async function installAvailable(page: Page, id: string): Promise<void> {
  await page.getByTestId(`install-available-${id}`).click();
  await expect(page.getByTestId(`plugin-${id}`)).toBeVisible();
  await expect(page.getByTestId(`available-installed-${id}`)).toBeVisible();
  const toggle = page.getByTestId(`plugin-enable-${id}`).getByRole('switch');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
}

async function shaderNames(page: Page): Promise<string[]> {
  const response = await page.request.get('/api/shaders');
  const body = (await response.json()) as { shaders: { name: string }[] };
  return body.shaders.map((shader) => shader.name);
}

test('Shadertoy Import: discovered, installed off, paste and API imports, kept, removed', async ({
  page,
}) => {
  const sourceRequests: unknown[] = [];
  await page.route('**/api/import/shadertoy/source', async (route) => {
    sourceRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { sourceId: 'ParFix', source: fixture } });
  });
  await page.route('**/api/import/shadertoy/asset**', (route) =>
    route.fulfill({ status: 502, json: { error: { message: 'request failed (404)' } } }),
  );

  await openStudio(page);

  // The old shortcut leads to Plugins, with the package to install picked out.
  await menuItem(page, /Import from Shadertoy/);
  await expect(page).toHaveURL(`/plugins?use=${SHADERTOY}`);
  await expect(page.getByTestId(`available-${SHADERTOY}`)).toHaveClass(/focused/);
  await expect(page.getByTestId(`available-${WALLPAPER}`)).toBeVisible();

  await installAvailable(page, SHADERTOY);

  // Paste: one Image pass becomes a new shader, created whole.
  await page.getByTestId(`mode-paste-${IMPORTER}`).check();
  await page.getByTestId(`paste-name-${IMPORTER}`).fill('Pasted Waves');
  await page
    .getByTestId(`paste-source-${IMPORTER}`)
    .fill('void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, 0.5, 1.0); }');
  await page.getByTestId(`run-${IMPORTER}`).click();
  await expect(page.getByTestId('plugin-message')).toContainText('Imported “Pasted Waves”.');
  expect(await shaderNames(page)).toContain('Pasted Waves');

  // Invalid source is refused with a readable error, and nothing is created.
  const before = (await shaderNames(page)).length;
  await page.getByTestId(`paste-source-${IMPORTER}`).fill('void main() {}');
  await page.getByTestId(`run-${IMPORTER}`).click();
  await expect(page.getByTestId('plugin-message')).toContainText('mainImage');
  expect(await shaderNames(page)).toHaveLength(before);

  // API: the host fetches the document; the warnings of the conversion are shown.
  await page.getByTestId(`mode-provider-${IMPORTER}`).check();
  await page.getByTestId(`field-idOrUrl-${IMPORTER}`).fill('https://www.shadertoy.com/view/ParFix');
  await page.getByTestId(`field-apiKey-${IMPORTER}`).fill('e2e-key');
  await page.getByTestId(`run-${IMPORTER}`).click();
  await expect(page.getByTestId('plugin-message')).toContainText('Imported “Parity fixture”.');
  await expect(page.getByTestId('plugin-warnings')).toContainText('sound pass');
  await expect(page.getByTestId('plugin-warnings')).toContainText('Failed to download a texture');
  expect(sourceRequests).toEqual([{ idOrUrl: 'ParFix', apiKey: 'e2e-key' }]);
  expect(await shaderNames(page)).toContain('Parity fixture');

  // Kept across a reload, still on, with the key remembered by the host.
  await page.reload();
  const toggle = page.getByTestId(`plugin-enable-${SHADERTOY}`).getByRole('switch');
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId(`field-apiKey-${IMPORTER}`)).toHaveValue('e2e-key');

  // Removing the plugin keeps what it imported.
  await page.getByTestId(`plugin-remove-${SHADERTOY}`).click();
  await expect(page.getByTestId(`plugin-${SHADERTOY}`)).toHaveCount(0);
  await expect(page.getByTestId(`install-available-${SHADERTOY}`)).toBeVisible();
  expect(await shaderNames(page)).toEqual(
    expect.arrayContaining(['Pasted Waves', 'Parity fixture']),
  );
});

test('Wallpaper Engine Export: shortcut leads to Plugins, then exports the open draft as a ZIP', async ({
  page,
}) => {
  await openStudio(page);

  await menuItem(page, /Export to Wallpaper Engine/);
  await expect(page).toHaveURL(`/plugins?use=${WALLPAPER}`);
  await installAvailable(page, WALLPAPER);

  const download = page.waitForEvent('download');
  await page.getByTestId(`run-${EXPORTER}`).click();
  const zip = await download;
  expect(zip.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync(await zip.path());
  const listing = bytes.toString('latin1');
  const stem = zip.suggestedFilename().replace(/\.zip$/, '');
  expect(listing).toContain(`${stem}/index.html`);
  expect(listing).toContain(`${stem}/project.json`);
  expect(listing).toContain('"type": "web"');
  expect(listing).toContain('wallpaperPropertyListener');
  await expect(page.getByTestId('plugin-message')).toContainText(`Exported to ${stem}.zip.`);

  // With the plugin on, the menu shortcut runs it directly.
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  const again = page.waitForEvent('download');
  await menuItem(page, /Export to Wallpaper Engine/);
  expect((await again).suggestedFilename()).toBe(`${stem}.zip`);

  // Switched off, the shortcut leads back to Plugins instead of exporting.
  await page.getByTestId('open-plugins').click();
  await page.getByTestId(`plugin-enable-${WALLPAPER}`).getByRole('switch').click();
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await menuItem(page, /Export to Wallpaper Engine/);
  await expect(page).toHaveURL(`/plugins?use=${WALLPAPER}`);
});
