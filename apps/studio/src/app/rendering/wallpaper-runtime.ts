/**
 * The `wallpaper-web/v1` export runtime: host code that turns a Wallpaper
 * Engine plugin's validated data into a web-wallpaper project.
 *
 * Everything executable here is the host's: the HTML shell and the WebGL
 * player below are fixed templates, and the plugin's data — GLSL strings,
 * pass wiring, property definitions — is only ever embedded as escaped JSON.
 * Textures come from the host's own bytes, inlined as data URIs so the project
 * needs nothing from the network or from outside its folder.
 *
 * Output, all relative to the project folder:
 * - `index.html` — the wallpaper,
 * - `project.json` — Wallpaper Engine's project file: `type: "web"`, the
 *   entry file and one user property per control, with the same keys, types
 *   and defaults the player's `wallpaperPropertyListener` reads.
 */
import { Injectable } from '@angular/core';

import {
  WALLPAPER_WEB_RUNTIME,
  validateWallpaperWebData,
  type WallpaperWebData,
  type WallpaperWebProperty,
} from '@shadergrove/shared/plugin';
import { fail, mimeFromExt, ok, type Result } from '@shadergrove/shared/validate';

import type { ExportRuntime, RuntimeOutput, RuntimeTexture } from '../plugins/host-adapters';

/** The most a project may weigh: four 4 MiB textures inlined as base64, and the code, fit easily. */
export const MAX_WALLPAPER_PROJECT_BYTES = 64 * 1024 * 1024;
const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

@Injectable()
export class WallpaperWebRuntime implements ExportRuntime {
  readonly id = WALLPAPER_WEB_RUNTIME;

  assemble(data: unknown, textures: readonly RuntimeTexture[]): Result<RuntimeOutput> {
    return assembleWallpaper(data, textures);
  }
}

export function assembleWallpaper(
  input: unknown,
  textures: readonly RuntimeTexture[],
): Result<RuntimeOutput> {
  const parsed = validateWallpaperWebData(input);
  if (!parsed.ok) return parsed;
  const data = parsed.value;

  const channels = [0, 1, 2, 3].map((slot) => {
    const sampling = data.channels.find((channel) => channel.slot === slot);
    const texture = textures.find((entry) => entry.slot === slot);
    if (!sampling || !texture || !TEXTURE_EXTENSIONS.has(texture.ext)) {
      return { path: null, wrap: 'clamp', filter: 'linear', flipY: true };
    }
    return {
      path: `data:${mimeFromExt(texture.ext)};base64,${base64(texture.bytes)}`,
      wrap: sampling.wrap,
      filter: sampling.filter,
      flipY: sampling.flipY,
    };
  });

  const player = {
    format: 'shadergrove-wallpaper/v2',
    vertex: data.vertex,
    passes: data.passes,
    controls: data.properties.map(({ key, uniform, type }) => ({ key, uniform, type })),
    params: Object.fromEntries(
      data.properties.map((property) => [property.key, playerValue(property)]),
    ),
    channels,
  };

  const encoder = new TextEncoder();
  const html = encoder.encode(indexHtml(data.title, player));
  const project = encoder.encode(`${JSON.stringify(projectJson(data), null, 2)}\n`);
  if (html.byteLength + project.byteLength > MAX_WALLPAPER_PROJECT_BYTES) {
    return fail('The wallpaper project is too large');
  }
  return ok({
    stem: safeStem(data.title),
    files: [
      { path: 'index.html', bytes: html },
      { path: 'project.json', bytes: project },
    ],
  });
}

/** Wallpaper Engine's `project.json` for a web wallpaper. */
export function projectJson(data: WallpaperWebData): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const property of data.properties) {
    const base = { order: property.order, text: property.text, type: property.type };
    switch (property.type) {
      case 'slider':
        properties[property.key] = {
          ...base,
          value: property.value,
          min: property.min,
          max: property.max,
          step: property.step,
          precision: property.precision,
          fraction: property.precision > 0,
        };
        break;
      case 'combo':
        properties[property.key] = { ...base, value: property.value, options: property.options };
        break;
      default:
        properties[property.key] = { ...base, value: property.value };
    }
  }
  return {
    file: 'index.html',
    type: 'web',
    title: data.title,
    description: data.author
      ? `${data.title} by ${data.author}, exported from Shadergrove.`
      : `${data.title}, exported from Shadergrove.`,
    general: { properties },
  };
}

/** What the player keeps for a property: what its uniform takes. */
function playerValue(property: WallpaperWebProperty): number | boolean | string {
  switch (property.type) {
    case 'combo':
      return Number(property.value);
    default:
      return property.value;
  }
}

export function safeStem(value: string): string {
  const stem = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return stem || 'shader-wallpaper';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** JSON that cannot close the `<script>` it sits in, nor break a JS string. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

function indexHtml(title: string, player: unknown): string {
  const escaped = escapeHtml(title);
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
    <script>window.__SHADERGROVE_WALLPAPER__ = ${scriptJson(player)};</script>
    <script>${WALLPAPER_PLAYER}</script>
  </body>
</html>
`;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * The host's WebGL 1 player, kept as source so the project has no CDN
 * dependency. Property values from Wallpaper Engine are coerced by the type
 * the host recorded, never trusted as given.
 */
export const WALLPAPER_PLAYER = String.raw`(function () {
  "use strict";

  var project = window.__SHADERGROVE_WALLPAPER__;
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
        var property = properties[control.key];
        if (!property || !("value" in property)) return;
        params[control.key] = coerce(control.type, property.value, params[control.key]);
      });
    }
  };

  requestAnimationFrame(frame);

  function coerce(type, value, fallback) {
    if (type === "bool") return value === true || value === "true";
    if (type === "color") return typeof value === "string" ? value : fallback;
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function fail(message) {
    if (errorBox) { errorBox.hidden = false; errorBox.textContent = String(message); }
    console.error("[Shadergrove wallpaper]", message);
  }

  function declares(source, name) {
    return new RegExp("\\b(?:uniform|varying|attribute)\\b[^;]*\\b" + name + "\\b").test(source);
  }

  function vertexSource(source) {
    var declarations = [];
    if (!/^\s*precision\s+\w+\s+float\s*;/m.test(source)) declarations.push("precision highp float;");
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
    var parts = String(value || "1 1 1").trim().split(/\s+/).map(Number);
    return [0, 1, 2].map(function (index) {
      var part = parts[index];
      return isFinite(part) ? Math.min(1, Math.max(0, part)) : 1;
    });
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
      var at = location(compiled, "u_" + control.uniform);
      if (at === null) return;
      if (control.type === "bool") gl.uniform1i(at, value ? 1 : 0);
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
    image.onerror = function () { console.warn("Could not load a texture"); };
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
