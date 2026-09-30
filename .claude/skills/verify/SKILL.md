---
name: verify
description: Build, run and drive Shadergrove in a real browser to confirm a change works. Use when verifying UI, layout, editor, renderer or preferences behaviour in this repo.
---

# Verifying Shadergrove

The app is an Angular 22 (zoneless, signals, SSR) shader browser/editor. Almost
every change lands somewhere visible, so the surface is **pixels in a browser** —
drive it, don't just run `pnpm test`.

## Launch

The library is per-account, so the server needs the same throwaway auth setup
the smoke test uses (`tools/workspace/src/smoke.ts`):

```bash
cd apps/web
SHADER_DATA_DIR=<scratch dir> BETTER_AUTH_URL=http://127.0.0.1:4321 \
AUTH_REQUIRE_VERIFIED_EMAIL=0 AUTH_CHECK_COMPROMISED_PASSWORDS=0 \
  pnpm exec ng serve --port=4321 --host=127.0.0.1 --no-hmr
```

Wait for `➜  Local:   http://127.0.0.1:4321/`. The API and the seed shaders are
served by the same process — no separate backend to start. `--no-hmr` matters:
see the hot-update gotcha below.

A new account lands on **Aurora Veil** (17 controls, 3 presets) with four more
seeded shaders in the browser, which makes control and preset counts stable
enough to assert on.

## Drive

Playwright is a dev dependency of `tools/workspace` — resolve it from there
rather than installing a copy:

```js
import { createRequire } from 'node:module';
const { chromium } = createRequire('<repo>/tools/workspace/package.json')('playwright');
const browser = await chromium.launch({ channel: 'chromium' }); // see the headless gotcha
```

Sign up once through the API, then reuse the session:

```js
await context.request.post(`${BASE}/api/auth/sign-up/email`, {
  headers: { origin: BASE },
  data: { name: 'Test', email: 'test@example.test', password: '…' },
});
await context.storageState({ path: 'session.json' }); // later: newContext({ storageState })
```

Useful handles:

| What                       | Selector                                                       |
| -------------------------- | -------------------------------------------------------------- |
| Toolbar, transport         | `mat-toolbar.toolbar`, `app-transport-bar`                     |
| Shader browser drawer      | `mat-sidenav.drawer`, rows `app-shader-browser .shader-row`    |
| Inspector                  | `app-inspector-shell`, tabs `app-inspector-shell [role="tab"]` |
| Collapsed-inspector button | `button.inspector-rail`                                        |
| Editor                     | `app-editor-shell`, `.monaco-editor`                           |
| Generated parameter rows   | `.lil-gui .lil-controller`                                     |
| Command palette            | `app-command-palette` (Ctrl+K, or the toolbar's search button) |
| Zen mode                   | `.shell.zen`, exit button `.zen-exit`                          |

Persisted UI state is one `localStorage` key. Seed it from
`context.addInitScript` rather than `evaluate` + reload: the app writes its own
preferences on the first load and the two race.

```js
JSON.parse(localStorage.getItem('shader-studio.preferences'));
```

Open the docked editor from the toolbar's `Show editor` button, or
`button[aria-label="More actions"]` → `Show editor`. Monaco takes ~2s to appear.

## Gotchas

- **Give lil-gui ~1.2s after load.** It is imported dynamically (it injects a
  stylesheet, which would throw during SSR), so the Controls tab is empty for a
  moment after `networkidle`.
- **The app re-renders on its own schedule** (zoneless). Poll for an attribute
  or text after a key press or click instead of reading it on the next line.
- **Use full Chromium for screenshots** (`channel: 'chromium'`). Playwright's
  default headless shell paints black rectangles where the shader canvas sits
  behind the opaque panels; a real compositor does not.
- **Template hot updates break hydration.** With HMR on, a template edit patches
  the client while the first bundle stays stale, and the next load logs
  `NG0500` hydration errors that are not real. Serve with `--no-hmr`, and
  restart the server after switching branches — the watcher can miss it.
- **An unverified account is read-only.** Writes (save, thumbnails, presets)
  answer `401` and open the sign-in dialog. To exercise them, set
  `email_verified = 1` for the test user in `<SHADER_DATA_DIR>/shader-studio.sqlite`.
- **Repeated sign-ins hit the auth rate limit** (`429`). Reuse one session.
- **CSP errors in the console are pre-existing noise** — two inline-script
  violations on every page load. Not your change.
- **Editing a file mid-run breaks the run.** A `vite-error-overlay` element
  intercepts all pointer events, and Playwright reports it as "element
  intercepts pointer events" rather than as a compile error. Check the dev
  server log before believing a click failure.
- **Drag gestures need several `mouse.move` steps** — one jump does not produce
  the `pointermove` stream the resize handles and label scrubbing listen for.
  Off-viewport and negative coordinates are delivered fine, so dragging by
  ±3000px is a valid way to test clamping.
- **Material measures, it does not read bindings.** `MatDrawerContainer` derives
  the content margin from the drawer's `offsetWidth`, so anything that changes a
  drawer's width must call `updateContentMargins()` from an `afterRenderEffect`,
  not an `effect` — a plain effect runs before the binding is flushed and
  measures the old width. Symptom: the panel resizes once, then the content
  overlaps it.
- **The desktop build only runs packaged.** Its main process reads i18n and
  examples from `process.resourcesPath`, so use `pnpm pack:desktop` and launch
  `release/win-unpacked/shadergrove.exe` (Playwright `_electron`, with a fresh
  `--user-data-dir`).

## Worth driving after a layout change

Resize and collapse both panels; reload and confirm widths persisted; switch
inspector tabs and confirm the lil-gui instance survives (the panels are hidden,
never destroyed); open the docked editor and confirm Monaco still mounts; enter
and leave zen mode; shrink the viewport below 900px, where the rails stack and
the separators are hidden; and emulate a phone (`isMobile`, `hasTouch`) to check
that touch targets kept their size.
