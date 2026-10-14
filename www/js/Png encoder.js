// Palette (8-bit) PNG encoder — the same trick TinyPNG uses to shrink PNGs.
// If the image already has ≤256 distinct colours it is stored losslessly (including
// partial transparency); otherwise colours are reduced with median-cut + dithering.
import { crc32, deflate } from './crc32.js';
import { quantize } from './gif-encoder.js';

function exactPalette(image) {
  const d = image.data;
  const map = new Map();
  const indices = new Uint8Array(image.width * image.height);
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    // Treat all fully transparent pixels as one colour
    const key = d[i + 3] === 0 ? 0 : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
    let idx = map.get(key);
    if (idx === undefined) {
      if (map.size === 256) return null;
      idx = map.size;
      map.set(key, idx);
    }
    indices[p] = idx;
  }
  const count = map.size;
  const palette = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let anyAlpha = false;
  for (const [key, idx] of map) {
    palette[idx * 3] = key >>> 24; palette[idx * 3 + 1] = (key >>> 16) & 255; palette[idx * 3 + 2] = (key >>> 8) & 255;
    alpha[idx] = key & 255;
    if ((key & 255) !== 255) anyAlpha = true;
  }
  return { palette, alpha: anyAlpha ? alpha : null, count, indices };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** True when some pixels are semi-transparent (soft edges) — palette PNG can't keep those after quantizing. */
export function hasSoftAlpha(image) {
  const d = image.data;
  let soft = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) soft++;
  return soft > d.length / 4 * 0.002;
}

/**
 * @param {ImageData} image
 * @param {{dither?: boolean}} opts
 * @returns {Promise<{blob: Blob, lossless: boolean}>}
 */
export async function encodePNG8(image, opts = {}) {
  const { width: w, height: h } = image;
  let palette, alpha = null, count, indices, lossless = true;
  const exact = exactPalette(image);
  if (exact) {
    ({ palette, alpha, count, indices } = exact);
  } else {
    lossless = false;
    const q = quantize(image, { dither: opts.dither !== false });
    count = q.count;
    palette = q.palette.subarray(0, count * 3);
    indices = q.indices;
    if (q.transparentIndex >= 0) {
      alpha = new Uint8Array(count).fill(255);
      alpha[q.transparentIndex] = 0;
    }
  }
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none (best for palette images)
    raw.set(indices.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w); iv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit, indexed colour
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', palette),
  ];
  if (alpha) {
    let last = alpha.length;
    while (last > 0 && alpha[last - 1] === 255) last--; // trailing opaque entries can be omitted
    parts.push(chunk('tRNS', alpha.subarray(0, Math.max(1, last))));
  }
  parts.push(chunk('IDAT', await deflate(raw, 'deflate')), chunk('IEND', new Uint8Array(0)));
  return { blob: new Blob(parts, { type: 'image/png' }), lossless };
}