// Scan tab: photograph documents → crop (with perspective fix) → clean up → one PDF.
import { decodeImage, isHeic } from '../convert-image.js';
import { createPdf, packBits } from '../pdf-writer.js';
import { processPage as processInline, detectDocument as detectInline } from '../scan-image.js';
import { kindOf } from '../formats.js';
import { $, el, toast, progressEl, setProgress, setState, showResult, friendlyError, fileInput, dateStamp } from '../ui.js';

const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const SRC_MAX = 3000;     // longest side kept from the photo
const SMALL_MAX = 900;    // working copy for thumbnails / detection
const QUALITY = {
  small: { maxPx: 1400, q: 0.6, label: 'Smaller file' },
  balanced: { maxPx: 2000, q: 0.75, label: 'Balanced' },
  sharp: { maxPx: 2800, q: 0.88, label: 'Sharp' },
};
const FILTERS = [['enhance', 'Auto clean'], ['original', 'Original'], ['gray', 'Greyscale'], ['bw', 'Black & white']];

const pages = [];
let seq = 0;
let root;
let busy = false;
let defaultFilter = 'enhance';
let resultItem = null;

// ---------------------------------------------------------------- worker
let worker = null, workerFailed = false, msgId = 0;
const pending = new Map();
function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL('../scan-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      workerFailed = true; worker = null;
      for (const p of pending.values()) p.fallback();
      pending.clear();
    };
  } catch { workerFailed = true; }
  return worker;
}
function runWorker(op, src, settings) {
  const inline = () => {
    if (op === 'detect') return { quad: detectInline(src) };
    return processInline(src, settings);
  };
  const w = getWorker();
  if (!w) return Promise.resolve().then(inline);
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject, fallback: () => { try { resolve(inline()); } catch (e) { reject(e); } } });
    w.postMessage({ id, op, src, settings }); // src is copied so the page keeps its pixels
  });
}

// ---------------------------------------------------------------- canvas helpers
function drawToImageData(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { canvas: c, data };
}
const fit = (w, h, max) => { const s = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; };
const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));
function imageDataToCanvas({ width, height, data }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height), 0, 0);
  return c;
}

// ---------------------------------------------------------------- init
export function init(section) {
  root = section;
  fileInput($('#scanCamera', root), onFiles);
  fileInput($('#scanPick', root), onFiles);
  $('#scanCreate', root).addEventListener('click', createPdfNow);
  $('#scanClear', root).addEventListener('click', () => {
    if (busy) return;
    for (const p of pages.splice(0)) cleanupPage(p);
    clearResult();
    render();
  });
  $('#scanName', root).placeholder = `scan-${dateStamp()}`;
  const filterSel = $('#scanFilterAll', root);
  filterSel.replaceChildren(...FILTERS.map(([v, l]) => el('option', { value: v, selected: v === defaultFilter }, l)));
  filterSel.addEventListener('change', async () => {
    defaultFilter = filterSel.value;
    for (const p of pages) { p.filter = defaultFilter; await refreshThumb(p); }
    clearResult();
  });
  [$('#scanSize', root), $('#scanQuality', root)].forEach(s => s.addEventListener('change', clearResult));
  initEditor();
  render();
}

export const isBusy = () => busy;

export async function onFiles(files) {
  const imgs = files.filter(f => ['image', 'heic'].includes(kindOf(f)));
  if (imgs.length < files.length) toast('Only photos can be scanned. Other files were skipped.');
  for (const file of imgs) await addPage(file);
}

// ---------------------------------------------------------------- pages
async function addPage(file) {
  const page = { id: ++seq, filter: defaultFilter, rotation: 0, quad: FULL, loading: true };
  pages.push(page);
  clearResult();
  render();
  try {
    const img = await decodeImage(file);
    try {
      const [w, h] = fit(img.width, img.height, SRC_MAX);
      const big = drawToImageData(img.source, w, h);
      page.srcBlob = await toBlob(big.canvas, 'image/jpeg', 0.92);
      big.canvas.width = big.canvas.height = 0;
      const [sw, sh] = fit(img.width, img.height, SMALL_MAX);
      page.small = drawToImageData(img.source, sw, sh).data;
    } finally {
      img.close();
    }
    page.srcUrl = URL.createObjectURL(page.srcBlob);
    const { quad } = await runWorker('detect', page.small);
    page.quad = quad || FULL;
    page.detected = !!quad;
    await refreshThumb(page, false);
  } catch (e) {
    console.error(e);
    pages.splice(pages.indexOf(page), 1);
    toast(isHeic(file) ? "Couldn't read this HEIC photo." : `Couldn't read ${file.name}.`);
  }
  page.loading = false;
  render();
}

async function refreshThumb(page, rerender = true) {
  if (!page.small) return;
  const r = await runWorker('process', page.small, { quad: page.quad, rotation: page.rotation, filter: page.filter, maxPx: 600 });
  const c = imageDataToCanvas(r.image);
  const blob = await toBlob(c, 'image/jpeg', 0.8);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
  if (rerender) render();
}

function cleanupPage(p) {
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  if (p.srcUrl) URL.revokeObjectURL(p.srcUrl);
}

function move(page, dir) {
  const i = pages.indexOf(page), j = i + dir;
  if (j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  clearResult();
  render();
}

async function rotatePage(page, turns) {
  page.rotation = (page.rotation + turns + 4) % 4;
  clearResult();
  await refreshThumb(page);
}

function render() {
  const grid = $('#scanPages', root);
  grid.replaceChildren(...pages.map((p, i) => el('li', { class: `page${p.loading ? ' loading' : ''}` },
    el('button', { class: 'page-img', type: 'button', 'aria-label': `Edit page ${i + 1}`, disabled: p.loading, onclick: () => openEditor(p) },
      p.thumbUrl ? el('img', { src: p.thumbUrl, alt: '' }) : el('span', { class: 'spinner', 'aria-hidden': 'true' })),
    el('div', { class: 'page-bar' },
      el('span', { class: 'page-no' }, String(i + 1)),
      el('button', { class: 'mini', type: 'button', 'aria-label': 'Move earlier', disabled: i === 0 || p.loading, onclick: () => move(p, -1) }, '‹'),
      el('button', { class: 'mini', type: 'button', 'aria-label': 'Rotate', disabled: p.loading, onclick: () => rotatePage(p, 1) }, '⟳'),
      el('button', { class: 'mini', type: 'button', 'aria-label': 'Move later', disabled: i === pages.length - 1 || p.loading, onclick: () => move(p, 1) }, '›'),
      el('button', { class: 'mini danger', type: 'button', 'aria-label': 'Delete page', disabled: p.loading, onclick: () => { pages.splice(pages.indexOf(p), 1); cleanupPage(p); clearResult(); render(); } }, '✕')),
  )));
  const has = pages.length > 0;
  $('#scanSettings', root).hidden = !has;
  $('#scanBar', root).hidden = !has;
  $('#scanEmpty', root).hidden = has;
  $('#scanCount', root).textContent = has ? `${pages.length} page${pages.length > 1 ? 's' : ''} · tap a page to crop or change the look` : '';
  const btn = $('#scanCreate', root);
  btn.disabled = busy || !has || pages.some(p => p.loading);
  btn.textContent = busy ? 'Creating…' : 'Create PDF';
  $('#scanClear', root).disabled = busy;
}

// ---------------------------------------------------------------- PDF
function clearResult() {
  if (resultItem) { resultItem.el.remove(); resultItem = null; }
}

async function createPdfNow() {
  if (busy || !pages.length) return;
  busy = true;
  render();
  clearResult();
  const q = QUALITY[$('#scanQuality', root).value] || QUALITY.balanced;
  const name = ($('#scanName', root).value.trim() || `scan-${dateStamp()}`).replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '');
  resultItem = { el: el('li', { class: 'item' },
    el('div', { class: 'thumb' }, 'PDF'),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, `${name}.pdf`), el('div', { class: 'sub' }, `${pages.length} page${pages.length > 1 ? 's' : ''}`)),
    el('span'), progressEl(), el('div', { class: 'err' }), el('div', { class: 'result' })) };
  $('#scanResult', root).replaceChildren(resultItem.el);
  const item = resultItem;
  setState(item, 'working');
  try {
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      setProgress(item, i / pages.length, `Page ${i + 1} of ${pages.length}`);
      const img = await decodeImage(p.srcBlob);
      let src;
      try { src = drawToImageData(img.source, img.width, img.height); } finally { img.close(); }
      const r = await runWorker('process', src.data, { quad: p.quad, rotation: p.rotation, filter: p.filter, maxPx: q.maxPx });
      src.canvas.width = src.canvas.height = 0;
      if (p.filter === 'bw' && r.white) {
        out.push({ type: 'bits', bytes: packBits(r.white, r.image.width, r.image.height), width: r.image.width, height: r.image.height });
      } else {
        const c = imageDataToCanvas(r.image);
        const jpg = await toBlob(c, 'image/jpeg', p.filter === 'enhance' || p.filter === 'gray' ? Math.min(0.92, q.q + 0.05) : q.q);
        c.width = c.height = 0;
        out.push({ type: 'jpeg', bytes: new Uint8Array(await jpg.arrayBuffer()), width: r.image.width, height: r.image.height });
      }
    }
    setProgress(item, 1, 'Writing PDF…');
    const size = $('#scanSize', root).value;
    const blob = await createPdf(out, { pageSize: size, margin: size === 'fit' ? 0 : 14, title: name });
    item.result = { blob, name: `${name}.pdf` };
    setState(item, 'done');
    showResult(item, item.result, { note: ` · ${pages.length} page${pages.length > 1 ? 's' : ''}` });
    if (pages[0]?.thumbUrl) $('.thumb', item.el).replaceChildren(el('img', { src: pages[0].thumbUrl, alt: '' }));
  } catch (e) {
    console.error(e);
    setState(item, 'error', friendlyError(e));
  } finally {
    busy = false;
    render();
  }
}

// ---------------------------------------------------------------- editor
let editing = null;
let draft = null;

function initEditor() {
  const dlg = $('#scanEditor');
  $('#edCancel', dlg).addEventListener('click', () => dlg.close());
  $('#edDone', dlg).addEventListener('click', async () => {
    const p = editing;
    Object.assign(p, draft);
    dlg.close();
    clearResult();
    await refreshThumb(p);
  });
  $('#edAuto', dlg).addEventListener('click', async () => {
    const { quad } = await runWorker('detect', editing.small);
    if (!quad) toast("Couldn't find the page edges — drag the corners instead.");
    draft.quad = quad || FULL;
    drawOverlay();
    if (!$('#edPreviewWrap', dlg).hidden) updatePreview();
  });
  $('#edFull', dlg).addEventListener('click', () => { draft.quad = FULL.map(p => p.slice()); drawOverlay(); updatePreview(); });
  $('#edRotL', dlg).addEventListener('click', () => { draft.rotation = (draft.rotation + 3) % 4; updatePreview(true); });
  $('#edRotR', dlg).addEventListener('click', () => { draft.rotation = (draft.rotation + 1) % 4; updatePreview(true); });
  $('#edPreviewBtn', dlg).addEventListener('click', () => togglePreview());
  $('#edFilters', dlg).replaceChildren(...FILTERS.map(([v, l]) => el('button', { type: 'button', class: 'chip', 'data-f': v, onclick: () => {
    draft.filter = v; markFilter(); updatePreview(true);
  } }, l)));

  // Dragging corners
  const svg = $('#edSvg', dlg);
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('[data-i]');
    if (!h) return;
    drag = Number(h.dataset.i);
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (drag == null) return;
    const r = $('#edImg', dlg).getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    draft.quad = draft.quad.map((p, i) => (i === drag ? [x, y] : p));
    drawOverlay(drag, e);
  });
  const end = () => { if (drag != null) { drag = null; drawOverlay(); } };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { if (dlg.open) drawOverlay(); });
}

function markFilter() {
  for (const b of $('#edFilters').children) b.classList.toggle('on', b.dataset.f === draft.filter);
}

function openEditor(page) {
  editing = page;
  draft = { quad: page.quad.map(p => p.slice()), rotation: page.rotation, filter: page.filter };
  const dlg = $('#scanEditor');
  const img = $('#edImg', dlg);
  $('#edPreviewWrap', dlg).hidden = true;
  $('#edStage', dlg).hidden = false;
  $('#edPreviewBtn', dlg).textContent = 'Preview';
  markFilter();
  img.onload = () => drawOverlay();
  img.src = page.srcUrl;
  dlg.showModal();
  if (img.complete) requestAnimationFrame(() => drawOverlay());
}

function drawOverlay(active = null, ev = null) {
  const dlg = $('#scanEditor');
  const img = $('#edImg', dlg), svg = $('#edSvg', dlg);
  const r = img.getBoundingClientRect(), sr = img.parentElement.getBoundingClientRect();
  if (!r.width) return;
  svg.style.left = `${r.left - sr.left}px`; svg.style.top = `${r.top - sr.top}px`;
  svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
  svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  const pts = draft.quad.map(([x, y]) => [x * r.width, y * r.height]);
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const poly = pts.map(p => p.join(',')).join(' ');
  const kids = [
    mk('path', { d: `M0,0H${r.width}V${r.height}H0Z M${pts.map(p => p.join(',')).join(' L')}Z`, class: 'shade', 'fill-rule': 'evenodd' }),
    mk('polygon', { points: poly, class: 'edge' }),
    ...pts.map(([x, y], i) => {
      const g = mk('g', { 'data-i': i, class: `handle${active === i ? ' active' : ''}` });
      g.append(mk('circle', { cx: x, cy: y, r: 22, class: 'hit' }), mk('circle', { cx: x, cy: y, r: 9, class: 'dot' }));
      return g;
    }),
  ];
  svg.replaceChildren(...kids);
  // Magnifier while dragging so the finger doesn't hide the corner
  const lens = $('#edLens', dlg);
  if (active != null && ev) {
    const [x, y] = pts[active];
    const z = 2.5, size = 110;
    lens.hidden = false;
    lens.style.backgroundImage = `url("${img.src}")`;
    lens.style.backgroundSize = `${r.width * z}px ${r.height * z}px`;
    lens.style.backgroundPosition = `${-x * z + size / 2}px ${-y * z + size / 2}px`;
    // Float above the finger (or below it near the top edge), like the iOS text loupe
    let ly = y - size - 40;
    if (r.top - sr.top + ly < 0) ly = y + 40;
    const lx = Math.min(sr.width - size - (r.left - sr.left) - 4, Math.max(-(r.left - sr.left) + 4, x - size / 2));
    lens.style.left = `${r.left - sr.left + lx}px`;
    lens.style.top = `${r.top - sr.top + ly}px`;
  } else {
    lens.hidden = true;
  }
}

let previewToken = 0;
async function updatePreview(show = false) {
  const dlg = $('#scanEditor');
  if (show && $('#edPreviewWrap', dlg).hidden) return togglePreview();
  if ($('#edPreviewWrap', dlg).hidden) return;
  const token = ++previewToken;
  const r = await runWorker('process', editing.small, { ...draft, maxPx: 1000 });
  if (token !== previewToken) return;
  const c = imageDataToCanvas(r.image);
  const blob = await toBlob(c, 'image/jpeg', 0.85);
  const img = $('#edPreview', dlg);
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
}

function togglePreview() {
  const dlg = $('#scanEditor');
  const wrap = $('#edPreviewWrap', dlg), stage = $('#edStage', dlg);
  const show = wrap.hidden;
  wrap.hidden = !show; stage.hidden = show;
  $('#edPreviewBtn', dlg).textContent = show ? 'Edit corners' : 'Preview';
  if (show) updatePreview(); else requestAnimationFrame(() => drawOverlay());
}