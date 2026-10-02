# Shadergrove — Sampled grove

Open `index.html` directly in a modern browser. This standalone showcase needs
no build, dependencies, or network requests to render. The main call to action
links to the repository's quick-start guide.

The hero uses **direction 01, Sampled grove**, from `directions.html`: a 5 × 5
grid of circular crowns whose radii sample a travelling wave. The lime, cyan,
and violet palette connects the grove to the shader workspace. Pointer proximity
locally grows the crowns. The layout stacks on narrow screens.

Behind the whole hero, the grid continues past the square: there the wave no
longer applies, and crowns shrink with distance from the mark until they are
specks behind the headline. One full-bleed canvas draws both; the art column
only decides where the square sits. Lockups and the PNG export keep the square
alone.

## Interaction and identity playground

- **Pause animation** freezes the current pose. **Reset frame** returns to the
  canonical pose at time zero and pauses.
- **Grove**, **Forest**, and **Afterglow** change the palette while preserving
  the geometry. **Mono** uses a single flat white ink.
- **Download PNG** exports the current time and palette as a transparent
  2400 × 2400 image, without the pointer effect, page background, guides, or
  wordmark. Lower GPU limits reduce both dimensions together.
- The small wordmarks show the canonical still. Below 44 CSS pixels, the mark
  simplifies to 3 × 3 with a larger minimum dot radius. The favicon and header
  use the same simplified motif.

The inline `fragmentShader` is shared by the hero, small previews, and export.
Motion repeats every 12 seconds. Rendering pauses when the artwork is outside
the viewport or the document is hidden, and starts paused for reduced motion.

An inline SVG preserves the canonical grove when WebGL is unavailable or its
context is lost. Palette and mono controls still work in this mode; animation
and PNG export are disabled. Context restoration reinitializes the renderer.
The SVG is also visible without JavaScript.

This page is independent of the studio app and its Nx build. `directions.html`
keeps all eight identity explorations for comparison.
