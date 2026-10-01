// Small dependency-free GIF89a encoder.
// Median-cut palette (shared across frames), optional Floyd–Steinberg dithering,
// transparency, looping animation.

/**
 * @param {ImageData[]} frames  all frames must share width/height
 * @param {{delay?: number|number[], loop?: number, dither?: boolean, onProgress?: (p:number)=>void}} opts
 *   delay in milliseconds (per frame or single value), loop 0 = forever
 * @returns {Uint8Array}
 */
export function encodeGIF(frames, opts = {}) {
  if (!frames.length) throw new Error('No frames');
  const { width, height } = frames[0];
  const dither = opts.dither !== false;
  const loop = opts.loop ?? 0;
  const delays = frames.map((_, i) => Array.isArray(opts.delay) ? (opts.delay[i] ?? 100) : (opts.delay ?? 100));

  const { palette, hasAlpha } = buildPalette(frames, hasAlphaPixels(frames) ? 255 : 256);
  const transparentIndex = hasAlpha ? 255 : -1;
  const lookup = makeLookup(palette, hasAlpha ? 255 : 256);

  const out = new ByteWriter(width * height * frames.length * 0.6 + 1024);
  out.str('GIF89a');
  out.u16(width); out.u16(height);
  out.byte(0xf7); // global color table, 8 bits/channel, 256 entries
  out.byte(0); out.byte(0);
  for (let i = 0; i < 256; i++) {
    out.byte(palette[i * 3] | 0); out.byte(palette[i * 3 + 1] | 0); out.byte(palette[i * 3 + 2] | 0);
  }
  if (frames.length > 1) {
    out.byte(0x21); out.byte(0xff); out.byte(11); out.str('NETSCAPE2.0');
    out.byte(3); out.byte(1); out.u16(loop); out.byte(0);
  }

  frames.forEach((frame, fi) => {
    const indices = mapPixels(frame, palette, lookup, transparentIndex, dither);
    // Graphic control extension
    out.byte(0x21); out.byte(0xf9); out.byte(4);
    const disposal = hasAlpha ? 2 : 1;
    out.byte((disposal << 2) | (hasAlpha ? 1 : 0));
    out.u16(Math.max(2, Math.round(delays[fi] / 10)));
    out.byte(hasAlpha ? transparentIndex : 0);
    out.byte(0);
    // Image descriptor
    out.byte(0x2c); out.u16(0); out.u16(0); out.u16(width); out.u16(height); out.byte(0);
    lzwEncode(indices, 8, out);
    opts.onProgress?.((fi + 1) / frames.length);
  });
  out.byte(0x3b);
  return out.result();
}

function hasAlphaPixels(frames) {
  for (const f of frames) {
    const d = f.data;
    for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 128) return true;
  }
  return false;
}

// ---------- palette (median cut over a 5-bit histogram) ----------
function buildPalette(frames, maxColors) {
  const hist = new Uint32Array(32768);
  const sumR = new Float64Array(32768), sumG = new Float64Array(32768), sumB = new Float64Array(32768);
  const total = frames.reduce((n, f) => n + f.width * f.height, 0);
  const step = Math.max(1, Math.floor(total / 600000));
  for (const f of frames) {
    const d = f.data;
    for (let p = 0, n = f.width * f.height; p < n; p += step) {
      const i = p * 4;
      if (d[i + 3] < 128) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist[k]++; sumR[k] += r; sumG[k] += g; sumB[k] += b;
    }
  }
  const bins = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) bins.push({ r: sumR[k] / hist[k], g: sumG[k] / hist[k], b: sumB[k] / hist[k], n: hist[k] });

  const palette = new Uint8Array(768);
  let colors;
  if (bins.length <= maxColors) {
    colors = bins;
  } else {
    let boxes = [makeBox(bins)];
    while (boxes.length < maxColors) {
      let best = -1, bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.bins.length < 2) continue;
        const score = b.range * Math.sqrt(b.count);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) break;
      const [a, c] = splitBox(boxes[best]);
      boxes.splice(best, 1, a, c);
    }
    colors = boxes.map(b => {
      let r = 0, g = 0, bl = 0;
      for (const x of b.bins) { r += x.r * x.n; g += x.g * x.n; bl += x.b * x.n; }
      return { r: r / b.count, g: g / b.count, b: bl / b.count };
    });
  }
  colors.forEach((c, i) => { palette[i * 3] = Math.round(c.r); palette[i * 3 + 1] = Math.round(c.g); palette[i * 3 + 2] = Math.round(c.b); });
  return { palette, hasAlpha: maxColors === 255, count: colors.length };
}

function makeBox(bins) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, count = 0;
  for (const x of bins) {
    if (x.r < rmin) rmin = x.r; if (x.r > rmax) rmax = x.r;
    if (x.g < gmin) gmin = x.g; if (x.g > gmax) gmax = x.g;
    if (x.b < bmin) bmin = x.b; if (x.b > bmax) bmax = x.b;
    count += x.n;
  }
  const rr = (rmax - rmin) * 1.0, gr = (gmax - gmin) * 1.2, br = (bmax - bmin) * 0.8; // perceptual-ish weights
  const axis = rr >= gr && rr >= br ? 'r' : gr >= br ? 'g' : 'b';
  return { bins, count, axis, range: Math.max(rr, gr, br) };
}

function splitBox(box) {
  const ax = box.axis;
  const sorted = box.bins.slice().sort((a, b) => a[ax] - b[ax]);
  let acc = 0, cut = 1;
  const half = box.count / 2;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += sorted[i].n;
    if (acc >= half) { cut = i + 1; break; }
    cut = i + 1;
  }
  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

// ---------- pixel mapping ----------
function makeLookup(palette, n) {
  const cache = new Int16Array(1 << 18).fill(-1); // 6 bits per channel
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let idx = cache[key];
    if (idx >= 0) return idx;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = r - palette[i * 3], dg = g - palette[i * 3 + 1], db = b - palette[i * 3 + 2];
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache[key] = best;
    return best;
  };
}

function mapPixels(frame, palette, lookup, tIndex, dither) {
  const { width: w, height: h, data: d } = frame;
  const out = new Uint8Array(w * h);
  if (!dither) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      out[p] = (tIndex >= 0 && d[i + 3] < 128) ? tIndex : lookup(d[i], d[i + 1], d[i + 2]);
    }
    return out;
  }
  // Floyd–Steinberg with two rolling error rows
  let cur = new Float32Array((w + 2) * 3), next = new Float32Array((w + 2) * 3);
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  for (let y = 0; y < h; y++) {
    next.fill(0);
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4, e = (x + 1) * 3;
      if (tIndex >= 0 && d[i + 3] < 128) { out[p] = tIndex; continue; }
      const r = clamp(d[i] + cur[e]), g = clamp(d[i + 1] + cur[e + 1]), b = clamp(d[i + 2] + cur[e + 2]);
      const idx = lookup(r | 0, g | 0, b | 0);
      out[p] = idx;
      const er = r - palette[idx * 3], eg = g - palette[idx * 3 + 1], eb = b - palette[idx * 3 + 2];
      cur[e + 3] += er * 7 / 16; cur[e + 4] += eg * 7 / 16; cur[e + 5] += eb * 7 / 16;
      next[e - 3] += er * 3 / 16; next[e - 2] += eg * 3 / 16; next[e - 1] += eb * 3 / 16;
      next[e] += er * 5 / 16; next[e + 1] += eg * 5 / 16; next[e + 2] += eb * 5 / 16;
      next[e + 3] += er / 16; next[e + 4] += eg / 16; next[e + 5] += eb / 16;
    }
    const t = cur; cur = next; next = t;
  }
  return out;
}

// ---------- LZW ----------
function lzwEncode(indices, minCodeSize, out) {
  out.byte(minCodeSize);
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1, nextCode = eoiCode + 1;
  let table = new Map();

  const block = new Uint8Array(255);
  let blockLen = 0, cur = 0, curBits = 0;
  const flushBlock = () => { if (blockLen) { out.byte(blockLen); out.bytes(block.subarray(0, blockLen)); blockLen = 0; } };
  const emit = code => {
    cur |= code << curBits; curBits += codeSize;
    while (curBits >= 8) {
      block[blockLen++] = cur & 0xff; cur >>>= 8; curBits -= 8;
      if (blockLen === 255) flushBlock();
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      table = new Map();
      codeSize = minCodeSize + 1; nextCode = eoiCode + 1;
    } else {
      if (nextCode >= (1 << codeSize)) codeSize++;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (curBits > 0) { block[blockLen++] = cur & 0xff; if (blockLen === 255) flushBlock(); }
  flushBlock();
  out.byte(0);
}

class ByteWriter {
  constructor(size) { this.buf = new Uint8Array(Math.max(1024, size | 0)); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  byte(b) { this.ensure(1); this.buf[this.len++] = b; }
  u16(v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  result() { return this.buf.slice(0, this.len); }
}
