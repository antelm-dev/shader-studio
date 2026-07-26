export const LIMITS = {
  idLength: 64,
  nameLength: 64,
  descriptionLength: 500,
  authorLength: 64,
  sourceLength: 200_000,
  controlCount: 200,
  keyLength: 48,
  labelLength: 64,
  folderLength: 48,
  selectOptionCount: 64,
  presetCount: 200,
  bundleShaderCount: 200,
  textureBytes: 4 * 1024 * 1024,
  thumbnailBytes: 512 * 1024,
  textureDimension: 4096,
} as const;

export const TEXTURE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

const TEXTURE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function mimeFromExt(ext: string): string {
  return TEXTURE_MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function extFromMime(mime: string | undefined | null): string | null {
  const clean = (mime ?? '').split(';')[0]?.trim().toLowerCase();
  if (clean === 'image/png') return 'png';
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/webp') return 'webp';
  return null;
}
