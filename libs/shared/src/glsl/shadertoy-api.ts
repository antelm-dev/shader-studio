/**
 * Host-side Shadertoy retrieval, and the legacy one-call importer.
 *
 * `fetchShadertoySource` and `fetchShadertoyAsset` are what the web server and
 * the desktop main process run for the `shadertoy-api/v1` source provider:
 * fixed origin, validated id and media path, redirects followed by hand only
 * within the allow-list, and bodies refused past their bound. The API key goes
 * into the one source request and nowhere else — never into a message, a log
 * line or an error.
 *
 * `importShadertoyShader` keeps the documented `POST /api/import/shadertoy`
 * and `shader.import-shadertoy` IPC working: the same fetchers, the same pure
 * converter the installed plugin runs (`shadertoy-convert`), and the same
 * texture resolution the app uses for plugin candidates. No installed plugin
 * code runs on the server or in the main process.
 */
import { DEFAULT_RENDER, type ShaderPayload } from '@shadergrove/shared/model';
import { newId } from '@shadergrove/shared/project';
import { LIMITS, slugify } from '@shadergrove/shared/validate';
import { PROJECT_LIMITS } from '../plugin/project';
import { resolveTextureRequests } from '../plugin/texture-requests';
import { SHADERTOY_ORIGIN, convertShadertoySource, parseShadertoyId } from './shadertoy-convert';

export { SHADERTOY_ORIGIN, parseShadertoyId } from './shadertoy-convert';

// This library compiles without DOM or Node types; every runtime that loads it has both.
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(bytes: Uint8Array): string };
declare const URL: new (
  url: string,
  base?: string,
) => { href: string; origin: string; pathname: string };
type URL = InstanceType<typeof URL>;

/**
 * The slice of the DOM/Node `fetch` API this module needs. Kept as a local,
 * structural type — rather than the ambient `fetch`/`Response` globals — so
 * this package stays usable without a DOM or Node `lib` (it runs in the
 * Electron main process, the Express server, and the browser alike). Callers
 * add their own abort signal/timeout around it.
 */
export interface ShadertoyFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ShadertoyFetch = (
  url: string,
  init?: { redirect?: 'manual' },
) => Promise<ShadertoyFetchResponse>;

export interface ShadertoyFetchDeps {
  fetch: ShadertoyFetch;
}

export interface ShadertoyImportResult {
  payload: ShaderPayload;
  warnings: string[];
}

/** Media paths the provider will fetch: Shadertoy's own texture files, nothing else. */
const ASSET_PATH =
  /^\/(?:media\/(?:a|ap|previz)|presets)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\.(?:png|jpe?g|webp)$/;
const MAX_REDIRECTS = 3;

export function isShadertoyAssetPath(path: unknown): path is string {
  return typeof path === 'string' && ASSET_PATH.test(path) && !path.includes('..');
}

export class ShadertoyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadertoyRequestError';
  }
}

/**
 * Fetch `api/v1/shaders/{id}` for an id or view URL and return the JSON
 * document, at most `PROJECT_LIMITS.sourceBytes`. Errors never carry the key.
 */
export async function fetchShadertoySource(
  idOrUrl: string,
  apiKey: string,
  deps: ShadertoyFetchDeps,
): Promise<{ sourceId: string; source: unknown }> {
  const id = parseShadertoyId(idOrUrl);
  const key = apiKey.trim();
  if (!key) throw new ShadertoyRequestError('A Shadertoy API key is required.');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
    throw new ShadertoyRequestError('That does not look like a Shadertoy API key.');
  }
  const path = `/api/v1/shaders/${encodeURIComponent(id)}`;
  const response = await follow(
    `${SHADERTOY_ORIGIN}${path}?key=${encodeURIComponent(key)}`,
    (url) => url.pathname === path,
    deps,
  );
  if (!response.ok)
    throw new ShadertoyRequestError(`Shadertoy request failed (${response.status}).`);
  const bytes = await readBounded(response, PROJECT_LIMITS.sourceBytes);
  let source: unknown;
  try {
    source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ShadertoyRequestError('Unexpected response from Shadertoy.');
  }
  return { sourceId: id, source };
}

/** Fetch one Shadertoy media file by its path, at most `LIMITS.textureBytes`. */
export async function fetchShadertoyAsset(
  path: string,
  deps: ShadertoyFetchDeps,
): Promise<Uint8Array> {
  if (!isShadertoyAssetPath(path)) {
    throw new ShadertoyRequestError('That is not a Shadertoy texture path.');
  }
  const response = await follow(
    `${SHADERTOY_ORIGIN}${path}`,
    (url) => isShadertoyAssetPath(url.pathname),
    deps,
  );
  if (!response.ok) throw new ShadertoyRequestError(`request failed (${response.status})`);
  return readBounded(response, LIMITS.textureBytes);
}

/**
 * Fetches a Shadertoy shader and reconstructs it as a `ShaderPayload` this
 * app can import through its existing bundle pipeline. The documented
 * compatibility path; the app itself imports through the installed plugin.
 */
export async function importShadertoyShader(
  idOrUrl: string,
  apiKey: string,
  deps: ShadertoyFetchDeps,
): Promise<ShadertoyImportResult> {
  const { sourceId, source } = await fetchShadertoySource(idOrUrl, apiKey, deps);
  const converted = convertShadertoySource(source, sourceId);
  const resolved = await resolveTextureRequests(
    converted.project.passes,
    converted.textures,
    (asset) => fetchShadertoyAsset(asset, deps),
  );
  const project = { ...converted.project, passes: resolved.passes };
  const imagePass = project.passes.find((pass) => pass.kind === 'image');
  if (!imagePass) throw new Error('The imported shader has no Image pass.');

  const payload: ShaderPayload = {
    id: uniqueId(slugify(converted.name), sourceId),
    name: converted.name,
    description: converted.description,
    ...(converted.credits.author ? { author: converted.credits.author } : {}),
    controls: [],
    render: DEFAULT_RENDER,
    fragment: imagePass.source,
    vertex: project.vertex,
    presets: [],
    channels: resolved.channels as unknown as ShaderPayload['channels'],
    thumbnail: null,
    project,
  };

  return { payload, warnings: [...converted.warnings, ...resolved.warnings] };
}

/** `slugify(name)-<shadertoyId>`, kept short and always a valid id. */
function uniqueId(base: string, shadertoyId: string): string {
  const suffix = shadertoyId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  if (!suffix) return base || newId('shader');
  const trimmedBase = base.slice(0, LIMITS.idLength - suffix.length - 1);
  return trimmedBase ? `${trimmedBase}-${suffix}` : suffix;
}

/** Request `url`, following redirects by hand while they stay on Shadertoy and pass `allowed`. */
async function follow(
  url: string,
  allowed: (url: URL) => boolean,
  deps: ShadertoyFetchDeps,
): Promise<ShadertoyFetchResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await deps.fetch(current, { redirect: 'manual' });
    if (response.status < 300 || response.status > 399) return response;
    const location = response.headers?.get('location');
    if (!location) throw new ShadertoyRequestError('Shadertoy redirected without a location.');
    const next = new URL(location, current);
    if (next.origin !== SHADERTOY_ORIGIN || !allowed(next)) {
      throw new ShadertoyRequestError('Shadertoy redirected somewhere this app does not follow.');
    }
    current = next.href;
  }
  throw new ShadertoyRequestError('Shadertoy redirected too many times.');
}

/** The response body, refused as soon as it passes `max` bytes. */
async function readBounded(response: ShadertoyFetchResponse, max: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new ShadertoyRequestError(`larger than ${Math.round(max / (1024 * 1024))} MB`);
  const declared = Number(response.headers?.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > max) throw tooLarge();
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
