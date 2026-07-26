export type TextureWrapMode = 'repeat' | 'clamp' | 'mirror';
export type TextureFilterMode = 'linear' | 'nearest';

/**
 * One `iChannel` slot. `ext === null` means nothing is assigned, in which
 * case `width`/`height` are meaningless and the engine binds a 1×1
 * transparent placeholder instead.
 */
export interface TextureChannel {
  ext: string | null;
  width: number;
  height: number;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

export type TextureChannels = readonly [
  TextureChannel,
  TextureChannel,
  TextureChannel,
  TextureChannel,
];

export const DEFAULT_TEXTURE_CHANNEL: TextureChannel = {
  ext: null,
  width: 0,
  height: 0,
  wrap: 'clamp',
  filter: 'linear',
  flipY: true,
};

export const DEFAULT_CHANNELS: TextureChannels = [
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
  { ...DEFAULT_TEXTURE_CHANNEL },
];

export type TextureChannelSettingsPatch = Partial<
  Pick<TextureChannel, 'wrap' | 'filter' | 'flipY'>
>;

export interface TextureChannelPayload extends TextureChannel {
  data: string | null;
}

export type TextureChannelPayloads = readonly [
  TextureChannelPayload,
  TextureChannelPayload,
  TextureChannelPayload,
  TextureChannelPayload,
];

export const THUMBNAIL_WIDTH = 480;
export const THUMBNAIL_HEIGHT = 270;

export interface ThumbnailMeta {
  ext: string;
  updatedAt: string;
}

export interface ThumbnailPayload extends ThumbnailMeta {
  data: string;
}
