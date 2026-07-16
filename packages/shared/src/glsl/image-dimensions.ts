/**
 * Pixel dimensions read straight from a PNG/JPEG/WebP header — no decode, no
 * dependency. The Shadertoy importer needs width/height for the texture
 * channel it downloads, and pulling in a full image library for four bytes of
 * metadata isn't worth it.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR is always the first chunk: 4-byte length, "IHDR", then width/height.
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOFn markers carry the dimensions, except the DHT/JPG/DAC lookalikes.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: readUint16BE(bytes, offset + 5), width: readUint16BE(bytes, offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const riff = String.fromCodePoint(...bytes.slice(0, 4));
  const webp = String.fromCodePoint(...bytes.slice(8, 12));
  if (riff !== 'RIFF' || webp !== 'WEBP') return null;

  const fourCc = String.fromCodePoint(...bytes.slice(12, 16));

  if (fourCc === 'VP8X') {
    return { width: 1 + readUint24LE(bytes, 24), height: 1 + readUint24LE(bytes, 27) };
  }

  if (fourCc === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: readUint16BE(bytes, 26) & 0x3fff, height: readUint16BE(bytes, 28) & 0x3fff };
  }

  if (fourCc === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }

  return null;
}

/** Reads pixel dimensions from PNG, JPEG or WebP bytes; `null` if unrecognized or truncated. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

export interface DecodedImage extends ImageDimensions {
  ext: 'png' | 'jpg' | 'webp';
}

/** Identifies the format from magic bytes (never trusts a URL's extension) and reads its size. */
export function decodeImage(bytes: Uint8Array): DecodedImage | null {
  const png = readPng(bytes);
  if (png) return { ...png, ext: 'png' };

  const jpeg = readJpeg(bytes);
  if (jpeg) return { ...jpeg, ext: 'jpg' };

  const webp = readWebp(bytes);
  if (webp) return { ...webp, ext: 'webp' };

  return null;
}
