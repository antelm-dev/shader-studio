'use client';

import { GROVE_PALETTES, type GrovePalette, type GrovePaletteId } from '@shadergrove/brand';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

/** Animation time, shared by the hero and the PNG export. Mutated per frame, never rendered. */
export interface GroveClock {
  time: number;
}

interface GroveState {
  readonly palette: GrovePalette;
  readonly selectPalette: (id: GrovePaletteId) => void;
  readonly mono: boolean;
  readonly toggleMono: () => void;
  /** Paused by the visitor, or by a reduced-motion preference. */
  readonly paused: boolean;
  readonly togglePaused: () => void;
  /** Back to the canonical still at time zero, paused. */
  readonly reset: () => void;
  /** Increments on every reset, so canvases know to redraw. */
  readonly resets: number;
  /** False when the hero cannot render live (no WebGL, or a lost context). */
  readonly live: boolean;
  readonly setLive: (live: boolean) => void;
  readonly clock: RefObject<GroveClock>;
}

const GroveContext = createContext<GroveState | null>(null);

export function GroveProvider({ children }: { children: ReactNode }) {
  const [paletteId, setPaletteId] = useState<GrovePaletteId>('grove');
  const [mono, setMono] = useState(false);
  const [paused, setPaused] = useState(false);
  const [resets, setResets] = useState(0);
  const [live, setLive] = useState(true);
  const clock = useRef<GroveClock>({ time: 0 });
  const palette = GROVE_PALETTES[paletteId];

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPaused(reducedMotion.matches);
    const follow = (event: MediaQueryListEvent) => setPaused(event.matches);
    reducedMotion.addEventListener('change', follow);
    return () => reducedMotion.removeEventListener('change', follow);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', palette.accent);
  }, [palette]);

  const toggleMono = useCallback(() => setMono((value) => !value), []);
  const togglePaused = useCallback(() => setPaused((value) => !value), []);
  const reset = useCallback(() => {
    clock.current.time = 0;
    setPaused(true);
    setResets((count) => count + 1);
  }, []);

  const state = useMemo<GroveState>(
    () => ({
      palette,
      selectPalette: setPaletteId,
      mono,
      toggleMono,
      paused,
      togglePaused,
      reset,
      resets,
      live,
      setLive,
      clock,
    }),
    [palette, mono, toggleMono, paused, togglePaused, reset, resets, live],
  );
  return <GroveContext value={state}>{children}</GroveContext>;
}

export function useGrove(): GroveState {
  const state = use(GroveContext);
  if (!state) throw new Error('useGrove must be used inside <GroveProvider>');
  return state;
}

/** How the current palette reads aloud. */
export function describeGrove(palette: GrovePalette, mono: boolean): string {
  return mono ? 'one flat white ink' : palette.description;
}
