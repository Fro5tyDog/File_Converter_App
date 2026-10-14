// Small shared UI helpers used by every tab.
import { isNative, shareFiles, downloadBlob, canWebShareFiles } from './platform.js';
import { formatBytes, extOf } from './formats.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

// ---------------------------------------------------------------- toast
let toastTimer;
export function toast(text, action) {
  const t = $('#toast');
  $('#toastText').textContent = text;
  const b = $('#toastBtn');
  b.hidden = !action;
  if (action) { b.textContent = action.label; b.onclick = () => { t.hidden = true; action.run(); }; }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 8000 : 3500);
}

export function friendlyError(e) {
  const msg = e?.message || String(e);
  if (/memory|OOM|Aborted\(\)|RangeError|allocation/i.test(msg)) return 'Ran out of memory. Try a smaller file, a shorter clip or a lower resolution.';
  if (/terminate|called FFmpeg.terminate/i.test(msg)) return 'Stopped.';
  return msg;
}

// ---------------------------------------------------------------- item cards
/** Generic thumbnail for a File (images & videos get a real preview). */
export function thumb(file, label) {
  const tag = (label || extOf(file?.name) || 'FILE').toUpperCase().slice(0, 4);
  const box = el('div', { class: 'thumb' }, tag);
  if (!file) return { box, url: null };
  const type = file.type || '';
  const ext = extOf(file.name);
  const isImg = type.startsWith('image/') || /^(png|jpe?g|webp|gif|heic|heif|avif|bmp)$/.test(ext);
  const isVid = type.startsWith('video/') || /^(mov|mp4|m4v|webm)$/.test(ext);
  if (!isImg && !isVid) return { box, url: null };
  const url = URL.createObjectURL(file);
  if (isImg) {
    const img = el('img', { alt: '', decoding: 'async' });
    img.onload = () => box.replaceChildren(img);
    img.src = url;
  } else {
    const v = el('video', { muted: true, playsinline: true, preload: 'metadata' });
    v.muted = true;
    v.onloadeddata = () => box.replaceChildren(v);
    v.src = url + '#t=0.1';
  }
  return { box, url };
}

export const progressEl = () => el('div', { class: 'progress' }, el('div', { class: 'ptrack' }, el('div', { class: 'pbar' })), el('span', { class: 'plabel' }));

export function setProgress(item, p, label) {
  const bar = $('.pbar', item.el);
  if (!bar) return;
  if (p == null) bar.classList.add('indet');
  else { bar.classList.remove('indet'); bar.style.width = `${Math.round(p * 100)}%`; }
  if (label != null) item.label = label;
  $('.plabel', item.el).textContent = (item.label || '') + (p != null && p > 0 && p < 1 ? ` ${Math.round(p * 100)}%` : '');
}

export function setState(item, state, message) {
  item.status = state;
  item.el.classList.remove('working', 'done', 'error', 'queued');
  if (state !== 'ready') item.el.classList.add(state);
  if (state === 'error') $('.err', item.el).textContent = message || 'Something went wrong.';
  if (state === 'queued') setProgress(item, null, 'Waiting…');
}

export const canShare = () => isNative || canWebShareFiles([new File([''], 'a.png', { type: 'image/png' })]);

export async function saveResults(results) {
  try {
    const res = await shareFiles(results);
    if (res === 'downloaded') toast(results.length > 1 ? 'Saved to Downloads.' : 'Saved to Downloads.');
  } catch (e) {
    toast(e.message || 'Could not share the file.');
  }
}

/**
 * Fill an item's .result box.
 * @param {{el: HTMLElement}} item
 * @param {{blob: Blob, name: string}} result
 * @param {{before?: number, note?: string, extra?: HTMLElement[]}} info
 */
export function showResult(item, result, info = {}) {
  const { blob, name } = result;
  const box = $('.result', item.el);
  let sizeText = ` · ${formatBytes(blob.size)}`;
  if (info.before) {
    const pct = Math.round((blob.size / info.before - 1) * 100);
    sizeText += ` (${pct > 0 ? '+' : ''}${pct}%)`;
  }
  const actions = [el('button', { class: 'btn small ghost', type: 'button', onclick: () => openPreview(result) }, 'View')];
  const shareable = isNative || canWebShareFiles([new File([blob], name, { type: blob.type })]);
  if (shareable) actions.push(el('button', { class: 'btn small primary', type: 'button', onclick: () => saveResults([result]) }, isNative ? 'Save / Share' : 'Share'));
  if (!isNative) actions.push(el('button', { class: `btn small ${shareable ? 'ghost' : 'primary'}`, type: 'button', onclick: () => downloadBlob(blob, name) }, 'Download'));
  box.replaceChildren(
    el('div', { class: 'out' }, el('b', {}, '✓ '), name, el('span', {}, sizeText), info.note ? el('small', {}, info.note) : null),
    ...(info.extra || []), ...actions);
}

// ---------------------------------------------------------------- preview
export function openPreview({ blob, name }) {
  const url = URL.createObjectURL(blob);
  const body = $('#previewBody');
  const type = blob.type;
  let media;
  if (type.startsWith('image/')) media = el('img', { src: url, alt: name });
  else if (type.startsWith('video/')) media = el('video', { src: url, controls: true, playsinline: true, autoplay: true });
  else if (type.startsWith('audio/')) media = el('audio', { src: url, controls: true, autoplay: true });
  else if (type === 'application/pdf') media = el('iframe', { src: url, title: name, class: 'pdf-frame' });
  else media = el('div', { class: 'file-card' }, el('strong', {}, name), el('span', {}, formatBytes(blob.size)));
  body.replaceChildren(media);
  const dlg = $('#preview');
  dlg.showModal();
  dlg.addEventListener('close', () => { media.pause?.(); body.replaceChildren(); URL.revokeObjectURL(url); }, { once: true });
}

// ---------------------------------------------------------------- inputs
/** Wire a drop zone + file input. Global drag/drop & paste go to the active tab (see app.js). */
export function fileInput(input, onFiles) {
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
}

export function select(label, value, options, onChange, attrs = {}) {
  const s = el('select', { ...attrs, onchange: e => onChange(e.target.value) },
    options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
  return label ? el('label', {}, label, s) : s;
}

export const dateStamp = () => new Date().toISOString().slice(0, 10);