import { SMALL_MARK_CSS_SIZE } from './geometry';
import { hexToRgb, type GrovePalette } from './palettes';
import { GROVE_FRAGMENT_SHADER, GROVE_VERTEX_SHADER } from './shader';

/** A pointer far outside the mark, for frames without pointer interaction. */
export const POINTER_AWAY: readonly [number, number] = [9, 9];

/** Places the square on a larger canvas, e.g. a full-bleed hero field. */
export interface GroveMarkPlacement {
  /** Centre x, centre y (device pixels, y up) and side of the square's box. */
  readonly box: readonly [number, number, number];
  /** The box's displayed side in CSS pixels, which picks the level of detail. */
  readonly cssSide: number;
  /** A device-pixel box (x0, y0, x1, y1, y up) the field keeps clear. */
  readonly clear?: readonly [number, number, number, number];
}

export interface GroveFrame {
  readonly palette: GrovePalette;
  /** Seconds; the motion loops every twelve. */
  readonly time: number;
  /** In mark units (the square spans -0.5..0.5, y up). */
  readonly pointer?: readonly [number, number];
  readonly mono?: boolean;
  /** With a placement the grove continues past the square; without one the square is centred. */
  readonly mark?: GroveMarkPlacement;
}

export interface GroveRenderer {
  readonly gl: WebGLRenderingContext;
  draw(frame: GroveFrame): void;
  /** Frees the program and buffer; the context itself stays with its canvas. */
  dispose(): void;
}

const UNIFORMS = [
  'resolution',
  'time',
  'pointer',
  'top',
  'mid',
  'bottom',
  'mono',
  'samples',
  'mark',
  'field',
  'clear',
] as const;

/** Compiles the grove on a canvas. Throws when WebGL or the shader is unavailable. */
export function createGroveRenderer(canvas: HTMLCanvasElement): GroveRenderer {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });
  if (!gl) throw new Error('WebGL is unavailable');
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const shaders: WebGLShader[] = [];
  const release = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    shaders.forEach((shader) => gl.deleteShader(shader));
  };
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to create a shader');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed');
      }
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error('Unable to create a shader program');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, GROVE_VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, GROVE_FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Shader linking failed');
    }
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('Unable to create a vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const linked = program;
    const uniforms = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(linked, `u_${name}`)]),
    ) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;

    return {
      gl,
      draw({ palette, time, pointer = POINTER_AWAY, mono = false, mark }) {
        const { width, height } = canvas;
        gl.viewport(0, 0, width, height);
        gl.uniform2f(uniforms.resolution, width, height);
        gl.uniform1f(uniforms.time, time);
        gl.uniform2fv(uniforms.pointer, pointer);
        const [top, mid, bottom] = palette.colors.map(hexToRgb);
        gl.uniform3fv(uniforms.top, top);
        gl.uniform3fv(uniforms.mid, mid);
        gl.uniform3fv(uniforms.bottom, bottom);
        gl.uniform1f(uniforms.mono, mono ? 1 : 0);
        const box = mark ? mark.box : [width / 2, height / 2, Math.min(width, height)];
        // CSS pixels pick the simplified mark, so high-DPI favicons keep the same silhouette.
        const cssSide = mark ? mark.cssSide : canvas.clientWidth || width;
        gl.uniform3fv(uniforms.mark, box);
        gl.uniform1f(uniforms.field, mark ? 1 : 0);
        gl.uniform4fv(uniforms.clear, mark?.clear ?? [0, 0, 0, 0]);
        gl.uniform1f(uniforms.samples, cssSide < SMALL_MARK_CSS_SIZE ? 3 : 5);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export interface GrovePngOptions {
  readonly palette: GrovePalette;
  readonly time: number;
  readonly mono?: boolean;
  /** Requested side in pixels; lower GPU limits reduce it. */
  readonly size?: number;
}

export interface GrovePng {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/** Renders the square alone, without pointer or field, to a transparent PNG. */
export async function renderGrovePng({
  palette,
  time,
  mono = false,
  size = 2400,
}: GrovePngOptions): Promise<GrovePng> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  let renderer: GroveRenderer | null = null;
  try {
    renderer = createGroveRenderer(canvas);
    const { gl } = renderer;
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, ...viewport);
    if (maxSize < size) {
      canvas.width = maxSize;
      canvas.height = maxSize;
    }
    renderer.draw({ palette, time, mono });
    // Snapshot immediately after drawing; preserveDrawingBuffer is unnecessary.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Unable to create the PNG');
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    if (renderer) {
      renderer.dispose();
      renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
}
