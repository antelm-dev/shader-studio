'use client';

import {
  createGroveRenderer,
  MARK_FILL,
  POINTER_AWAY,
  type GroveMarkPlacement,
  type GroveRenderer,
} from '@shadergrove/brand';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { describeGrove, useGrove } from '@/components/grove/grove-provider';
import { StaticGrove } from '@/components/grove/static-grove';

import styles from './hero.module.css';

/** The render loop's handle, so React effects can nudge it without re-rendering per frame. */
interface FieldEngine {
  draw(): void;
  restart(): void;
}

/** Shown without JavaScript: the static still instead of the canvas and motion control. */
const NO_SCRIPT_CSS =
  '[data-grove-field]{display:none}[data-grove-static][hidden]{display:block!important}[data-grove-motion]{display:none}';

/** Caption and hint stay readable: the field keeps this padded box around them clear. */
const CLEAR_PADDING = 8;

export function HeroStage({ copy }: { copy: ReactNode }) {
  const { palette, mono, paused, togglePaused, resets, live, setLive, clock } = useGrove();
  const [notice, setNotice] = useState<string | null>(null);
  const heroRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const artworkRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const engineRef = useRef<FieldEngine | null>(null);
  // The latest settings for the loop, which reads them every frame.
  const settings = useRef({ palette, mono, paused });

  useEffect(() => {
    settings.current = { palette, mono, paused };
    engineRef.current?.draw();
  }, [palette, mono, paused]);

  useEffect(() => {
    const hero = heroRef.current;
    const canvas = canvasRef.current;
    const artwork = artworkRef.current;
    const caption = captionRef.current;
    const hint = hintRef.current;
    if (!hero || !canvas || !artwork || !caption || !hint) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let renderer: GroveRenderer | null = null;
    let mark: GroveMarkPlacement | undefined;
    let pointer: readonly [number, number] = POINTER_AWAY;
    let target: readonly [number, number] = POINTER_AWAY;
    let visible = true;
    let frameId: number | null = null;
    let lastFrame: number | null = null;

    const draw = () => {
      const { palette, mono } = settings.current;
      renderer?.draw({ palette, mono, time: clock.current.time, pointer, mark });
    };
    const stop = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      lastFrame = null;
    };
    const schedule = () => {
      if (renderer && !settings.current.paused && visible && !document.hidden && frameId === null) {
        frameId = requestAnimationFrame(frame);
      }
    };
    const frame = (timestamp: number) => {
      frameId = null;
      if (lastFrame !== null) clock.current.time += Math.min((timestamp - lastFrame) / 1000, 0.1);
      lastFrame = timestamp;
      pointer = [
        pointer[0] + (target[0] - pointer[0]) * 0.1,
        pointer[1] + (target[1] - pointer[1]) * 0.1,
      ];
      draw();
      schedule();
    };

    // Sizes the canvas and places the square where the art column's box sits.
    const measure = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const field = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(field.width * scale));
      canvas.height = Math.max(1, Math.round(field.height * scale));
      const box = artwork.getBoundingClientRect();
      const rects = [caption, hint].map((element) => element.getBoundingClientRect());
      const left = Math.min(...rects.map((rect) => rect.left)) - CLEAR_PADDING - field.left;
      const right = Math.max(...rects.map((rect) => rect.right)) + CLEAR_PADDING - field.left;
      const top = Math.min(...rects.map((rect) => rect.top)) - CLEAR_PADDING - field.top;
      const bottom = Math.max(...rects.map((rect) => rect.bottom)) + CLEAR_PADDING - field.top;
      mark = {
        box: [
          (box.left + box.width / 2 - field.left) * scale,
          canvas.height - (box.top + box.height / 2 - field.top) * scale,
          box.width * scale,
        ],
        cssSide: box.width,
        clear: [
          left * scale,
          canvas.height - bottom * scale,
          right * scale,
          canvas.height - top * scale,
        ],
      };
      draw();
    };

    const fallback = (message: string) => {
      stop();
      renderer = null;
      setLive(false);
      setNotice(message);
    };
    const start = () => {
      try {
        renderer = createGroveRenderer(canvas);
      } catch (error) {
        console.warn('Shadergrove shader preview:', (error as Error).message);
        fallback('A still preview for this browser. Live rendering needs WebGL.');
        return;
      }
      setLive(true);
      setNotice(null);
      measure();
      schedule();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (settings.current.paused || reducedMotion.matches || event.pointerType === 'touch') return;
      const bounds = artwork.getBoundingClientRect();
      target = [
        (((event.clientX - bounds.left) / bounds.width - 0.5) * (bounds.width / bounds.height)) /
          MARK_FILL,
        (0.5 - (event.clientY - bounds.top) / bounds.height) / MARK_FILL,
      ];
    };
    const onPointerLeave = () => {
      target = POINTER_AWAY;
    };
    const onVisibilityChange = () => {
      stop();
      schedule();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      fallback(
        'The live canvas is resting. Rendering will resume when the graphics connection returns.',
      );
    };

    const resizeObserver = new ResizeObserver(() => measure());
    [canvas, artwork, caption, hint].forEach((element) => resizeObserver.observe(element));
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      stop();
      schedule();
    });
    intersectionObserver.observe(hero);
    hero.addEventListener('pointermove', onPointerMove);
    hero.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibilityChange);
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', start);

    engineRef.current = {
      draw,
      // Pausing, resuming and resetting all start from a resting pointer.
      restart() {
        pointer = POINTER_AWAY;
        target = POINTER_AWAY;
        stop();
        draw();
        schedule();
      },
    };
    start();

    return () => {
      engineRef.current = null;
      stop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', start);
      renderer?.dispose();
      renderer = null;
    };
  }, [clock, setLive]);

  useEffect(() => {
    engineRef.current?.restart();
  }, [paused, resets]);

  const still = paused || !live;
  const description = describeGrove(palette, mono);
  return (
    <section ref={heroRef} className={styles.hero} aria-labelledby="heroTitle">
      <canvas
        ref={canvasRef}
        className={styles.field}
        data-grove-field=""
        role="img"
        aria-label={`Shadergrove sampled grove: a grid of circular crowns in ${description}.`}
        hidden={!live}
      >
        A grid of circular crowns, shaped by a travelling wave.
      </canvas>
      {copy}
      <div className={styles.artColumn}>
        <div ref={artworkRef} className={styles.artwork} id="artwork">
          <div className={styles.artGrid} aria-hidden="true" />
          <StaticGrove
            className={styles.staticArt}
            data-grove-static=""
            palette={palette}
            mono={mono}
            role="img"
            aria-label={`Static sampled grove in ${description}.`}
            hidden={live}
          />
          <span className={`micro ${styles.axisLabel}`} aria-hidden="true">
            Code → colour → possibility
          </span>
        </div>
        <div ref={captionRef} className={styles.caption}>
          <span className="micro">01 / Sampled grove</span>
          <span className={`micro ${styles.liveState}`} data-paused={String(still)}>
            <span className={styles.liveDot} aria-hidden="true" />
            <span>{still ? 'Still frame' : 'In motion'}</span>
          </span>
          <button
            type="button"
            className={styles.motionButton}
            data-grove-motion=""
            aria-pressed={still}
            disabled={!live}
            onClick={togglePaused}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d={still ? 'm5 3 8 5-8 5Z' : 'M5 3v10M11 3v10'} />
            </svg>
            <span>{still ? 'Resume animation' : 'Pause animation'}</span>
          </button>
        </div>
        <p ref={hintRef} className={styles.hint}>
          {!live
            ? 'A still moment in the grove.'
            : still
              ? 'A still moment. Resume to explore.'
              : 'Move your cursor. Leave a little ripple.'}
        </p>
        <p className={styles.notice} role="status" hidden={!notice}>
          {notice}
        </p>
        <noscript>
          <p className={styles.notice}>Enable JavaScript to bring the grove to life.</p>
          <style>{NO_SCRIPT_CSS}</style>
        </noscript>
      </div>
    </section>
  );
}
