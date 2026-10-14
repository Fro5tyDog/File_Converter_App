// Tiny PDF writer for image pages (scanned documents, rasterised PDFs).
// Colour/grey pages are embedded as JPEG (DCTDecode); black & white pages as 1-bit Flate,
// which keeps text crisp and files very small.
import { deflate } from './crc32.js';

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const latin1 = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

function pdfString(s) {
  // UTF-16BE with BOM so any title works
  let hex = 'FEFF';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) {
      const v = c - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += c.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}

/** Pack a greyscale/threshold mask (1 = white) into PDF 1-bit rows. */
export function packBits(white, width, height) {
  const rowBytes = (width + 7) >> 3;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (white[y * width + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/**
 * @param {Array<{type:'jpeg', bytes:Uint8Array, width:number, height:number}
 *              | {type:'bits', bytes:Uint8Array, width:number, height:number}>} pages
 *   'bits' = output of packBits (1 bit per pixel, 1 = white)
 * @param {{pageSize?: 'a4'|'letter'|'fit', margin?: number, title?: string}} opts
 * @returns {Promise<Blob>}
 */
export async function createPdf(pages, opts = {}) {
  if (!pages.length) throw new Error('No pages');
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => { const bytes = typeof b === 'string' ? latin1(b) : b; chunks.push(bytes); pos += bytes.length; };
  const obj = (n, body, stream) => {
    offsets[n] = pos;
    if (stream) {
      push(`${n} 0 obj\n${body}\nstream\n`);
      push(stream);
      push('\nendstream\nendobj\n');
    } else {
      push(`${n} 0 obj\n${body}\nendobj\n`);
    }
  };

  // Object numbers: 1 catalog, 2 pages, 3 info, then 3 per page (page, content, image)
  const pageIds = pages.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Producer (Convert app) /CreationDate ${pdfDate()}${opts.title ? ` /Title ${pdfString(opts.title)}` : ''} >>`);

  const margin = opts.margin ?? 0;
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    const landscape = pg.width > pg.height;
    let pw, ph;
    if (pg.pageSize) {
      [pw, ph] = pg.pageSize; // exact size in points (used when re-building an existing PDF)
    } else if (opts.pageSize === 'letter' || opts.pageSize === 'a4') {
      [pw, ph] = PAGE_SIZES[opts.pageSize];
      if (landscape) [pw, ph] = [ph, pw];
    } else {
      // Fit: page matches the image's shape, long side the length of A4
      const long = PAGE_SIZES.a4[1];
      const s = long / Math.max(pg.width, pg.height);
      pw = pg.width * s; ph = pg.height * s;
    }
    const s = Math.min((pw - 2 * margin) / pg.width, (ph - 2 * margin) / pg.height);
    const dw = pg.width * s, dh = pg.height * s;
    const dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    const f = (n) => (Math.round(n * 100) / 100).toString();

    const [pageId, contentId, imageId] = [pageIds[i], pageIds[i] + 1, pageIds[i] + 2];
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const content = latin1(`q ${f(dw)} 0 0 ${f(dh)} ${f(dx)} ${f(dy)} cm /Im0 Do Q`);
    obj(contentId, `<< /Length ${content.length} >>`, content);
    if (pg.type === 'jpeg') {
      obj(imageId, `<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>`, pg.bytes);
    } else {
      const data = await deflate(pg.bytes, 'deflate');
      obj(imageId, `<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [0 1] /Filter /FlateDecode /Length ${data.length} >>`, data);
    }
  }

  const total = 4 + pages.length * 3;
  const xref = pos;
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}