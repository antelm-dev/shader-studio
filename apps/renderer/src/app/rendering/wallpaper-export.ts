import type {
  ParamValue,
  ShaderControl,
  ShaderParams,
  ShaderPayload,
  TextureChannelPayload,
} from '@shader-studio/shared/model';
import { buildFullGlsl, expandMacros } from '@shader-studio/shared/glsl-export';
import { composePass } from '@shader-studio/shared/pass-source';
import {
  resolvePassOrder,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { mimeFromExt } from '@shader-studio/shared/validate';

export interface WallpaperExportInput {
  name: string;
  author?: string;
  project: ShaderProject;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  channels: ShaderPayload['channels'];
  bloomEnabled: boolean;
}

interface WallpaperChannel {
  path: string | null;
  wrap: TextureChannelPayload['wrap'];
  filter: TextureChannelPayload['filter'];
  flipY: boolean;
}

interface WallpaperPass {
  id: string;
  name: string;
  kind: 'image' | 'buffer';
  fragment: string;
  channels: RenderPass['channels'];
  resolution: RenderPass['resolution'];
  filter: RenderPass['filter'];
  wrap: RenderPass['wrap'];
}

type WallpaperControl = ShaderControl & { wallpaperKey: string };

interface WallpaperProject {
  format: 'shader-studio-wallpaper/v1';
  name: string;
  author?: string;
  vertex: string;
  passes: WallpaperPass[];
  controls: WallpaperControl[];
  params: ShaderParams;
  channels: WallpaperChannel[];
}

export interface WallpaperDocument {
  document: Blob;
  filename: string;
  warnings: readonly string[];
}

function safeStem(value: string): string {
  const stem = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return stem || 'shader-wallpaper';
}

function propertyKeys(controls: readonly ShaderControl[]): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();

  for (const control of controls) {
    const normalized = control.key.replace(/[^a-zA-Z0-9]/g, '');
    const base = normalized ? `ss${normalized}` : 'sscontrol';
    let key = base;
    let suffix = 2;
    while (used.has(key.toLowerCase())) key = `${base}${suffix++}`;
    used.add(key.toLowerCase());
    keys.set(control.key, key);
  }

  return keys;
}

function javascriptAssignment(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return `window.__SHADER_STUDIO_WALLPAPER__ = ${json};\n`;
}

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

function indexHtml(name: string, project: WallpaperProject): string {
  const escaped = name
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escaped}</title>
    <style>
      html, body, canvas { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #0a0c10; }
      canvas { display: block; touch-action: none; }
      #error { position: fixed; inset: 0; box-sizing: border-box; padding: 24px; color: #ffb4ab;
        background: #111; font: 14px/1.5 monospace; white-space: pre-wrap; overflow: auto; }
    </style>
  </head>
  <body>
    <canvas id="shader" aria-label="${escaped}"></canvas>
    <pre id="error" hidden></pre>
    <script>${javascriptAssignment(project)}</script>
    <script>${WALLPAPER_RUNTIME}</script>
  </body>
</html>
`;
}

/**
 * Packages one shader as a dependency-free live WebGL document. Runtime,
 * project and textures are inline so the downloaded HTML itself can be dropped
 * onto Wallpaper Engine's Create Wallpaper target without an extraction step.
 */
export function buildWallpaperDocument(input: WallpaperExportInput): WallpaperDocument {
  const ordered = resolvePassOrder(input.project);
  if (ordered.errors.length > 0) {
    throw new Error(ordered.errors.map((error) => error.message).join(' '));
  }

  const passes: WallpaperPass[] = ordered.order.map((pass) => {
    const composed = composePass(input.project, pass);
    if (composed.errors.length > 0) {
      throw new Error(composed.errors.map((error) => error.message).join(' '));
    }
    return {
      id: pass.id,
      name: pass.name,
      kind: pass.kind === 'image' ? 'image' : 'buffer',
      fragment: prepareWallpaperFragment(buildFullGlsl(composed.source, input.controls)),
      channels: pass.channels,
      resolution: pass.resolution,
      filter: pass.filter,
      wrap: pass.wrap,
    };
  });

  const keys = propertyKeys(input.controls);
  const controls = input.controls.map(
    (control): WallpaperControl => ({ ...control, wallpaperKey: keys.get(control.key)! }),
  );
  const params = Object.fromEntries(
    input.controls.map((control) => [
      control.key,
      (input.params[control.key] ?? control.default) as ParamValue,
    ]),
  );

  const channels: WallpaperChannel[] = input.channels.map((channel) => ({
    path:
      channel.ext && channel.data
        ? `data:${mimeFromExt(channel.ext)};base64,${channel.data}`
        : null,
    wrap: channel.wrap,
    filter: channel.filter,
    flipY: channel.flipY,
  }));
  const project: WallpaperProject = {
    format: 'shader-studio-wallpaper/v1',
    name: input.name,
    ...(input.author ? { author: input.author } : {}),
    vertex: expandMacros(input.project.vertex),
    passes,
    controls,
    params,
    channels,
  };

  const warnings = input.bloomEnabled
    ? [
        'Bloom is not included; the exported wallpaper renders the shader passes without post-processing.',
      ]
    : [];

  return {
    document: new Blob([indexHtml(input.name, project)], { type: 'text/html' }),
    filename: `${safeStem(input.name)}-wallpaper-engine.html`,
    warnings,
  };
}

/** A small native-WebGL player kept as source so the exported ZIP has no CDN dependency. */
export const WALLPAPER_RUNTIME = String.raw`(function () {
  "use strict";

  var project = window.__SHADER_STUDIO_WALLPAPER__;
  var canvas = document.getElementById("shader");
  var errorBox = document.getElementById("error");
  var gl = canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: false });
  if (!project || !gl) return fail("This wallpaper needs WebGL 1 support.");

  var identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0, 0,  1, -1, 0, 1, 0,  -1, 1, 0, 0, 1,
    -1,  1, 0, 0, 1,  1, -1, 0, 1, 0,   1, 1, 0, 1, 1
  ]), gl.STATIC_DRAW);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);

  var needsDerivatives = project.passes.some(function (pass) {
    return /\b(?:dFdx|dFdy|fwidth)\s*\(/.test(pass.fragment);
  });
  if (needsDerivatives && !gl.getExtension("OES_standard_derivatives")) {
    return fail("This shader needs the OES_standard_derivatives WebGL extension.");
  }

  var placeholder = textureFromPixel();
  var imageTextures = project.channels.map(function (channel) {
    return channel.path ? loadTexture(channel) : placeholder;
  });
  var programs = project.passes.map(compilePass);
  var buffers = new Map();
  var previous = new Map();
  var params = Object.assign({}, project.params);
  var mouse = [-1000, -1000, 0, 0];
  var velocity = [0, 0];
  var lastPointer = null;
  var lastPointerAt = 0;
  var clicks = new Float32Array(24 * 3);
  var nextClick = 0;
  var time = 0;
  var lastFrame = performance.now();
  var targetType = chooseTargetType();

  project.passes.forEach(function (pass) {
    if (pass.kind === "buffer") buffers.set(pass.id, makeBuffer(pass));
  });
  resize();
  window.addEventListener("resize", resize);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", function () { mouse[2] = 0; });
  canvas.addEventListener("pointerleave", pointerLeave);
  canvas.addEventListener("contextmenu", function (event) { event.preventDefault(); });

  window.wallpaperPropertyListener = {
    applyUserProperties: function (properties) {
      project.controls.forEach(function (control) {
        var property = properties[control.wallpaperKey];
        if (!property) return;
        params[control.key] = property.value;
      });
    }
  };

  requestAnimationFrame(frame);

  function fail(message) {
    if (errorBox) { errorBox.hidden = false; errorBox.textContent = String(message); }
    console.error("[Shader Studio wallpaper]", message);
  }

  function declares(source, name) {
    return new RegExp("\\b(?:uniform|varying|attribute)\\b[^;]*\\b" + name + "\\b").test(source);
  }

  function vertexSource(source) {
    var declarations = [];
    if (!/^\\s*precision\\s+\\w+\\s+float\\s*;/m.test(source)) declarations.push("precision highp float;");
    [["position", "attribute vec3 position;"], ["uv", "attribute vec2 uv;"],
     ["modelMatrix", "uniform mat4 modelMatrix;"], ["modelViewMatrix", "uniform mat4 modelViewMatrix;"],
     ["projectionMatrix", "uniform mat4 projectionMatrix;"], ["viewMatrix", "uniform mat4 viewMatrix;"],
     ["normalMatrix", "uniform mat3 normalMatrix;"]].forEach(function (entry) {
      if (!declares(source, entry[0])) declarations.push(entry[1]);
    });
    return declarations.join("\n") + "\n" + source;
  }

  function compile(type, source, label) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(label + " failed to compile:\n" + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function compilePass(pass) {
    try {
      var program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource(project.vertex), "Vertex shader"));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, pass.fragment, pass.name));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      return { pass: pass, program: program, uniforms: new Map() };
    } catch (error) {
      fail(error && error.stack ? error.stack : error);
      throw error;
    }
  }

  function location(compiled, name) {
    if (!compiled.uniforms.has(name)) compiled.uniforms.set(name, gl.getUniformLocation(compiled.program, name));
    return compiled.uniforms.get(name);
  }

  function set1f(compiled, name, value) { var at = location(compiled, name); if (at !== null) gl.uniform1f(at, Number(value)); }
  function set1i(compiled, name, value) { var at = location(compiled, name); if (at !== null) gl.uniform1i(at, value ? 1 : 0); }
  function set2f(compiled, name, x, y) { var at = location(compiled, name); if (at !== null) gl.uniform2f(at, x, y); }
  function set4f(compiled, name, a, b, c, d) { var at = location(compiled, name); if (at !== null) gl.uniform4f(at, a, b, c, d); }

  function bindGeometry(compiled) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    var position = gl.getAttribLocation(compiled.program, "position");
    if (position >= 0) { gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0); }
    var uv = gl.getAttribLocation(compiled.program, "uv");
    if (uv >= 0) { gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 20, 12); }
    ["modelMatrix", "modelViewMatrix", "projectionMatrix", "viewMatrix"].forEach(function (name) {
      var at = location(compiled, name); if (at !== null) gl.uniformMatrix4fv(at, false, identity);
    });
    var normal = location(compiled, "normalMatrix");
    if (normal !== null) gl.uniformMatrix3fv(normal, false, new Float32Array([1,0,0,0,1,0,0,0,1]));
  }

  function color(value) {
    if (typeof value === "string" && value.indexOf(" ") >= 0) return value.split(/\\s+/).map(Number).slice(0, 3);
    var hex = String(value || "#ffffff").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (part) { return part + part; }).join("");
    var number = parseInt(hex, 16);
    return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
  }

  function applyUniforms(compiled, width, height) {
    set1f(compiled, "iTime", time);
    set2f(compiled, "iResolution", width, height);
    set4f(compiled, "iMouse", mouse[0], mouse[1], mouse[2], mouse[3]);
    set2f(compiled, "iMouseVel", velocity[0], velocity[1]);
    var clickAt = location(compiled, "u_clickData");
    if (clickAt !== null) gl.uniform3fv(clickAt, clicks);
    project.controls.forEach(function (control) {
      var value = params[control.key];
      var at = location(compiled, "u_" + control.key);
      if (at === null) return;
      if (control.type === "boolean") gl.uniform1i(at, value ? 1 : 0);
      else if (control.type === "color") gl.uniform3fv(at, color(value));
      else gl.uniform1f(at, Number(value));
    });
  }

  function resolve(binding) {
    if (!binding || binding.kind === "none") return placeholder;
    if (binding.kind === "texture") return imageTextures[binding.slot] || placeholder;
    var target = buffers.get(binding.passId);
    if (!target) return placeholder;
    if (binding.feedback) return previous.get(binding.passId) || target.targets[target.front].texture;
    return target.targets[target.front].texture;
  }

  function draw(compiled, framebuffer, width, height) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compiled.program);
    bindGeometry(compiled);
    applyUniforms(compiled, width, height);
    compiled.pass.channels.forEach(function (binding, index) {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, resolve(binding));
      var at = location(compiled, "iChannel" + index);
      if (at !== null) gl.uniform1i(at, index);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function frame(now) {
    var delta = Math.min((now - lastFrame) / 1000, 1 / 20);
    lastFrame = now;
    time += delta;
    velocity[0] *= Math.pow(0.9, delta * 60);
    velocity[1] *= Math.pow(0.9, delta * 60);
    resize();
    previous.clear();
    buffers.forEach(function (target, id) { previous.set(id, target.targets[target.front].texture); });
    programs.forEach(function (compiled) {
      if (compiled.pass.kind !== "buffer") return;
      var target = buffers.get(compiled.pass.id);
      var write = target.front === 0 ? 1 : 0;
      draw(compiled, target.targets[write].framebuffer, target.width, target.height);
      target.front = write;
    });
    var image = programs[programs.length - 1];
    draw(image, null, canvas.width, canvas.height);
    requestAnimationFrame(frame);
  }

  function targetSize(pass) {
    if (pass.resolution.mode === "fixed") return [pass.resolution.width, pass.resolution.height];
    if (pass.resolution.mode === "scaled") return [
      Math.max(1, Math.round(canvas.width * pass.resolution.scale)),
      Math.max(1, Math.round(canvas.height * pass.resolution.scale))
    ];
    return [canvas.width, canvas.height];
  }

  function resize() {
    var ratio = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    var height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width; canvas.height = height;
    project.passes.forEach(function (pass) {
      if (pass.kind !== "buffer") return;
      var size = targetSize(pass);
      var old = buffers.get(pass.id);
      if (old) destroyBuffer(old);
      buffers.set(pass.id, makeBuffer(pass, size));
    });
  }

  function makeBuffer(pass, knownSize) {
    var size = knownSize || targetSize(pass);
    return { pass: pass, width: size[0], height: size[1], front: 0,
      targets: [attachment(pass, size[0], size[1]), attachment(pass, size[0], size[1])] };
  }

  function destroyBuffer(target) {
    target.targets.forEach(function (entry) { gl.deleteFramebuffer(entry.framebuffer); gl.deleteTexture(entry.texture); });
  }

  function attachment(pass, width, height) {
    var made = makeAttachment(pass, width, height, targetType);
    if (!made.complete && targetType !== gl.UNSIGNED_BYTE) {
      gl.deleteFramebuffer(made.framebuffer); gl.deleteTexture(made.texture);
      made = makeAttachment(pass, width, height, gl.UNSIGNED_BYTE);
    }
    return made;
  }

  function makeAttachment(pass, width, height, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
    sampling(pass, width, height, type);
    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture: texture, framebuffer: framebuffer,
      complete: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE };
  }

  function chooseTargetType() {
    var half = gl.getExtension("OES_texture_half_float");
    var colorBuffer = gl.getExtension("EXT_color_buffer_half_float");
    gl.getExtension("OES_texture_half_float_linear");
    return half && colorBuffer ? half.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
  }

  function sampling(spec, width, height, type) {
    var powerOfTwo = isPowerOfTwo(width) && isPowerOfTwo(height);
    var wrap = !powerOfTwo || spec.wrap === "clamp" ? gl.CLAMP_TO_EDGE
      : spec.wrap === "repeat" ? gl.REPEAT : gl.MIRRORED_REPEAT;
    var linear = spec.filter !== "nearest";
    if (type !== gl.UNSIGNED_BYTE && !gl.getExtension("OES_texture_half_float_linear")) linear = false;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  }

  function textureFromPixel() {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  function loadTexture(channel) {
    var texture = textureFromPixel();
    var image = new Image();
    image.onload = function () {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!channel.flipY);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      sampling(channel, image.width, image.height, gl.UNSIGNED_BYTE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    };
    image.onerror = function () { console.warn("Could not load texture", channel.path); };
    image.src = channel.path;
    return texture;
  }

  function isPowerOfTwo(value) { return value > 0 && (value & (value - 1)) === 0; }

  function pointerPosition(event) {
    var rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * canvas.width / rect.width,
      (rect.bottom - event.clientY) * canvas.height / rect.height];
  }

  function pointerMove(event) {
    var point = pointerPosition(event);
    var now = performance.now();
    if (lastPointer) {
      var dt = Math.max((now - lastPointerAt) / 1000, 1 / 240);
      velocity[0] += ((point[0] - lastPointer[0]) / dt - velocity[0]) * 0.25;
      velocity[1] += ((point[1] - lastPointer[1]) / dt - velocity[1]) * 0.25;
    }
    lastPointer = point; lastPointerAt = now; mouse[0] = point[0]; mouse[1] = point[1];
  }

  function pointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    var point = pointerPosition(event);
    mouse = [point[0], point[1], 1, 0];
    clicks[nextClick * 3] = point[0]; clicks[nextClick * 3 + 1] = point[1]; clicks[nextClick * 3 + 2] = time;
    nextClick = (nextClick + 1) % 24;
  }

  function pointerLeave() {
    mouse[0] = -1000; mouse[1] = -1000; mouse[2] = 0;
    velocity[0] = 0; velocity[1] = 0; lastPointer = null;
  }
})();
`;
