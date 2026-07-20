import { Injectable, inject } from '@angular/core';

import type { ShaderRecord, TextureChannelSettingsPatch } from '@shader-studio/shared/model';
import type { ChannelIndex } from '@shader-studio/shared/project';
import { extFromMime, LIMITS } from '@shader-studio/shared/validate';
import { ShaderApi } from '../api/shader-api';
import { TextureAssets } from '../assets/texture-assets';

export type TextureOpResult =
  | { ok: true; record: ShaderRecord; notice: string }
  | { ok: false; message: string };

/**
 * The channel-texture half of `ShaderStore`: validating and decoding an
 * uploaded image, and the API calls that assign, clear or reconfigure a
 * channel. `ShaderStore` still owns writing the returned record back to its
 * own signal, refreshing the shader list, and surfacing the notice — this is
 * just the part that talks to the server and the local blob cache.
 */
@Injectable({ providedIn: 'root' })
export class TextureService {
  private readonly api = inject(ShaderApi);
  private readonly textures = inject(TextureAssets);

  /**
   * Decodes the file locally first, both to reject anything that is not
   * actually an image before spending a round trip on it, and to get the
   * pixel dimensions the server wants alongside the bytes.
   */
  async setImage(recordId: string, channel: ChannelIndex, file: File): Promise<TextureOpResult> {
    const ext = extFromMime(file.type);
    if (!ext) {
      return { ok: false, message: `“${file.name}” must be a PNG, JPEG or WebP image` };
    }
    if (file.size > LIMITS.textureBytes) {
      return {
        ok: false,
        message: `“${file.name}” is larger than ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`,
      };
    }

    let width: number;
    let height: number;
    try {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      return { ok: false, message: `“${file.name}” is not a readable image` };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const record = await this.api.setTexture(recordId, channel, { ext, bytes, width, height });
    this.textures.releaseShader(recordId);
    return { ok: true, record, notice: `Assigned “${file.name}” to iChannel${channel}` };
  }

  async clearImage(
    recordId: string,
    channel: ChannelIndex,
  ): Promise<{ record: ShaderRecord; notice: string }> {
    const record = await this.api.clearTexture(recordId, channel);
    this.textures.releaseShader(recordId);
    return { record, notice: `Cleared iChannel${channel}` };
  }

  setChannelSettings(
    recordId: string,
    channel: ChannelIndex,
    patch: TextureChannelSettingsPatch,
  ): Promise<ShaderRecord> {
    const channels: TextureChannelSettingsPatch[] = [0, 1, 2, 3].map((index) =>
      index === channel ? patch : {},
    );
    return this.api.update(recordId, { channels });
  }
}
