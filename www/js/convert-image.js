// Still image conversion: decode (incl. HEIC), resize, encode PNG/JPG/WebP/GIF.
import { encodeGIF } from './gif-encoder.js';

/** Run the GIF encoder off the main thread when possible so the UI stays responsive. */
function encodeGIFAsync(frames, opts = {}, onProgress) {
  let worker;
  try { worker = new Worker(new URL('./gif-worker.js', import.meta.url), { type: 'module' }); }
  catch { return Promise.resolve(encodeGIF(frames, { ...opts, onProgress })); }
  return new Promise((resolve, reject) => {
    let started = false;
    worker.onmessage = (e) => {
      started = true;
      if (e.data.progress != null) return onProgress?.(e.data.progress);
      worker.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.bytes);
    };
    worker.onerror = (e) => {
      worker.terminate();
      if (started) return reject(new Error(e.message || 'GIF encoding failed'));
      e.preventDefault?.();
      try { resolve(encodeGIF(frames, { ...opts, onProgress })); } catch (err) { reject(err); }
    };
    worker.postMessage({ frames, opts }); // copied, not transferred, so the main-thread fallback still has the pixels
  });
}

const HEIC2ANY = new URL('../vendor/heic2any.min.js', import.meta.url).href;

export function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

let heicLib = null;
function loadHeicLib() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  heicLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HEIC2ANY;
    s.onload = () => window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC decoder failed to load'));
    s.onerror = () => { heicLib = null; reject(new Error('HEIC decoder files are missing (vendor/heic2any.min.js).')); };
    document.head.appendChild(s);
  });
  return heicLib;
}

function loadViaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/** Decode any image the platform (or our HEIC fallback) understands. Returns a drawable + size. */
export async function decodeImage(file) {
  // 1. Native decoder (Safari/iOS decode HEIC natively; everyone decodes PNG/JPG/WebP/GIF)
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
  } catch {}
  try {
    const img = await loadViaImg(file);
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close() {} };
  } catch {}
  // 2. HEIC fallback (Chrome / Android / Windows)
  if (isHeic(file)) {
    const heic2any = await loadHeicLib();
    let out = await heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0];
    const bmp = await createImageBitmap(out);
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
  }
  throw new Error("This image format can't be read on this device.");
}

function fitSize(w, h, max) {
  if (!max || (w <= max && h <= max)) return [w, h];
  const s = max / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Encoding failed (image may be too large for this device).')), type, quality));
}

export const IMAGE_TARGETS = {
  png: { mime: 'image/png', ext: 'png' },
  jpg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
};

/**
 * @param {File} file
 * @param {'png'|'jpg'|'webp'|'gif'} target
 * @param {{quality?: number, maxSize?: number, background?: string}} opts
 * @param {{webpFallback?: (png: Blob, q: number) => Promise<Blob>}} hooks
 */
export async function convertImage(file, target, opts = {}, hooks = {}) {
  const img = await decodeImage(file);
  try {
    const [w, h] = fitSize(img.width, img.height, opts.maxSize);
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: target === 'gif' });
    if (target === 'jpg') { ctx.fillStyle = opts.background || '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, w, h);

    if (target === 'gif') {
      const bytes = await encodeGIFAsync([ctx.getImageData(0, 0, w, h)], { dither: true });
      return { blob: new Blob([bytes], { type: 'image/gif' }), ext: 'gif', width: w, height: h };
    }
    const t = IMAGE_TARGETS[target];
    const q = opts.quality ?? 0.9;
    let blob = await toBlob(canvas, t.mime, q);
    if (blob.type !== t.mime) {
      // Browser silently fell back to PNG (Safari can't encode WebP from canvas)
      if (target === 'webp' && hooks.webpFallback) blob = await hooks.webpFallback(blob, q);
      else throw new Error(`This device can't create ${target.toUpperCase()} images.`);
    }
    return { blob, ext: t.ext, width: w, height: h };
  } finally {
    img.close();
  }
}

/** Combine several images into one animated GIF. Frames are fitted inside the first image's size. */
export async function imagesToAnimatedGif(files, opts = {}, onProgress) {
  const first = await decodeImage(files[0]);
  const [w, h] = fitSize(first.width, first.height, opts.maxSize || 720);
  first.close();
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i / files.length * 0.5, `Reading frame ${i + 1}/${files.length}`);
    const img = await decodeImage(files[i]);
    ctx.clearRect(0, 0, w, h);
    if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, w, h); }
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img.source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    frames.push(ctx.getImageData(0, 0, w, h));
    img.close();
    await new Promise(r => setTimeout(r));
  }
  onProgress?.(0.5, 'Encoding GIF…');
  const bytes = await encodeGIFAsync(frames, { delay: opts.delay ?? 500, loop: 0, dither: true }, p => onProgress?.(0.5 + p * 0.5));
  return { blob: new Blob([bytes], { type: 'image/gif' }), ext: 'gif', width: w, height: h };
}
