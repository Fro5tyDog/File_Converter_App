// Compress tab: make photos, videos, audio, GIFs and PDFs smaller.
import { decodeImage } from '../convert-image.js';
import { encodePNG8, hasSoftAlpha } from '../png-encoder.js';
import { kindOf, extOf, baseName, formatBytes } from '../formats.js';
import { $, el, thumb, progressEl, setProgress, setState, showResult, saveResults, canShare, friendlyError, fileInput } from '../ui.js';

let av = null;
const getAV = async () => (av ??= await import('../convert-av.js'));

const LEVELS = {
  light:    { label: 'Light',    img: { maxPx: 4096, q: 0.82 }, video: { crf: 26, maxSize: 1920, audioBitrate: '128k' }, audio: '128k', gif: { fps: 15, gifWidth: 640 }, pdf: { dpi: 150, quality: 0.75 } },
  balanced: { label: 'Balanced', img: { maxPx: 2560, q: 0.72 }, video: { crf: 28, maxSize: 1280, audioBitrate: '96k' },  audio: '96k',  gif: { fps: 12, gifWidth: 480 }, pdf: { dpi: 120, quality: 0.62 } },
  strong:   { label: 'Strong',   img: { maxPx: 1600, q: 0.58 }, video: { crf: 32, maxSize: 854,  audioBitrate: '64k' },  audio: '64k',  gif: { fps: 10, gifWidth: 360 }, pdf: { dpi: 90,  quality: 0.5 } },
};

const items = [];
const queue = [];
let seq = 0, pumping = false, current = null, root;

export function init(section) {
  root = section;
  const input = $('#compInput', root);
  fileInput(input, onFiles);
  $('#compAll', root).addEventListener('click', () => (pumping ? stopAll() : compressAll()));
  $('#compSaveAll', root).addEventListener('click', () => saveResults(items.filter(i => i.status === 'done').map(i => i.result)));
  $('#compClear', root).addEventListener('click', () => { if (!pumping) { [...items].forEach(removeItem); refresh(); } });
  $('#compLevel', root).addEventListener('change', resetAll);
  $('#compTarget', root).addEventListener('change', resetAll);
  refresh();
}

export const isBusy = () => pumping;

function typeOf(file) {
  const k = kindOf(file);
  if (k === 'image' || k === 'heic') return 'image';
  if (k === 'gif' || k === 'video' || k === 'audio') return k;
  if (file.type === 'application/pdf' || extOf(file.name) === 'pdf') return 'pdf';
  return 'other';
}

const NOTES = {
  image: 'Re-encodes and resizes the photo',
  gif: 'Fewer colours, frames and pixels',
  video: 'Re-encodes to H.264 MP4 · can take a while on a phone',
  audio: 'Lower bitrate',
  pdf: 'Turns pages into images · text will no longer be selectable',
  other: "This type can't be shrunk here. Zipping it may help a little.",
};

export function onFiles(files) {
  for (const file of files) {
    const item = { id: ++seq, file, type: typeOf(file), status: 'ready' };
    items.push(item);
    $('#compList', root).append(render(item));
  }
  refresh();
}

function render(item) {
  const t = thumb(item.file, extOf(item.file.name) || item.type);
  item.thumbUrl = t.url;
  const li = el('li', { class: `item${item.type === 'other' ? ' unsupported' : ''}` });
  item.el = li;
  const actions = item.type === 'other'
    ? el('button', { class: 'btn small', type: 'button', onclick: () => sendToZip(item) }, 'Send to Zip')
    : el('button', { class: 'btn small primary go', type: 'button', onclick: () => enqueue(item) }, 'Compress');
  li.append(
    t.box,
    el('div', { class: 'meta' },
      el('div', { class: 'name', title: item.file.name }, item.file.name),
      el('div', { class: 'sub' }, formatBytes(item.file.size))),
    el('button', { class: 'icon-btn remove', type: 'button', 'aria-label': 'Remove', onclick: () => removeItem(item) }, '✕'),
    el('div', { class: 'route' }, el('p', { class: 'note inline' }, NOTES[item.type]), actions),
    progressEl(), el('div', { class: 'err' }), el('div', { class: 'result' }));
  return li;
}

function sendToZip(item) {
  document.dispatchEvent(new CustomEvent('send-to', { detail: { tab: 'zip', files: [item.file] } }));
  removeItem(item);
}

function removeItem(item) {
  if (item.status === 'working') return;
  const qi = queue.indexOf(item);
  if (qi >= 0) queue.splice(qi, 1);
  items.splice(items.indexOf(item), 1);
  item.el.remove();
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  refresh();
}

function resetAll() {
  for (const i of items) if (i.status === 'done' || i.status === 'error') { i.result = null; setState(i, 'ready'); }
  refresh();
}

// ---------------------------------------------------------------- queue
function enqueue(item) {
  if (item.type === 'other' || item.status === 'working' || item.status === 'queued') return;
  setState(item, 'queued');
  queue.push(item);
  refresh();
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true; refresh();
  try {
    while (queue.length) {
      current = queue.shift();
      await run(current);
      current = null;
      refresh();
    }
  } finally { pumping = false; refresh(); }
}

function compressAll() {
  for (const i of items) if (i.type !== 'other' && (i.status === 'ready' || i.status === 'error')) enqueue(i);
}

function stopAll() {
  for (const job of queue.splice(0)) setState(job, 'ready');
  if (current && ['video', 'audio', 'gif'].includes(current.type)) { current.stopped = true; av?.cancelEngine(); }
  refresh();
}

async function run(item) {
  setState(item, 'working');
  setProgress(item, null, 'Starting…');
  const level = LEVELS[$('#compLevel', root).value] || LEVELS.balanced;
  const target = Number($('#compTarget', root).value) || 0;
  const name = baseName(item.file.name);
  try {
    let out;
    if (item.type === 'image') out = await compressImage(item, level.img, target);
    else if (item.type === 'pdf') {
      const { rasterizePdf } = await import('../pdf-raster.js');
      out = { blob: await rasterizePdf(item.file, level.pdf, (p, l) => setProgress(item, p, l)), ext: 'pdf' };
    } else {
      const m = await getAV();
      const onP = (p, l) => setProgress(item, p, l);
      if (item.type === 'video') out = await m.convertAV(item.file, 'mp4-h264', { ...level.video, preset: 'veryfast' }, onP);
      else if (item.type === 'gif') out = await m.convertAV(item.file, 'gif', level.gif, onP);
      else {
        const ext = extOf(item.file.name);
        out = await m.convertAV(item.file, ['m4a', 'aac', 'mp4'].includes(ext) ? 'm4a' : 'mp3', { audioBitrate: level.audio }, onP);
      }
    }
    let note = '';
    if (out.blob.size >= item.file.size) {
      // Never hand back something bigger than what went in
      out = { blob: item.file.slice(0, item.file.size, item.file.type), ext: extOf(item.file.name) };
      note = ' · already well compressed, kept the original';
    } else if (target && out.blob.size > target) {
      note = ` · couldn't reach ${formatBytes(target)}`;
    }
    item.result = { blob: out.blob, name: `${name}.${out.ext}` };
    setState(item, 'done');
    showResult(item, item.result, { before: item.file.size, note: note || out.note });
  } catch (e) {
    console.error(e);
    setState(item, 'error', item.stopped ? 'Stopped.' : friendlyError(e));
    item.stopped = false;
  }
}

// ---------------------------------------------------------------- images
const encode = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Encoding failed'))), type, q));

async function compressImage(item, opts, target) {
  setProgress(item, null, 'Reading photo…');
  const img = await decodeImage(item.file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const draw = (maxPx, bg) => {
    const s = Math.min(1, maxPx / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * s));
    canvas.height = Math.max(1, Math.round(img.height * s));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
  };
  try {
    const srcExt = extOf(item.file.name);
    const pngLike = ['png', 'bmp', 'tif', 'tiff', 'ico'].includes(srcExt) || item.file.type === 'image/png';
    let maxPx = opts.maxPx;

    if (pngLike) {
      draw(maxPx);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let alpha = false;
      for (let i = 3; i < data.data.length; i += 4) if (data.data[i] < 255) { alpha = true; break; }
      setProgress(item, null, 'Reducing colours…');
      let png = await encodePNG8(data);
      // Soft (semi-transparent) edges can't survive colour reduction → fall back to a normal PNG
      if (!png.lossless && hasSoftAlpha(data)) png = { blob: await encode(canvas, 'image/png'), lossless: true };
      if (alpha) return { blob: png.blob, ext: 'png' }; // must keep transparency
      if (!target || png.blob.size <= target) {
        if (png.lossless) return { blob: png.blob, ext: 'png' };
        // Photo saved as PNG: JPEG is usually far smaller
        draw(maxPx, '#fff');
        const jpg = await encode(canvas, 'image/jpeg', opts.q);
        if (jpg.size < png.blob.size * 0.6) return { blob: jpg, ext: 'jpg', note: ' · saved as JPG' };
        return { blob: png.blob, ext: 'png' };
      }
      // Need to hit a size target and transparency isn't involved → JPEG path below
    }

    // JPEG, with an optional size target: lower quality first, then shrink dimensions
    let q = opts.q, blob;
    for (let attempt = 0; attempt < 8; attempt++) {
      draw(maxPx, '#fff');
      setProgress(item, null, attempt ? `Fitting under ${formatBytes(target)}…` : 'Compressing…');
      blob = await encode(canvas, 'image/jpeg', q);
      if (!target || blob.size <= target) break;
      if (q > 0.45) {
        // Binary-ish step down in quality
        q = Math.max(0.45, q - (blob.size > target * 1.6 ? 0.2 : 0.1));
      } else {
        maxPx = Math.round(Math.max(canvas.width, canvas.height) * Math.max(0.5, Math.sqrt(target / blob.size) * 0.95));
        q = 0.6;
      }
    }
    return { blob, ext: 'jpg', note: pngLike ? ' · saved as JPG' : '' };
  } finally {
    canvas.width = canvas.height = 0;
    img.close();
  }
}

// ---------------------------------------------------------------- state
function refresh() {
  const has = items.length > 0;
  $('#compBar', root).hidden = !has;
  $('#compEmpty', root).hidden = has;
  const pending = items.filter(i => i.type !== 'other' && (i.status === 'ready' || i.status === 'error')).length;
  const btn = $('#compAll', root);
  btn.textContent = pumping ? 'Stop' : pending ? (items.length > 1 ? `Compress all (${pending})` : 'Compress') : 'Done ✓';
  btn.classList.toggle('danger', pumping);
  btn.disabled = !pumping && !pending;
  $('#compClear', root).disabled = pumping;
  const done = items.filter(i => i.status === 'done');
  const saved = done.reduce((n, i) => n + (i.file.size - i.result.blob.size), 0);
  $('#compSummary', root).textContent = done.length ? `Saved ${formatBytes(saved)} so far` : '';
  const saveAll = $('#compSaveAll', root);
  saveAll.hidden = pumping || done.length < 2;
  saveAll.textContent = `${canShare() ? 'Save' : 'Download'} all (${done.length})`;
  root.classList.toggle('single', items.length === 1);
}