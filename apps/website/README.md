# Shadergrove website

The public site: a Next.js 16 App Router app, exported as static files. Marketing pages live
in the `(marketing)` route group, which leaves room for docs, a blog and a changelog.

```bash
pnpm dev:website     # next dev on http://localhost:3000
pnpm build:website   # static export to apps/website/out
pnpm nx run @shadergrove/website:start   # build, then serve out/
pnpm nx run @shadergrove/website:typecheck
```

Open the dev server on `localhost`: Next blocks its dev resources for other origins.

## The grove

The brand mark and hero come from `@shadergrove/brand` (`libs/brand`), which has no framework
code, so the studio can use it too:

- `shader.ts`: the GLSL. `renderer.ts`: `createGroveRenderer(canvas)` and `renderGrovePng`.
- `geometry.ts`: the canonical still (time zero) for SVGs, which also renders on the server.
  The header mark, the favicon (`app/icon.svg/route.ts`, prerendered) and the no-WebGL
  fallback are generated from it.
- `palettes.ts`: Grove, Forest and Afterglow.

In the site, `GroveProvider` holds palette, mono and pause. Animation time, the pointer and
the render loop stay in refs inside `HeroStage`, so React does not re-render per frame.

## Behaviour

- One full-bleed canvas behind the hero draws the 5 × 5 square, placed on the art column's
  box, and the grove around it, which shrinks with distance and keeps the caption and hint
  clear.
- Rendering pauses off screen, in background tabs and for reduced motion. Pause, Reset frame
  (time zero, paused), palettes and Mono work as in the mock.
- Download PNG renders the square alone to a transparent 2400 × 2400 PNG.
- Without WebGL, after a lost context, or without JavaScript, the static SVG still appears;
  a restored context resumes live rendering.

## Known issue

On Windows, `next build` 16.3 writes route-group prefetch files under a backslash path, so the
router's background segment prefetch 404s when the export is served locally. Pages still load
and navigate. Linux builds (CI, deployment) write the expected file names.

`design/` holds the HTML mock the site was ported from.
