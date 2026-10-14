// Shrink a PDF by re-rendering each page as a JPEG image (pdf.js → canvas → pdf-writer).
// Very effective for scans and photo-heavy PDFs; text stops being selectable.
import { createPdf } from './pdf-writer.js';

const base = new URL('../', import.meta.url);
const PDFJS = new URL('vendor/pdfjs/pdf.min.mjs', base).href;
const PDFJS_WORKER = new URL('vendor/pdfjs/pdf.worker.min.mjs', base).href;
const asset = (dir) => new URL(`vendor/pdfjs/${dir}/`, base).href;

let lib = null;
async function loadPdfJs() {
  if (lib) return lib;
  try {
    lib = await import(PDFJS);
  } catch {
    throw new Error('PDF engine files are missing (vendor/pdfjs). Run "npm run build".');
  }
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(async b => {
    if (!b) return reject(new Error('Could not encode page (too large for this device?)'));
    resolve(new Uint8Array(await b.arrayBuffer()));
  }, 'image/jpeg', quality));
}

/**
 * @param {File|Blob} file
 * @param {{dpi: number, quality: number, gray?: boolean}} opts
 * @param {(p:number, label:string)=>void} onProgress
 */
export async function rasterizePdf(file, opts, onProgress) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data, isEvalSupported: false,
      cMapUrl: asset('cmaps'), cMapPacked: true,
      standardFontDataUrl: asset('standard_fonts'), wasmUrl: asset('wasm'), iccUrl: asset('iccs'),
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('This PDF is password-protected.');
    throw new Error("This PDF couldn't be opened.");
  }
  const pages = [];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: !!opts.gray });
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.((n - 1) / doc.numPages, `Page ${n} of ${doc.numPages}`);
      const page = await doc.getPage(n);
      const size = page.getViewport({ scale: 1 });             // size in points
      let scale = opts.dpi / 72;
      // Keep canvases within iOS limits (~16 MP)
      const maxPixels = 14e6;
      if (size.width * size.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (size.width * size.height));
      const vp = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
      if (opts.gray) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        ctx.putImageData(img, 0, 0);
      }
      pages.push({ type: 'jpeg', bytes: await canvasToJpeg(canvas, opts.quality), width: canvas.width, height: canvas.height, pageSize: [size.width, size.height] });
      page.cleanup();
    }
  } finally {
    canvas.width = canvas.height = 0;
    doc.destroy();
  }
  onProgress?.(1, 'Writing PDF…');
  return createPdf(pages, {});
}