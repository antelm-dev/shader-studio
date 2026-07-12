---
name: verify
description: Build, run and drive Shader Studio in a real browser to confirm a change works. Use when verifying UI, layout, editor, renderer or preferences behaviour in this repo.
---

# Verifying Shader Studio

The app is an Angular 22 (zoneless, signals, SSR) shader browser/editor. Almost
every change lands somewhere visible, so the surface is **pixels in a browser** —
drive it, don't just run `pnpm test`.

## Launch

```bash
pnpm dev --port 4321      # ng serve, SSR dev server; ready in ~10s
```

Wait for `➜  Local:   http://localhost:4321/` in the output. The API and the seed
shaders are served by the same process — no separate backend to start.

The shader collection seeds itself, so a fresh browser profile lands on **Aurora
Veil** (17 controls, 3 presets) with four more shaders in the browser. That makes
control/preset counts stable enough to assert on.

## Drive

Playwright is **not** a project dependency — install it in a scratch dir rather
than adding it to `package.json`:

```bash
cd <scratchpad> && npm init -y && npm install playwright
npx playwright install chromium
```

Then drive `http://localhost:4321/` with `chromium.launch()`. Useful handles:

| What | Selector |
| --- | --- |
| Shader browser drawer | `mat-sidenav.drawer` |
| Inspector rail | `aside.inspector` |
| Inspector tabs | `aside.inspector [role="tab"]` |
| Panel separators | `app-resize-handle.browser-handle` / `.inspector-handle` |
| Collapsed-inspector button | `button.inspector-rail` |
| Editor | `app-editor-shell`, `.monaco-editor` |
| Generated parameter rows | `.lil-gui .lil-controller` |

Persisted UI state is one `localStorage` key — read or corrupt it directly to
test sanitizing and restore:

```js
JSON.parse(localStorage.getItem('shader-studio.preferences'))
```

Open the docked editor via the toolbar: `button[aria-label="More actions"]` →
menu item `Show editor`. Monaco takes ~2s to appear.

## Gotchas

- **Give lil-gui ~1.2s after load.** It is imported dynamically (it injects a
  stylesheet, which would throw during SSR), so the Controls tab is empty for a
  moment after `networkidle`.
- **CSP errors in the console are pre-existing noise** — two inline-script
  violations on every page load. Not your change.
- **Editing a file mid-run breaks the run.** A `vite-error-overlay` element
  intercepts all pointer events, and Playwright reports it as "element
  intercepts pointer events" rather than as a compile error. Check the dev
  server log before believing a click failure.
- **Drag gestures need several `mouse.move` steps** — one jump does not produce
  the `pointermove` stream the resize handles listen for. Off-viewport and
  negative coordinates are delivered fine, so dragging by ±3000px is a valid way
  to test clamping.
- **Material measures, it does not read bindings.** `MatDrawerContainer` derives
  the content margin from the drawer's `offsetWidth`, so anything that changes a
  drawer's width must call `updateContentMargins()` from an `afterRenderEffect`,
  not an `effect` — a plain effect runs before the binding is flushed and
  measures the old width. Symptom: the panel resizes once, then the content
  overlaps it.

## Worth driving after a layout change

Resize and collapse both panels; reload and confirm widths persisted; switch
inspector tabs and confirm the lil-gui instance survives (`preserveContent`);
open the docked editor and confirm Monaco still mounts; shrink the viewport
below 900px, where the rails stack and the separators are hidden.
