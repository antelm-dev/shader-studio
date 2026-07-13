import { describe, expect, it } from 'vitest';

import { ZipBuilder, crc32 } from './zip';

/**
 * A ZIP is a binary format held together by offsets, and a wrong one does not
 * throw — it produces an archive that opens as empty, or as garbage, on a
 * stranger's machine long after the export succeeded. So the bytes are read back
 * here and checked against the structure the format promises.
 */

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_DIRECTORY = 0x06_05_4b_50;

describe('crc32', () => {
  it('matches the checksums the format is specified against', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcb_f4_39_26);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('ZipBuilder', () => {
  it('writes an archive whose central directory points at the files it holds', async () => {
    const zip = new ZipBuilder();
    await zip.add('waves-0000.png', new Blob([new Uint8Array([1, 2, 3])]));
    await zip.add('waves-0001.png', new Blob([new Uint8Array([4, 5, 6, 7])]));

    const view = await bytesOf(zip.finish());

    // It opens with a local header…
    expect(view.getUint32(0, true)).toBe(LOCAL_HEADER);

    // …and closes with the end-of-directory record, which says how many files
    // there are and where their directory begins.
    const end = view.byteLength - 22;
    expect(view.getUint32(end, true)).toBe(END_OF_DIRECTORY);
    expect(view.getUint16(end + 8, true)).toBe(2);
    expect(view.getUint16(end + 10, true)).toBe(2);

    const directoryOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(directoryOffset, true)).toBe(CENTRAL_HEADER);

    // The directory's first entry points back at a real local header, and agrees
    // with it about the size of the file — the two places a bad offset shows up.
    const localOffset = view.getUint32(directoryOffset + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(LOCAL_HEADER);
    expect(view.getUint32(localOffset + 22, true)).toBe(3);
    expect(view.getUint32(directoryOffset + 24, true)).toBe(3);
  });

  it('stores rather than compresses: a PNG is already a deflate stream', async () => {
    const zip = new ZipBuilder();
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    await zip.add('frame.png', new Blob([payload]));

    const view = await bytesOf(zip.finish());

    // Method 0, and the compressed size is the uncompressed one.
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint32(18, true)).toBe(payload.length);
    expect(view.getUint32(22, true)).toBe(payload.length);

    // And the payload really is there, unchanged, right after the header.
    const start = 30 + view.getUint16(26, true);
    const stored = new Uint8Array(view.buffer, start, payload.length);
    expect([...stored]).toEqual([...payload]);
  });

  it('checksums each file with the bytes it actually stored', async () => {
    const payload = new TextEncoder().encode('123456789');
    const zip = new ZipBuilder();
    await zip.add('frame.png', new Blob([payload]));

    const view = await bytesOf(zip.finish());

    expect(view.getUint32(14, true)).toBe(crc32(payload));
  });

  it('produces a readable archive with no files in it', async () => {
    const view = await bytesOf(new ZipBuilder().finish());

    expect(view.byteLength).toBe(22);
    expect(view.getUint32(0, true)).toBe(END_OF_DIRECTORY);
    expect(view.getUint16(8, true)).toBe(0);
  });
});
