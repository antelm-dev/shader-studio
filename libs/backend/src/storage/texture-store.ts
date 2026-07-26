/**
 * File layout for a shader's image slots: the four texture channels and the
 * thumbnail. Each slot keeps a fixed basename and an extension that changes
 * with the image format, so replacing a slot means clearing whatever is
 * there under any extension, not just the one about to be written.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { TextureChannels } from '@shader-studio/shared/model';

const TEXTURES_DIR = 'textures';
export const THUMBNAIL_BASENAME = 'thumbnail';

export const CHANNEL_INDICES = [0, 1, 2, 3] as const;
export type ChannelIndex = (typeof CHANNEL_INDICES)[number];

export function isChannelIndex(value: number): value is ChannelIndex {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export function texturesDir(shaderDir: string): string {
  return path.join(shaderDir, TEXTURES_DIR);
}

export function textureFile(shaderDir: string, channel: ChannelIndex, ext: string): string {
  return path.join(texturesDir(shaderDir), `${channel}.${ext}`);
}

export function thumbnailFile(shaderDir: string, ext: string): string {
  return path.join(shaderDir, `${THUMBNAIL_BASENAME}.${ext}`);
}

/** Removes every `<basename>.*` in a directory — see module doc for why. */
export async function removeSlotFiles(dir: string, basename: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const prefix = `${basename}.`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => fs.rm(path.join(dir, entry), { force: true })),
  );
}

export function removeTextureFile(shaderDir: string, channel: ChannelIndex): Promise<void> {
  return removeSlotFiles(texturesDir(shaderDir), String(channel));
}

export async function copyTextures(
  fromDir: string,
  toDir: string,
  channels: TextureChannels,
): Promise<void> {
  await fs.mkdir(texturesDir(toDir), { recursive: true });
  await Promise.all(
    CHANNEL_INDICES.map(async (channel) => {
      const ext = channels[channel].ext;
      if (ext === null) return;
      try {
        await fs.copyFile(textureFile(fromDir, channel, ext), textureFile(toDir, channel, ext));
      } catch (error) {
        console.warn(`[storage] failed to copy texture for channel ${channel}: ${String(error)}`);
      }
    }),
  );
}
