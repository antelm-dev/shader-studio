// The `evaluate` callbacks below run in the page.
/// <reference lib="dom" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page, TestInfo } from '@playwright/test';

import { expect, test } from './fixtures';

// Plugin themes end to end: a real `.sgplugin.json` picked in Plugins, switched
// on, worn from the Theme menu and the editor settings, kept across a reload,
// updated, and taken away again — asserting the colours the browser actually
// computes for the chrome and for Monaco, not just a stored preference.

// Each test is one long journey through Plugins, menus, dialogs and reloads.
test.describe.configure({ timeout: 300_000 });

const fixtures = resolve(import.meta.dirname, '../../../tools/workspace/fixtures/plugins');
const AMBER_TEXT = readFileSync(resolve(fixtures, 'themes/grove-amber.sgplugin.json'), 'utf8');
const ISF_TEXT = readFileSync(resolve(fixtures, 'isf/isf.sgplugin.json'), 'utf8');

const AMBER = 'dev.shadergrove.grove-amber';
const DARK = `plugin:${AMBER}/amber-dark`;
const LIGHT = `plugin:${AMBER}/amber-light`;

/** `#rrggbb` as `getComputedStyle` reports it. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// The built-in dark theme's text and the two Grove Amber palettes.
const BUILTIN_DARK_TEXT = rgb('#e6e6e8');
const BUILTIN_PRIMARY = 'light-dark(#276c00, #71df3e)';
const AMBER_DARK = { text: rgb('#ede4d8'), toolbar: rgb('#1c1813'), menu: rgb('#2b251e') };
const AMBER_LIGHT = { text: rgb('#231b12'), toolbar: rgb('#f6efe5') };
const EDITOR = {
  amberDark: rgb('#1a1611'),
  amberLight: rgb('#fdf9f3'),
  midnight: rgb('#0b0a14'),
  studioDark: rgb('#10141c'),
};

const style = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
const textColour = (page: Page) => style(page.locator('body'), 'color');
const token = (page: Page, name: string) => style(page.locator('html'), name);
const toolbar = (page: Page) => style(page.locator('mat-toolbar.toolbar'), 'background-color');
const editorBackground = (page: Page) =>
  style(page.locator('.monaco-editor .monaco-editor-background').first(), 'background-color');

/**
 * Opens the studio with playback paused: a software-rendered shader would
 * otherwise take most of the CPU these long tests need. Kept across reloads.
 */
async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL('/plugins');
}

async function backToEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

/** Picks the file in Plugins, reviews it and installs it — which leaves it off. */
async function install(page: Page, name: string, text: string, id: string): Promise<void> {
  await page.getByTestId('plugin-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${id}`)).toBeVisible();
  await expect(page.getByTestId(`plugin-enable-${id}`).getByRole('switch')).not.toBeChecked();
}

async function setEnabled(page: Page, id: string, enabled: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${id}`).getByRole('switch');
  await toggle.click();
  await expect(toggle).toBeChecked({ checked: enabled });
}

async function openThemeMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Theme$/ }).click();
}

async function openEditor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Show editor$/ }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test('Grove Amber is installed, worn by the app and the editor, kept, and removed', async ({
  page,
}, testInfo) => {
  await openStudio(page);
  expect(await textColour(page)).toBe(BUILTIN_DARK_TEXT);

  // Installing and switching on selects nothing.
  await openPlugins(page);
  await install(page, 'grove-amber.sgplugin.json', AMBER_TEXT, AMBER);
  await setEnabled(page, AMBER, true);
  await expect(page.getByTestId(`use-theme-${AMBER}/amber-dark`)).toBeVisible();
  expect(await textColour(page)).toBe(BUILTIN_DARK_TEXT);

  await page.getByTestId(`use-theme-${AMBER}/amber-dark`).click();
  await expect(page.getByTestId(`theme-in-use-${AMBER}/amber-dark`)).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(AMBER_DARK.text);

  await backToEditor(page);
  expect(await toolbar(page)).toBe(AMBER_DARK.toolbar);
  await openEditor(page);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberDark);
  await screenshot(page, testInfo, 'amber-dark');

  // The same menu lists the installed themes beside the built-in, in an overlay
  // painted from the theme, and is driven from the keyboard.
  await openThemeMenu(page);
  const darkItem = page.getByTestId(`theme-option-${DARK}`);
  await expect(darkItem).toHaveAttribute('aria-checked', 'true');
  await expect(darkItem).toHaveAttribute('role', 'menuitemradio');
  await expect(page.getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'false');
  expect(await style(page.locator('.mat-mdc-menu-panel').last(), 'background-color')).toBe(
    AMBER_DARK.menu,
  );
  // From the keyboard alone: back out to the Theme row, into the submenu again,
  // past the built-ins, onto the light variant.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: /Theme$/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('theme-option-light')).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId(`theme-option-${LIGHT}`)).toBeFocused();
  await page.keyboard.press('Enter');

  await expect.poll(() => toolbar(page)).toBe(AMBER_LIGHT.toolbar);
  expect(await textColour(page)).toBe(AMBER_LIGHT.text);
  expect(await style(page.locator('html'), 'color-scheme')).toBe('light');
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);
  await screenshot(page, testInfo, 'amber-light');

  // A reload — the plugins load from the profile's store, the choice from the preferences.
  await page.reload();
  await expect.poll(() => toolbar(page)).toBe(AMBER_LIGHT.toolbar);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);

  // The editor settings preview another palette live, and cancelling puts it back.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Editor appearance/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Colour scheme' }).click();
  await expect(dialog.getByText('Follows the studio’s Grove Amber Light theme')).toBeVisible();
  await dialog.getByRole('radio', { name: /Midnight/ }).click();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.midnight);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberLight);

  // An explicit plugin palette for the editor, kept over the app's.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Editor appearance/ }).click();
  await dialog.getByRole('tab', { name: 'Colour scheme' }).click();
  await dialog.getByTestId(`editor-theme-${DARK}`).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.amberDark);
  expect(await toolbar(page)).toBe(AMBER_LIGHT.toolbar);

  // Removed: the built-in comes back, with the scheme it had, in the app and the editor.
  await openPlugins(page);
  await page.getByTestId(`plugin-remove-${AMBER}`).click();
  await expect(page.getByTestId(`plugin-${AMBER}`)).toHaveCount(0);
  await expect.poll(() => textColour(page)).toBe(BUILTIN_DARK_TEXT);
  await backToEditor(page);
  await expect.poll(() => editorBackground(page)).toBe(EDITOR.studioDark);
  // The stylesheet's own pair again, not a value left inline.
  expect(await token(page, '--mat-sys-primary')).toBe(BUILTIN_PRIMARY);
});

test('an update, a partial palette, an older package and another profile', async ({ page }) => {
  await openStudio(page);
  await openPlugins(page);
  await install(page, 'grove-amber.sgplugin.json', AMBER_TEXT, AMBER);
  await setEnabled(page, AMBER, true);

  // A complete palette, then one that leaves roles to the built-in: none of the first stays.
  await page.getByTestId(`use-theme-${AMBER}/amber-dark`).click();
  await expect.poll(() => token(page, '--mat-sys-secondary')).toBe('#d9b98c');
  await page.getByTestId(`use-theme-${AMBER}/amber-light`).click();
  await expect.poll(() => textColour(page)).toBe(AMBER_LIGHT.text);
  expect(await token(page, '--mat-sys-secondary')).not.toBe('#d9b98c');
  expect(await token(page, '--mat-sys-error')).not.toBe('#ffb4a8');
  expect(await token(page, '--mat-sys-error')).toContain('light-dark(');

  // A new release under the same id: installing it switches it off, so the
  // built-in is back; switched on again, its new colours are worn.
  const update = JSON.parse(AMBER_TEXT);
  update.manifest.version = '1.1.0';
  update.manifest.contributions[1].ui.primary = '#1d6b3a';
  update.manifest.contributions[1].ui['on-surface'] = '#14301f';
  await install(page, 'grove-amber-1.1.0.sgplugin.json', JSON.stringify(update), AMBER);
  await expect(page.getByText('1.1.0').first()).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(BUILTIN_DARK_TEXT);
  await setEnabled(page, AMBER, true);
  await expect.poll(() => token(page, '--mat-sys-primary')).toBe('#1d6b3a');
  expect(await textColour(page)).toBe(rgb('#14301f'));

  // A package from before themes still installs and runs beside it.
  await install(page, 'isf.sgplugin.json', ISF_TEXT, 'dev.shadergrove.isf');
  await setEnabled(page, 'dev.shadergrove.isf', true);
  await expect(page.getByTestId('import-dev.shadergrove.isf/isf-import')).toBeEnabled();
  expect(await textColour(page)).toBe(rgb('#14301f'));

  // Signed out, the anonymous profile has no such package: the built-in is
  // painted, and the choice is still there for when the account comes back.
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await expect.poll(() => textColour(page)).toBe(BUILTIN_DARK_TEXT);
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('shader-studio.preferences') ?? '{}').appThemeId,
  );
  expect(stored).toBe(LIGHT);
});
