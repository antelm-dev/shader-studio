import { describe, expect, it } from 'vitest';

import { readImageDimensions } from './image-dimensions';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('readImageDimensions', () => {
  it('reads a PNG IHDR chunk', () => {
    const png = bytes(
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x01,
      0x2c, // width = 300
      0x00,
      0x00,
      0x00,
      0x64, // height = 100
      0x08,
      0x06,
      0x00,
      0x00,
      0x00, // rest of IHDR (unused)
    );
    expect(readImageDimensions(png)).toEqual({ width: 300, height: 100 });
  });

  it('reads a baseline JPEG SOF0 marker', () => {
    const jpeg = bytes(
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x10,
      ...new Array(14).fill(0), // APP0 segment, length 16
      0xff,
      0xc0, // SOF0
      0x00,
      0x11, // segment length
      0x08, // precision
      0x00,
      0x40, // height = 64
      0x00,
      0x80, // width = 128
      0x03, // components
    );
    expect(readImageDimensions(jpeg)).toEqual({ width: 128, height: 64 });
  });

  it('reads a VP8X (extended) WebP header', () => {
    const webp = bytes(
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      0x00,
      0x00,
      0x00,
      0x00, // size (unused)
      0x57,
      0x45,
      0x42,
      0x50, // "WEBP"
      0x56,
      0x50,
      0x38,
      0x58, // "VP8X"
      0x0a,
      0x00,
      0x00,
      0x00, // chunk size
      0x00, // flags
      0x00,
      0x00,
      0x00, // reserved
      0x1f,
      0x00,
      0x00, // width - 1 = 31 -> width 32
      0x0f,
      0x00,
      0x00, // height - 1 = 15 -> height 16
    );
    expect(readImageDimensions(webp)).toEqual({ width: 32, height: 16 });
  });

  it('returns null for unrecognized bytes', () => {
    expect(readImageDimensions(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull();
  });
});
