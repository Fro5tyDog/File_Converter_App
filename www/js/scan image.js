// Document-scan image processing. Pure functions on {width, height, data} so they run
// in a worker (and can be tested outside the browser).

/** Box-downscale an RGBA image so its longest side is ≤ max. */
export function downscale(img, max) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += Math.max(1, (y1 - y0) >> 2)) {
        for (let xx = x0; xx < x1; xx += Math.max(1, (x1 - x0) >> 2)) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function otsu(values) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

const quadArea = (q) => {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
};

/** Order 4 points clockwise starting at the top-left. */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (z === 0) continue;
    if (sign === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/**
 * Find a sheet of paper (bright, low-saturation region) in a photo.
 * @returns {[number, number][] | null} corners TL, TR, BR, BL as 0–1 fractions of the image
 */
export function detectDocument(img) {
  const small = downscale(img, 256);
  const { width: w, height: h, data } = small;
  const n = w * h;
  const score = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    score[p] = Math.max(0, Math.min(255, (0.299 * r + 0.587 * g + 0.114 * b) - (max - min) * 0.6));
  }
  // 3×3 blur so text inside the page doesn't break it apart
  const blurred = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += score[yy * w + xx]; c++; }
    }
    blurred[y * w + x] = s / c;
  }
  const thr = otsu(blurred);
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) mask[p] = blurred[p] > thr ? 1 : 0;

  // Largest connected bright region
  const label = new Int32Array(n).fill(-1);
  let bestLabel = -1, bestSize = 0, lab = 0;
  const stack = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    let sp = 0, size = 0;
    stack[sp++] = p; label[p] = lab;
    while (sp) {
      const q = stack[--sp]; size++;
      const x = q % w, y = (q / w) | 0;
      if (x > 0 && mask[q - 1] && label[q - 1] < 0) { label[q - 1] = lab; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] && label[q + 1] < 0) { label[q + 1] = lab; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] && label[q - w] < 0) { label[q - w] = lab; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] && label[q + w] < 0) { label[q + w] = lab; stack[sp++] = q + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = lab; }
    lab++;
  }
  if (bestLabel < 0 || bestSize < n * 0.12 || bestSize > n * 0.97) return null;

  // Candidate corners: diagonal extremes (upright pages) and axis extremes (tilted pages)
  const ext = { s0: [Infinity], s1: [-Infinity], d0: [Infinity], d1: [-Infinity], x0: [Infinity], x1: [-Infinity], y0: [Infinity], y1: [-Infinity] };
  for (let p = 0; p < n; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % w + 0.5, y = ((p / w) | 0) + 0.5;
    const s = x + y, d = x - y;
    if (s < ext.s0[0]) ext.s0 = [s, x, y];
    if (s > ext.s1[0]) ext.s1 = [s, x, y];
    if (d < ext.d0[0]) ext.d0 = [d, x, y];
    if (d > ext.d1[0]) ext.d1 = [d, x, y];
    if (x < ext.x0[0]) ext.x0 = [x, x, y];
    if (x > ext.x1[0]) ext.x1 = [x, x, y];
    if (y < ext.y0[0]) ext.y0 = [y, x, y];
    if (y > ext.y1[0]) ext.y1 = [y, x, y];
  }
  const pt = (e) => [e[1], e[2]];
  const candidates = [
    [pt(ext.s0), pt(ext.d1), pt(ext.s1), pt(ext.d0)],
    [pt(ext.y0), pt(ext.x1), pt(ext.y1), pt(ext.x0)],
  ].map(orderQuad).filter(isConvex);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (quadArea(b) > quadArea(a) ? b : a));
  if (quadArea(best) < n * 0.12) return null;
  return best.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
}

// ---------------------------------------------------------------- perspective warp
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let max = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
    [A[i], A[max]] = [A[max], A[i]]; [b[i], b[max]] = [b[max], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

/** Homography mapping (u,v) in the output rectangle → (x,y) in the source. */
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i], [x, y] = to[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return [...solve(A, b), 1];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Output size for a quad (in source pixels), capped to maxPx on the long side. */
export function quadSize(quad, maxPx) {
  const [tl, tr, br, bl] = quad;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, maxPx / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export function warp(src, quad, outW, outH) {
  const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = src.width, sh = src.height, sd = src.data;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5, vv = v + 0.5;
      const z = H[6] * uu + H[7] * vv + H[8];
      let x = (H[0] * uu + H[1] * vv + H[2]) / z - 0.5;
      let y = (H[3] * uu + H[4] * vv + H[5]) / z - 0.5;
      x = Math.min(sw - 1.001, Math.max(0, x)); y = Math.min(sh - 1.001, Math.max(0, y));
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (v * outW + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

export function rotate(img, quarterTurns) {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (!t) return img;
  const { width: w, height: h, data } = img;
  const W = t % 2 ? h : w, Hh = t % 2 ? w : h;
  const out = new Uint8ClampedArray(W * Hh * 4);
  const d32 = new Uint32Array(data.buffer, data.byteOffset, w * h), o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let nx, ny;
    if (t === 1) { nx = h - 1 - y; ny = x; }
    else if (t === 2) { nx = w - 1 - x; ny = h - 1 - y; }
    else { nx = y; ny = w - 1 - x; }
    o32[ny * W + nx] = d32[y * w + x];
  }
  return { width: W, height: Hh, data: out };
}

// ---------------------------------------------------------------- filters
/** Estimate the paper colour at every pixel (removes shadows and uneven light). */
function backgroundMap(img) {
  const { width: w, height: h, data } = img;
  const block = Math.max(8, Math.round(Math.max(w, h) / 40));
  const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
  const bg = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    hist.fill(0);
    let count = 0;
    const step = Math.max(1, block >> 3);
    for (let y = by * block; y < Math.min(h, (by + 1) * block); y += step) {
      for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x += step) {
        const i = (y * w + x) * 4;
        hist[(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0]++; count++;
      }
    }
    // 90th percentile = paper brightness even when the block holds text
    let acc = 0, v = 255;
    for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= count * 0.1) { v = k; break; } }
    bg[by * bw + bx] = Math.max(v, 40);
  }
  // Smooth the block map twice (3×3)
  for (let pass = 0; pass < 2; pass++) {
    const copy = bg.slice();
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) { s += copy[yy * bw + xx]; c++; }
      }
      bg[y * bw + x] = s / c;
    }
  }
  return (x, y) => {
    const fx = Math.min(bw - 1, Math.max(0, x / block - 0.5)), fy = Math.min(bh - 1, Math.max(0, y / block - 0.5));
    const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const top = bg[y0 * bw + x0] * (1 - ax) + bg[y0 * bw + x1] * ax;
    const bot = bg[y1 * bw + x0] * (1 - ax) + bg[y1 * bw + x1] * ax;
    return top * (1 - ay) + bot * ay;
  };
}

/**
 * @param {'original'|'enhance'|'gray'|'bw'} filter
 * @returns {{image, white?: Uint8Array}} white = 1-bit mask (1 = paper) for 'bw'
 */
export function applyFilter(img, filter) {
  if (filter === 'original') return { image: img };
  const { width: w, height: h } = img;
  const d = img.data;
  const out = new Uint8ClampedArray(d.length);
  if (filter === 'gray') {
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      out[i] = out[i + 1] = out[i + 2] = l; out[i + 3] = 255;
    }
    return { image: { width: w, height: h, data: out } };
  }
  const bgAt = backgroundMap(img);
  const white = filter === 'bw' ? new Uint8Array(w * h) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const k = 255 / bgAt(x, y);
      if (filter === 'bw') {
        const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * k;
        const on = l > 180 ? 1 : 0;
        white[y * w + x] = on;
        out[i] = out[i + 1] = out[i + 2] = on ? 255 : 0;
      } else {
        // enhance: flatten lighting, then stretch so paper is white and ink is dark
        for (let c = 0; c < 3; c++) {
          const v = d[i + c] * k;
          out[i + c] = (v - 55) * 1.32;
        }
      }
      out[i + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data: out }, white };
}

/**
 * Full pipeline for one page.
 * @param {{width,height,data}} src  decoded photo (already size-limited)
 * @param {{quad: [number,number][], rotation: number, filter: string, maxPx: number}} s  quad in 0–1 fractions
 */
export function processPage(src, s) {
  const quad = s.quad.map(([x, y]) => [x * src.width, y * src.height]);
  const full = quad[0][0] <= 0.5 && quad[0][1] <= 0.5 && quad[2][0] >= src.width - 0.5 && quad[2][1] >= src.height - 0.5 &&
    quad[1][0] >= src.width - 0.5 && quad[1][1] <= 0.5 && quad[3][0] <= 0.5 && quad[3][1] >= src.height - 0.5;
  let img;
  if (full) {
    img = Math.max(src.width, src.height) > s.maxPx ? downscale(src, s.maxPx) : src;
  } else {
    const [w, h] = quadSize(quad, s.maxPx);
    img = warp(src, quad, w, h);
  }
  img = rotate(img, s.rotation || 0);
  return applyFilter(img, s.filter || 'original');
}
