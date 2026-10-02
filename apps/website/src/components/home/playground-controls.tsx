'use client';

import {
  createGroveRenderer,
  GROVE_PALETTE_IDS,
  GROVE_PALETTES,
  renderGrovePng,
  type GroveRenderer,
} from '@shadergrove/brand';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { useGrove } from '@/components/grove/grove-provider';

import styles from './playground.module.css';

const DEFAULT_EXPORT_NOTE = 'Transparent background · 2400 × 2400';

export function PlaygroundControls() {
  const { palette, selectPalette, mono, toggleMono, reset, live, clock } = useGrove();
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const download = async () => {
    if (!live || exporting) return;
    setExporting(true);
    // The frame on screen when the button was pressed.
    const frame = { palette, mono, time: clock.current.time };
    try {
      const { blob, width, height } = await renderGrovePng(frame);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `shadergrove-sampled-grove-${frame.palette.id}${frame.mono ? '-mono' : ''}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setExportNote(
        `Saved ${frame.palette.name}${frame.mono ? ' Mono' : ''} · transparent PNG · ${width} × ${height}`,
      );
    } catch (error) {
      console.warn('Shadergrove PNG export:', (error as Error).message);
      setExportNote('The PNG could not be saved. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <h3 id="paletteHeading" className={`micro ${styles.paletteHeading}`}>
        Choose your light
      </h3>
      <div className={styles.palettes} role="group" aria-labelledby="paletteHeading">
        {GROVE_PALETTE_IDS.map((id) => {
          const option = GROVE_PALETTES[id];
          return (
            <button
              key={id}
              type="button"
              className={styles.palette}
              aria-pressed={option.id === palette.id}
              onClick={() => selectPalette(id)}
            >
              <span className={styles.swatch} aria-hidden="true">
                {option.colors.map((color) => (
                  <i key={color} style={{ '--color': color } as CSSProperties} />
                ))}
              </span>
              <span className={styles.paletteName}>{option.name}</span>
              <span className={styles.paletteNumber}>{option.number}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.action} aria-pressed={mono} onClick={toggleMono}>
          Mono
        </button>
        <button type="button" className={styles.action} onClick={reset}>
          Reset frame
        </button>
        <button
          type="button"
          className={styles.action}
          disabled={!live || exporting}
          onClick={download}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3" />
          </svg>
          <span>{exporting ? 'Preparing PNG…' : 'Download PNG'}</span>
        </button>
      </div>
      <GroveLockups />
      <p className={styles.exportNote} aria-live="polite">
        {live
          ? (exportNote ?? DEFAULT_EXPORT_NOTE)
          : 'PNG export needs WebGL. You can still explore the palettes.'}
      </p>
    </div>
  );
}

const LOCKUP_SIZES = [26, 17, 12];

/** The canonical still at small sizes, each in its own canvas. */
function GroveLockups() {
  const { palette, mono, live } = useGrove();
  const [failed, setFailed] = useState(false);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const renderers = useRef<{ canvas: HTMLCanvasElement; renderer: GroveRenderer }[]>([]);
  const settings = useRef({ palette, mono });

  const drawAll = () => {
    const { palette, mono } = settings.current;
    renderers.current.forEach(({ renderer }) => renderer.draw({ palette, mono, time: 0 }));
  };

  useEffect(() => {
    const targets = canvases.current.filter((canvas) => canvas !== null);
    try {
      for (const canvas of targets) {
        renderers.current.push({ canvas, renderer: createGroveRenderer(canvas) });
      }
    } catch (error) {
      console.warn('Shadergrove small-size preview:', (error as Error).message);
      renderers.current.forEach(({ renderer }) => renderer.dispose());
      renderers.current = [];
      setFailed(true);
      return;
    }
    const measure = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      renderers.current.forEach(({ canvas }) => {
        const bounds = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(bounds.width * scale));
        canvas.height = Math.max(1, Math.round(bounds.height * scale));
      });
      drawAll();
    };
    const resizeObserver = new ResizeObserver(measure);
    targets.forEach((canvas) => resizeObserver.observe(canvas));
    measure();
    return () => {
      resizeObserver.disconnect();
      renderers.current.forEach(({ renderer }) => renderer.dispose());
      renderers.current = [];
    };
  }, []);

  useEffect(() => {
    settings.current = { palette, mono };
    drawAll();
  }, [palette, mono]);

  return (
    <div className={styles.lockups} aria-label="The logo at small sizes" hidden={failed || !live}>
      {LOCKUP_SIZES.map((size, index) => (
        <span key={size} className={styles.lockup} style={{ fontSize: size }}>
          <canvas
            ref={(canvas) => {
              canvases.current[index] = canvas;
            }}
            aria-hidden="true"
          />
          Shadergrove
        </span>
      ))}
    </div>
  );
}
