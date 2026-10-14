// Minimal streaming ZIP writer (deflate via CompressionStream, or store).
// Files are read in chunks; stored entries reuse the original File as a Blob part, so
// zipping large videos doesn't copy them into memory.
import { crc32 } from './crc32.js';

// Formats that are already compressed — deflating them wastes time for ~0% gain.
const STORE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|m4v|mov|webm|mkv|avi|3gp|mp3|m4a|aac|ogg|opus|flac|zip|7z|rar|gz|tgz|bz2|xz|docx|xlsx|pptx|odt|ods|epub|apk|ipa|jar|pdf)$/i;

const enc = new TextEncoder();

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function uniqueNames(entries) {
  const seen = new Map();
  return entries.map(({ file, path }) => {
    let name = (path || file.name || 'file').replace(/\\/g, '/').replace(/^\/+/, '');
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const n = seen.get(key) + 1;
      seen.set(key, n);
      name = name.replace(/(\.[^./]+)?$/, m => ` (${n})${m}`);
    } else {
      seen.set(key, 1);
    }
    return { file, name };
  });
}

async function readCrc(file, onBytes) {
  const reader = file.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32(value, crc);
    onBytes(value.length);
  }
  return crc;
}

async function deflateWithCrc(file, onBytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const out = new Response(cs.readable).blob();
  const reader = file.stream().getReader();
  let crc = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    crc = crc32(value, crc);
    await writer.write(value);
    onBytes(value.length);
  }
  await writer.close();
  return { crc, data: await out };
}

/**
 * @param {{file: File|Blob, path?: string}[]} entries
 * @param {{compress?: boolean, onProgress?: (p:number, name:string)=>void}} opts
 * @returns {Promise<Blob>}
 */
export async function createZip(entries, opts = {}) {
  const compress = opts.compress !== false && typeof CompressionStream !== 'undefined';
  const list = uniqueNames(entries);
  if (list.length > 65534) throw new Error('Too many files for one ZIP (max 65,534).');
  const totalIn = list.reduce((n, e) => n + e.file.size, 0);
  if (totalIn > 0xfffff000) throw new Error('ZIP files are limited to 4 GB. Split the files into smaller ZIPs.');

  const parts = [];
  const central = [];
  let offset = 0;
  let doneBytes = 0;
  const tick = (n, name) => { doneBytes += n; opts.onProgress?.(totalIn ? doneBytes / totalIn : 1, name); };

  for (const { file, name } of list) {
    const nameBytes = enc.encode(name);
    const { time, date } = dosDateTime(file.lastModified);
    let method = 0, crc, data, compSize;
    const tryDeflate = compress && file.size > 64 && !STORE_EXT.test(name);
    if (tryDeflate) {
      const r = await deflateWithCrc(file, n => tick(n, name));
      crc = r.crc;
      if (r.data.size < file.size) { method = 8; data = r.data; compSize = r.data.size; }
    } else {
      crc = await readCrc(file, n => tick(n, name));
    }
    if (method === 0) { data = file; compSize = file.size; }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);        // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compSize, true);
    lv.setUint32(22, file.size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031e, true);        // made by: Unix, spec 3.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compSize, true);
    cv.setUint32(24, file.size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // -rw-r--r--
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + compSize;
    if (offset > 0xffffffff) throw new Error('ZIP files are limited to 4 GB.');
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, list.length, true);
  ev.setUint16(10, list.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  opts.onProgress?.(1, '');
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
