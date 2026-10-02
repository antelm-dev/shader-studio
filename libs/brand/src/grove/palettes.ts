/** Linear RGB in 0..1, as the shader receives it. */
export type Rgb = readonly [number, number, number];

export interface GrovePalette {
  readonly id: GrovePaletteId;
  readonly name: string;
  readonly number: string;
  /** The page accent that goes with this palette. */
  readonly accent: string;
  /** Lime-side, middle and violet-side colours of the diagonal gradient, as #rrggbb. */
  readonly colors: readonly [string, string, string];
  readonly description: string;
}

export const GROVE_PALETTE_IDS = ['grove', 'forest', 'afterglow'] as const;
export type GrovePaletteId = (typeof GROVE_PALETTE_IDS)[number];

export const GROVE_PALETTES: Readonly<Record<GrovePaletteId, GrovePalette>> = {
  grove: {
    id: 'grove',
    name: 'Grove',
    number: '01',
    accent: '#9dff3e',
    colors: ['#9dff3e', '#35dcc4', '#8143f4'],
    description: 'lime, cyan, and violet',
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    number: '02',
    accent: '#35dcc4',
    colors: ['#e4e83a', '#35dcc4', '#0d7367'],
    description: 'turquoise, forest green, and deep teal, with a lime highlight',
  },
  afterglow: {
    id: 'afterglow',
    name: 'Afterglow',
    number: '03',
    accent: '#c4a7ff',
    colors: ['#93ff3e', '#2bcbea', '#ca6bff'],
    description: 'luminous green, cyan, and soft violet',
  },
};

export const MONO_INK: Rgb = [0.95, 0.95, 0.93];

export function hexToRgb(hex: string): Rgb {
  const channel = (start: number) => parseInt(hex.slice(start, start + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}
