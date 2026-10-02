/**
 * Host-side resolution of a candidate's texture requests.
 *
 * Each request's asset is fetched through the caller's `fetchAsset` (a source
 * provider, which owns the allow-list), sniffed and bounded, then given the
 * next free slot; its uses are bound to that slot. Slots go in first-request
 * order; a failed or unreadable download warns, leaves its uses unbound and
 * takes no slot — the behaviour of the built-in Shadertoy importer.
 */
import type { TextureChannelPayload } from '../model';
import { decodeImage } from '../glsl/image-dimensions';
import { CHANNEL_COUNT, type ChannelBinding, type ChannelIndex, type RenderPass } from '../project';
import { LIMITS, TEXTURE_EXTENSIONS } from '../validate/limits';
import type { ProjectTextureRequest } from './project';

export interface ResolvedTextures {
  passes: RenderPass[];
  channels: TextureChannelPayload[];
  warnings: string[];
}

export async function resolveTextureRequests(
  sourcePasses: readonly RenderPass[],
  requests: readonly ProjectTextureRequest[],
  fetchAsset: (asset: string) => Promise<Uint8Array>,
  checkAborted: () => void = () => undefined,
): Promise<ResolvedTextures> {
  const passes = sourcePasses.map((pass) => ({
    ...pass,
    channels: [...pass.channels] as unknown as RenderPass['channels'],
  }));
  const channels = emptyChannelPayloads();
  const warnings: string[] = [];
  let claimed = 0;

  for (const request of requests) {
    checkAborted();
    const first = request.uses[0];
    const passName = passes.find((pass) => pass.id === first?.passId)?.name ?? 'pass';
    if (claimed >= CHANNEL_COUNT) {
      for (const use of request.uses) {
        const name = passes.find((pass) => pass.id === use.passId)?.name ?? 'pass';
        warnings.push(
          `Only ${CHANNEL_COUNT} texture slots are available; "${name}" iChannel${use.channel} was left unassigned.`,
        );
      }
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fetchAsset(request.asset);
      if (bytes.byteLength > LIMITS.textureBytes) {
        throw new Error(`larger than ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`);
      }
    } catch (error) {
      checkAborted();
      warnings.push(
        `Failed to download a texture for "${passName}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const decoded = decodeImage(bytes);
    if (
      !decoded ||
      !TEXTURE_EXTENSIONS.has(decoded.ext) ||
      decoded.width > LIMITS.textureDimension ||
      decoded.height > LIMITS.textureDimension
    ) {
      warnings.push(
        `Could not read the texture format for "${passName}" iChannel${first?.channel ?? 0}.`,
      );
      continue;
    }
    const slot = claimed++ as ChannelIndex;
    channels[slot] = {
      ext: decoded.ext,
      width: decoded.width,
      height: decoded.height,
      wrap: request.wrap,
      filter: request.filter,
      flipY: request.flipY,
      data: base64FromBytes(bytes),
    };
    for (const use of request.uses) {
      const pass = passes.find((entry) => entry.id === use.passId);
      if (!pass) continue;
      const bindings = [...pass.channels] as ChannelBinding[];
      bindings[use.channel] = { kind: 'texture', slot };
      pass.channels = bindings as unknown as RenderPass['channels'];
    }
  }

  return { passes, channels, warnings };
}

export function emptyChannelPayloads(): TextureChannelPayload[] {
  return Array.from({ length: CHANNEL_COUNT }, () => ({
    ext: null,
    width: 0,
    height: 0,
    wrap: 'clamp',
    filter: 'linear',
    flipY: true,
    data: null,
  }));
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Dependency-free base64 encoding — avoids relying on ambient `Buffer`/`btoa`. */
export function base64FromBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1]! : 0;
    const b2 = hasB2 ? bytes[i + 2]! : 0;
    parts.push(
      BASE64_CHARS[b0 >> 2]! +
        BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]! +
        (hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '=') +
        (hasB2 ? BASE64_CHARS[b2 & 0x3f]! : '='),
    );
  }
  return parts.join('');
}
