// File output: saving a blob, and a small store-only ZIP writer.
//
// 2.x pulled in JSZip and FileSaver for this. The cropper only ever asked JSZip
// for `compression: 'STORE'` — already-compressed WebP does not shrink further —
// so the archive is just headers around the raw bytes. Writing those directly
// removes both dependencies and about 100 KB of shipped code.

/** Trigger a download for a blob. Replaces FileSaver. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.append(link);
  link.click();
  link.remove();

  // Revoked on the next tick so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time pair for the current moment. */
function dosStamp(date = new Date()) {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11);
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9);
  return { time, day };
}

const ZIP64_LIMIT = 0xffffffff;

/**
 * Store-only ZIP builder.
 *
 * Entries are held as Uint8Array views; nothing is copied until build().
 */
export class StoreZip {
  constructor() {
    this.entries = [];
    this.totalBytes = 0;
  }

  async addBlob(name, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);

    this.entries.push({ nameBytes, bytes, crc: crc32(bytes) });
    this.totalBytes += bytes.length;

    if (this.totalBytes > ZIP64_LIMIT) {
      throw new Error('The archive would exceed the 4 GB ZIP limit. Use the individual-files output instead.');
    }
  }

  get size() {
    return this.entries.length;
  }

  /** Assemble the archive. Returns a Blob. */
  build() {
    const { time, day } = dosStamp();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of this.entries) {
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // local file header signature
      local.setUint16(4, 20, true);           // version needed
      local.setUint16(6, 0x0800, true);       // flags: UTF-8 filename
      local.setUint16(8, 0, true);            // compression: store
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, entry.crc, true);
      local.setUint32(18, entry.bytes.length, true);
      local.setUint32(22, entry.bytes.length, true);
      local.setUint16(26, entry.nameBytes.length, true);
      local.setUint16(28, 0, true);           // extra field length

      parts.push(new Uint8Array(local.buffer), entry.nameBytes, entry.bytes);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);     // central directory signature
      dir.setUint16(4, 20, true);             // version made by
      dir.setUint16(6, 20, true);             // version needed
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, time, true);
      dir.setUint16(14, day, true);
      dir.setUint32(16, entry.crc, true);
      dir.setUint32(20, entry.bytes.length, true);
      dir.setUint32(24, entry.bytes.length, true);
      dir.setUint16(28, entry.nameBytes.length, true);
      dir.setUint16(30, 0, true);             // extra
      dir.setUint16(32, 0, true);             // comment
      dir.setUint16(34, 0, true);             // disk number start
      dir.setUint16(36, 0, true);             // internal attributes
      dir.setUint32(38, 0, true);             // external attributes
      dir.setUint32(42, offset, true);        // offset of local header

      central.push(new Uint8Array(dir.buffer), entry.nameBytes);
      offset += 30 + entry.nameBytes.length + entry.bytes.length;
    }

    const centralStart = offset;
    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);       // end of central directory
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);               // comment length

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
      type: 'application/zip',
    });
  }
}

/** Strip characters Windows and macOS reject in filenames. */
export function safeName(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}
