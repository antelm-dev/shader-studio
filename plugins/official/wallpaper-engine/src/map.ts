/**
 * Maps a snapshot of the open draft to `wallpaper-web/v1` data.
 *
 * Pure data in, pure data out: the passes in render order with their composed
 * WebGL 1 fragments, the controls as Wallpaper Engine user properties, and
 * how the host's textures are sampled. The host's runtime validates the result
 * and alone writes the HTML, the player script and `project.json`.
 */
import type { ShaderControl, ShaderParams } from '@shadergrove/shared/model';
import { buildFullGlsl, expandMacros } from '@shadergrove/shared/glsl-export';
import { composePass } from '@shadergrove/shared/pass-source';
import type {
  ProjectExportInput,
  WallpaperWebData,
  WallpaperWebPass,
  WallpaperWebProperty,
} from '@shadergrove/shared/plugin';
import { resolvePassOrder } from '@shadergrove/shared/project';

export const POST_PROCESSING_WARNING =
  'Post-processing is not included; the exported wallpaper renders the shader passes without it.';
const MAX_PROPERTIES = 64;

const EXTENSION_DIRECTIVE = /^\s*#extension[^\r\n]*$/gm;
const FLOAT_PRECISION = /^\s*precision\s+(?:lowp|mediump|highp)\s+float\s*;/m;
const DERIVATIVE_CALL = /\b(?:dFdx|dFdy|fwidth)\s*\(/;

/** Put WebGL 1 directives and float precision before generated uniform declarations. */
export function prepareWallpaperFragment(source: string): string {
  const extensions: string[] = source.match(EXTENSION_DIRECTIVE) ?? [];
  if (
    DERIVATIVE_CALL.test(source) &&
    !extensions.some((line) => line.includes('GL_OES_standard_derivatives'))
  ) {
    extensions.unshift('#extension GL_OES_standard_derivatives : enable');
  }
  const precision = source.match(FLOAT_PRECISION)?.[0].trim() ?? 'precision highp float;';
  const body = source.replace(EXTENSION_DIRECTIVE, '').replace(FLOAT_PRECISION, '').trimStart();
  return [...extensions.map((line) => line.trim()), precision, body].join('\n');
}

export function mapWallpaper(input: ProjectExportInput): {
  data: WallpaperWebData;
  warnings: string[];
} {
  const warnings: string[] = [];
  const ordered = resolvePassOrder(input.project);
  if (ordered.errors.length > 0) {
    throw new Error(ordered.errors.map((error) => error.message).join(' '));
  }
  const passes: WallpaperWebPass[] = ordered.order.map((pass) => {
    const composed = composePass(input.project, pass);
    if (composed.errors.length > 0) {
      throw new Error(composed.errors.map((error) => error.message).join(' '));
    }
    return {
      id: pass.id,
      name: pass.name.slice(0, 64) || 'Pass',
      kind: pass.kind === 'image' ? 'image' : 'buffer',
      fragment: prepareWallpaperFragment(buildFullGlsl(composed.source, input.controls)),
      channels: [...pass.channels],
      resolution: pass.resolution,
      filter: pass.filter,
      wrap: pass.wrap,
    };
  });

  const properties = wallpaperProperties(input.controls, input.params, warnings);
  const channels = input.channels.flatMap((channel, slot) =>
    channel.present
      ? [
          {
            slot: slot as 0 | 1 | 2 | 3,
            wrap: channel.wrap,
            filter: channel.filter,
            flipY: channel.flipY,
          },
        ]
      : [],
  );
  if (input.postProcessingActive) warnings.push(POST_PROCESSING_WARNING);

  const title = input.name.trim().slice(0, 64) || 'Shadergrove wallpaper';
  const author = input.author?.trim().slice(0, 64);
  return {
    data: {
      title,
      ...(author ? { author } : {}),
      vertex: expandMacros(input.project.vertex),
      passes,
      properties,
      channels,
    },
    warnings,
  };
}

/**
 * One user property per control, keyed `ss<key>` in lowercase letters and
 * digits — unique however the keys differ only in case or punctuation — with
 * the draft's current value as its default.
 */
export function wallpaperProperties(
  controls: readonly ShaderControl[],
  params: ShaderParams,
  warnings: string[],
): WallpaperWebProperty[] {
  const used = new Set<string>();
  const properties: WallpaperWebProperty[] = [];
  for (const control of controls) {
    if (properties.length >= MAX_PROPERTIES) {
      warnings.push(`Only the first ${MAX_PROPERTIES} controls become wallpaper properties.`);
      break;
    }
    const normalized = control.key
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 56);
    const base = `ss${normalized || 'control'}`;
    let key = base;
    for (let suffix = 2; used.has(key); suffix++) key = `${base}${suffix}`;
    used.add(key);
    const common = {
      key,
      uniform: control.key,
      text: (control.label ?? control.key).slice(0, 64) || control.key,
      order: properties.length,
    };
    const value = params[control.key] ?? control.default;
    switch (control.type) {
      case 'number': {
        const step =
          control.step && control.step > 0 ? control.step : niceStep(control.min, control.max);
        const precision = Math.min(6, decimals(step));
        const current =
          typeof value === 'number' && Number.isFinite(value) ? value : control.default;
        properties.push({
          ...common,
          type: 'slider',
          min: control.min,
          max: control.max,
          step,
          precision,
          value: Math.min(control.max, Math.max(control.min, current)),
        });
        break;
      }
      case 'boolean':
        properties.push({ ...common, type: 'bool', value: value === true });
        break;
      case 'color':
        properties.push({ ...common, type: 'color', value: wallpaperColor(String(value)) });
        break;
      case 'select': {
        const options = Object.entries(control.options)
          .filter(([, option]) => /^-?\d{1,9}(?:\.\d{1,6})?$/.test(String(option)))
          .slice(0, 64)
          .map(([label, option]) => ({
            label: label.slice(0, 64) || String(option),
            value: String(option),
          }));
        if (options.length === 0) {
          warnings.push(
            `"${common.text}" has no options Wallpaper Engine can show; it was left out.`,
          );
          used.delete(key);
          continue;
        }
        const current = String(value);
        properties.push({
          ...common,
          type: 'combo',
          options,
          value: options.some((option) => option.value === current) ? current : options[0]!.value,
        });
        break;
      }
    }
  }
  return properties;
}

/** `#rrggbb` (or `#rgb`) as Wallpaper Engine's `"r g b"`, each 0–1 with at most four decimals. */
export function wallpaperColor(value: string): string {
  let hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map((part) => part + part).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) hex = 'ffffff';
  const number = Number.parseInt(hex, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
    .map((channel) => String(Number((channel / 255).toFixed(4))))
    .join(' ');
}

function niceStep(min: number, max: number): number {
  const range = Math.abs(max - min);
  if (range === 0) return 1;
  return 10 ** Math.floor(Math.log10(range / 100));
}

function decimals(value: number): number {
  const text = String(value);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? text.split('.')[1]!.length : 0;
}
