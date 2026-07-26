/**
 * A ZIP file, stored — no compression at all.
 *
 * This exists to hand a browser user their image sequence as one download
 * instead of a thousand. Compression would be pointless work: a PNG is already
 * a DEFLATE stream, and deflating it again buys a percent or two for a great
 * deal of CPU on a machine that has just spent minutes rendering. So every entry
 * goes in with method 0, which is a format ZIP has always allowed and every
 * unarchiver has always accepted — and which is why this file has no dependency
 * behind it.
 *
 * Entries are held as `Blob`s and only assembled at the end, so the frames are
 * never all resident as bytes: the browser is free to keep them on disk, which
 * for a 4K sequence is the difference between an export and a tab that dies.
 */

interface ZipEntry {
  name: string;
  blob: Blob;
  crc: number;
  offset: number;
}

/** The table-driven CRC-32 the ZIP format specifies. Built once, on first use. */
let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * A fixed-size record and a view on it. Every field in a ZIP is little-endian.
 *
 * The buffer is spelled out rather than left to `Uint8Array`'s default, which is
 * the *shared* one — and a `SharedArrayBuffer` is not something `Blob` will take.
 */
function record(size: number): { view: DataView; bytes: Uint8Array<ArrayBuffer> } {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  return { view: new DataView(bytes.buffer), bytes };
}

/**
 * Entries are counted in a 16-bit field. Past this the archive needs ZIP64,
 * which is a different format and not one worth carrying for a case that means
 * a capture of eighteen minutes at 60fps.
 */
export const MAX_ZIP_ENTRIES = 65_535;

export class ZipBuilder {
  private readonly entries: ZipEntry[] = [];
  private readonly parts: BlobPart[] = [];
  private offset = 0;

  /** Adds a file. The bytes are read once for the checksum; the blob is what gets written. */
  async add(name: string, blob: Blob): Promise<void> {
    if (this.entries.length >= MAX_ZIP_ENTRIES) {
      throw new RangeError(`A stored ZIP holds at most ${MAX_ZIP_ENTRIES} files.`);
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    const nameBytes = new TextEncoder().encode(name);

    const header = record(30 + nameBytes.length);
    const { view } = header;
    view.setUint32(0, 0x04_03_4b_50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // method 0: stored
    view.setUint16(10, 0, true); // time
    view.setUint16(12, 0, true); // date
    view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true); // compressed size
    view.setUint32(22, bytes.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra length
    header.bytes.set(nameBytes, 30);

    this.entries.push({ name, blob, crc, offset: this.offset });
    this.parts.push(header.bytes, blob);
    this.offset += header.bytes.length + bytes.length;
  }

  /** Seals the archive: the central directory, then the record that points at it. */
  finish(): Blob {
    const encoder = new TextEncoder();
    const directoryOffset = this.offset;
    let directorySize = 0;

    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.name);
      const size = entry.blob.size;

      const central = record(46 + nameBytes.length);
      const { view } = central;
      view.setUint32(0, 0x02_01_4b_50, true); // central directory header
      view.setUint16(4, 20, true); // version made by
      view.setUint16(6, 20, true); // version needed
      view.setUint16(8, 0, true); // flags
      view.setUint16(10, 0, true); // method 0: stored
      view.setUint16(12, 0, true); // time
      view.setUint16(14, 0, true); // date
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, size, true);
      view.setUint32(24, size, true);
      view.setUint16(28, nameBytes.length, true);
      view.setUint16(30, 0, true); // extra
      view.setUint16(32, 0, true); // comment
      view.setUint16(34, 0, true); // disk
      view.setUint16(36, 0, true); // internal attributes
      view.setUint32(38, 0, true); // external attributes
      view.setUint32(42, entry.offset, true);
      central.bytes.set(nameBytes, 46);

      this.parts.push(central.bytes);
      directorySize += central.bytes.length;
    }

    const end = record(22);
    end.view.setUint32(0, 0x06_05_4b_50, true); // end of central directory
    end.view.setUint16(4, 0, true); // disk
    end.view.setUint16(6, 0, true); // directory start disk
    end.view.setUint16(8, this.entries.length, true);
    end.view.setUint16(10, this.entries.length, true);
    end.view.setUint32(12, directorySize, true);
    end.view.setUint32(16, directoryOffset, true);
    end.view.setUint16(20, 0, true); // comment length

    this.parts.push(end.bytes);
    return new Blob(this.parts, { type: 'application/zip' });
  }

  get size(): number {
    return this.entries.length;
  }
}
