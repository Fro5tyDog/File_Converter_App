import { ACCEPT, kindOf, extOf, baseName, TARGETS, KIND_TARGETS, KIND_LABEL, defaultTarget, engineFor, formatBytes } from './formats.js';
import { convertImage, imagesToAnimatedGif, isHeic } from './convert-image.js';
import { isNative, platform, shareFiles, downloadBlob, canWebShareFiles, clearNativeExports } from './platform.js';
import { initUpdater, checkForUpdates, applyNow, onUpdateState, cacheEngineForOffline, APP_VERSION, BUILD_TIME } from './updater.js';

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

let av = null; // lazily imported video engine module
const getAV = async () => (av ??= await import('./convert-av.js'));

/** @type {Array<any>} */
const items = [];
let seq = 0;
let running = false;
let stopRequested = false;
let combo = null; // combined GIF result item
let avReadyHint = isNative; // native app bundles the engine, no download needed

const queueEl = $('#queue');
const input = $('#fileInput');
input.accept = ACCEPT;

// ---------------------------------------------------------------- adding files
function addFiles(fileList) {
  const files = [...fileList];
  let skipped = 0;
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) { skipped++; continue; }
    const ext = extOf(file.name) || (file.type.split('/')[1] || '').replace('quicktime', 'mov');
    const item = {
      id: ++seq, file, kind, ext,
      target: defaultTarget(kind, ext),
      opts: { quality: 0.9, maxSize: 0, crf: 23, fps: 12, gifWidth: 480, start: 0, length: 0 },
      status: 'ready', result: null, url: null,
    };
    if (kind === 'video' && item.target === 'gif') item.opts.length = 10;
    items.push(item);
    queueEl.append(renderItem(item));
  }
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped — format not supported.`);
  refresh();
}

input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
  if (t === 'dragleave' && e.relatedTarget) return;
  e.preventDefault(); drop.classList.remove('over');
}));
document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
document.addEventListener('paste', e => { const f = e.clipboardData?.files; if (f?.length) addFiles(f); });

// ---------------------------------------------------------------- rendering
function thumbFor(item) {
  const box = el('div', { class: 'thumb' }, (item.ext || item.kind).toUpperCase().slice(0, 4));
  const url = URL.createObjectURL(item.file);
  item.thumbUrl = url;
  const fallback = () => { box.replaceChildren((item.ext || item.kind).toUpperCase().slice(0, 4)); };
  if (item.kind === 'image' || item.kind === 'gif' || item.kind === 'heic') {
    const img = el('img', { alt: '', decoding: 'async' });
    img.onerror = fallback;
    img.onload = () => box.replaceChildren(img);
    img.src = url;
  } else if (item.kind === 'video') {
    const v = el('video', { muted: true, playsinline: true, preload: 'metadata' });
    v.muted = true;
    v.onloadeddata = () => box.replaceChildren(v);
    v.onerror = fallback;
    v.src = url + '#t=0.1';
  }
  return box;
}

function optionControls(item) {
  const t = item.target, k = item.kind;
  const o = item.opts;
  const engine = engineFor(k, t);
  const wrap = [];
  const num = (label, key, attrs = {}) => el('label', {}, label,
    el('input', { type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: o[key] || '', placeholder: attrs.placeholder || '', oninput: e => { o[key] = parseFloat(e.target.value) || 0; resetItem(item); } }));
  const sel = (label, key, options) => {
    const s = el('select', { onchange: e => { o[key] = Number(e.target.value); resetItem(item); } },
      options.map(([v, l]) => el('option', { value: v, selected: Number(o[key]) === Number(v) }, l)));
    return el('label', {}, label, s);
  };

  if (engine === 'image') {
    if (t === 'jpg' || t === 'webp') {
      const out = el('span', {}, ` ${Math.round(o.quality * 100)}`);
      wrap.push(el('label', {}, el('span', {}, 'Quality', out),
        el('input', { type: 'range', min: 40, max: 100, value: Math.round(o.quality * 100), oninput: e => { o.quality = e.target.value / 100; out.textContent = ` ${e.target.value}`; resetItem(item); } })));
    }
    wrap.push(sel('Max size', 'maxSize', [[0, 'Original'], [4096, '4096 px'], [2048, '2048 px'], [1920, '1920 px'], [1280, '1280 px'], [1080, '1080 px'], [720, '720 px'], [480, '480 px']]));
    return wrap;
  }
  if (t === 'gif') {
    wrap.push(sel('Width', 'gifWidth', [[240, '240 px'], [320, '320 px'], [480, '480 px'], [640, '640 px'], [800, '800 px'], [1080, '1080 px']]));
    wrap.push(sel('Frames / sec', 'fps', [[8, '8'], [10, '10'], [12, '12'], [15, '15'], [20, '20'], [24, '24'], [30, '30']]));
  }
  if (['mp4-h264', 'mov', 'webm'].includes(t)) {
    wrap.push(sel('Resolution', 'maxSize', [[0, 'Original'], [1920, '1080p'], [1280, '720p'], [854, '480p']]));
    wrap.push(sel('Quality', 'crf', [[18, 'High'], [23, 'Balanced'], [28, 'Smaller file']]));
  }
  wrap.push(num('Start at (sec)', 'start', { placeholder: '0' }));
  wrap.push(num('Length (sec)', 'length', { placeholder: 'All' }));
  return wrap;
}

function renderItem(item) {
  const sizeWarn = item.file.size > 900 * 1024 * 1024 && item.kind === 'video';
  const li = el('li', { class: 'item', 'data-id': item.id });
  item.el = li;
  const toSel = el('select', { class: 'to', 'aria-label': 'Convert to', onchange: e => setTarget(item, e.target.value) },
    KIND_TARGETS[item.kind].map(t => el('option', { value: t, selected: t === item.target }, TARGETS[t].label)));
  const optsBox = el('div', { class: 'opts', hidden: true });
  const optsBtn = el('button', { class: 'opts-toggle', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const open = optsBox.hidden; optsBox.hidden = !open; optsBtn.setAttribute('aria-expanded', String(open));
  } }, 'Options');

  li.append(
    thumbFor(item),
    el('div', { class: 'meta' },
      el('div', { class: 'name', title: item.file.name }, item.file.name),
      el('div', { class: 'sub' }, `${formatBytes(item.file.size)} · ${KIND_LABEL[item.kind]}`,
        sizeWarn ? el('span', { class: 'warn' }, ' · large file, may run out of memory') : null)),
    el('button', { class: 'icon-btn remove', type: 'button', 'aria-label': 'Remove', onclick: () => removeItem(item) }, '✕'),
    el('div', { class: 'route' },
      el('span', { class: 'fmt' }, (item.ext || item.kind).toUpperCase()),
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      toSel, optsBtn),
    el('p', { class: 'note' }),
    optsBox,
    el('div', { class: 'progress' }, el('div', { class: 'ptrack' }, el('div', { class: 'pbar' })), el('span', { class: 'plabel' })),
    el('div', { class: 'err' }),
    el('div', { class: 'result' }),
  );
  item.optsBox = optsBox;
  updateTargetUI(item);
  return li;
}

function updateTargetUI(item) {
  $('.note', item.el).textContent = TARGETS[item.target].note +
    (engineFor(item.kind, item.target) === 'av' && !avReadyHint ? ' · first video job loads a ~30 MB engine' : '');
  item.optsBox.replaceChildren(...optionControls(item));
  $('.opts-toggle', item.el).hidden = item.optsBox.children.length === 0;
}

function setTarget(item, t) {
  item.target = t;
  if (item.kind === 'video' && t === 'gif' && !item.opts.length) item.opts.length = 10;
  updateTargetUI(item);
  resetItem(item);
}

function resetItem(item) {
  if (item.status === 'working') return;
  item.status = 'ready';
  item.result = null;
  if (item.url) { URL.revokeObjectURL(item.url); item.url = null; }
  item.el.classList.remove('done', 'error');
  refresh();
}

function removeItem(item) {
  if (item.status === 'working') return;
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
  item.el.remove();
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.url) URL.revokeObjectURL(item.url);
  refresh();
}

function setProgress(item, p, label) {
  const bar = $('.pbar', item.el);
  if (p == null) bar.classList.add('indet');
  else { bar.classList.remove('indet'); bar.style.width = `${Math.round(p * 100)}%`; }
  if (label != null) item.label = label;
  $('.plabel', item.el).textContent = (item.label || '') + (p != null && p > 0 && p < 1 ? ` ${Math.round(p * 100)}%` : '');
}

function showResult(item) {
  const { blob, name } = item.result;
  const box = $('.result', item.el);
  const delta = item.file ? Math.round((blob.size / item.file.size - 1) * 100) : null;
  const actions = [];
  actions.push(el('button', { class: 'btn small ghost', type: 'button', onclick: () => openPreview(item) }, 'View'));
  if (isNative || canWebShareFiles([new File([blob], name, { type: blob.type })])) {
    actions.push(el('button', { class: 'btn small primary', type: 'button', onclick: () => saveItems([item]) }, isNative ? 'Save / Share' : 'Share'));
  }
  if (!isNative) actions.push(el('button', { class: 'btn small' + (actions.length > 1 ? ' ghost' : ' primary'), type: 'button', onclick: () => downloadBlob(blob, name) }, 'Download'));
  box.replaceChildren(
    el('div', { class: 'out' }, el('b', {}, '✓ '), name, el('span', {}, ` · ${formatBytes(blob.size)}` + (delta != null && item.file ? ` (${delta > 0 ? '+' : ''}${delta}%)` : ''))),
    ...actions);
}

// ---------------------------------------------------------------- combine images → GIF
const combineSec = $('#combine');
const combineToggle = $('#combineToggle');
const imageItems = () => items.filter(i => ['image', 'heic', 'gif'].includes(i.kind));
combineToggle.addEventListener('change', () => { $('#combineOpts').hidden = !combineToggle.checked; clearCombo(); refresh(); });
$('#combineDelay').addEventListener('change', clearCombo);
$('#combineSize').addEventListener('change', clearCombo);

function clearCombo() {
  if (combo) { combo.el.remove(); if (combo.url) URL.revokeObjectURL(combo.url); combo = null; }
}

async function runCombine() {
  const imgs = imageItems();
  clearCombo();
  combo = { id: 'combo', kind: 'gif', status: 'working', file: null };
  combo.el = el('li', { class: 'item combo working' },
    el('div', { class: 'thumb' }, 'GIF'),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, 'Animated GIF'), el('div', { class: 'sub' }, `${imgs.length} frames`)),
    el('span'),
    el('div', { class: 'progress' }, el('div', { class: 'ptrack' }, el('div', { class: 'pbar' })), el('span', { class: 'plabel' })),
    el('div', { class: 'err' }), el('div', { class: 'result' }));
  queueEl.prepend(combo.el);
  try {
    const { blob } = await imagesToAnimatedGif(imgs.map(i => i.file), {
      delay: Number($('#combineDelay').value), maxSize: Number($('#combineSize').value),
    }, (p, label) => setProgress(combo, p, label));
    combo.result = { blob, name: `animated-${new Date().toISOString().slice(0, 10)}.gif` };
    combo.status = 'done';
    combo.el.classList.replace('working', 'done');
    const t = $('.thumb', combo.el);
    combo.url = URL.createObjectURL(blob);
    t.replaceChildren(el('img', { src: combo.url, alt: '' }));
    showResult(combo);
  } catch (e) {
    combo.status = 'error';
    combo.el.classList.replace('working', 'error');
    $('.err', combo.el).textContent = e.message || String(e);
  }
}

// ---------------------------------------------------------------- converting
async function convertOne(item) {
  item.status = 'working';
  item.el.classList.remove('done', 'error');
  item.el.classList.add('working');
  setProgress(item, null, 'Starting…');
  const name = baseName(item.file.name);
  try {
    const engine = engineFor(item.kind, item.target);
    let out;
    if (engine === 'image') {
      setProgress(item, null, isHeic(item.file) ? 'Decoding HEIC…' : 'Converting…');
      out = await convertImage(item.file, item.target, item.opts, {
        webpFallback: async (png, q) => {
          setProgress(item, null, 'Encoding WebP…');
          return (await getAV()).encodeWebpViaEngine(png, q);
        },
      });
    } else {
      const m = await getAV();
      out = await m.convertAV(item.file, item.target, item.opts, (p, label) => setProgress(item, p, label));
      avReadyHint = true;
    }
    item.result = { blob: out.blob, name: `${name}.${out.ext}` };
    item.status = 'done';
    item.el.classList.replace('working', 'done');
    showResult(item);
  } catch (e) {
    item.status = 'error';
    item.el.classList.remove('working');
    item.el.classList.add('error');
    $('.err', item.el).textContent = stopRequested ? 'Stopped.' : friendlyError(e);
    console.error(e);
  }
}

function friendlyError(e) {
  const msg = e?.message || String(e);
  if (/memory|OOM|Aborted\(\)|RangeError/i.test(msg)) return 'Ran out of memory. Try a shorter clip (Options → Length) or a lower resolution.';
  if (/terminate|called FFmpeg.terminate/i.test(msg)) return 'Stopped.';
  return msg;
}

async function convertAll() {
  if (running) {
    stopRequested = true;
    av?.cancelEngine();
    return;
  }
  running = true; stopRequested = false;
  refresh();
  try {
    const combine = combineToggle.checked && imageItems().length >= 2;
    if (combine && !combo) await runCombine();
    for (const item of items) {
      if (stopRequested) break;
      if (combine && imageItems().includes(item)) continue;
      if (item.status === 'done') continue;
      await convertOne(item);
    }
  } finally {
    running = false; stopRequested = false;
    refresh();
    const done = doneItems();
    if (done.length && document.hidden) toast('Conversion finished.');
  }
}

const doneItems = () => [...(combo?.status === 'done' ? [combo] : []), ...items.filter(i => i.status === 'done')];

async function saveItems(list) {
  try {
    const res = await shareFiles(list.map(i => i.result));
    if (res === 'downloaded') toast('Saved to Downloads.');
  } catch (e) {
    toast(e.message || 'Could not share the file.');
  }
}

// ---------------------------------------------------------------- footer + state
function refresh() {
  const has = items.length > 0;
  $('#bar').hidden = !has;
  $('#emptyNote').hidden = has;
  const imgs = imageItems().length;
  combineSec.hidden = imgs < 2;
  if (imgs < 2 && combineToggle.checked) { combineToggle.checked = false; $('#combineOpts').hidden = true; clearCombo(); }
  $('#combineCount').textContent = `${imgs} images selected`;
  const btn = $('#convertBtn');
  const combining = combineToggle.checked && imgs >= 2;
  const pending = items.filter(i => i.status !== 'done' && !(combining && imageItems().includes(i))).length + (combining && !combo ? 1 : 0);
  btn.textContent = running ? 'Stop' : pending ? `Convert${items.length > 1 ? ` ${pending}` : ''}` : 'Done ✓';
  btn.classList.toggle('danger', running);
  btn.disabled = !running && !pending;
  $('#clearBtn').disabled = running;
  const saveAll = $('#saveAllBtn');
  const done = doneItems();
  saveAll.hidden = running || done.length < 2;
  saveAll.textContent = isNative || canWebShareFiles([new File([''], 'a.png', { type: 'image/png' })]) ? `Save all (${done.length})` : `Download all (${done.length})`;
}

$('#convertBtn').addEventListener('click', convertAll);
$('#saveAllBtn').addEventListener('click', () => saveItems(doneItems()));
$('#clearBtn').addEventListener('click', () => {
  if (running) return;
  [...items].forEach(removeItem);
  clearCombo();
  clearNativeExports();
  refresh();
});

// ---------------------------------------------------------------- preview
function openPreview(item) {
  const { blob } = item.result;
  item.url ??= URL.createObjectURL(blob);
  const body = $('#previewBody');
  let media;
  if (blob.type.startsWith('image/')) media = el('img', { src: item.url, alt: 'Converted image' });
  else if (blob.type.startsWith('video/')) media = el('video', { src: item.url, controls: true, playsinline: true, autoplay: true });
  else media = el('audio', { src: item.url, controls: true, autoplay: true });
  body.replaceChildren(media);
  const dlg = $('#preview');
  dlg.showModal();
  dlg.addEventListener('close', () => { media.pause?.(); body.replaceChildren(); }, { once: true });
}
$('#preview').addEventListener('click', e => { if (e.target.id === 'preview') e.target.close(); });

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(text, action) {
  const t = $('#toast');
  $('#toastText').textContent = text;
  const b = $('#toastBtn');
  b.hidden = !action;
  if (action) { b.textContent = action.label; b.onclick = () => { t.hidden = true; action.run(); }; }
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------------------------------------------------------------- settings & updates
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => settings.showModal());
settings.addEventListener('click', e => { if (e.target === settings) settings.close(); });
$('#verText').textContent = APP_VERSION;
if (BUILD_TIME) $('#verText').title = `Built ${BUILD_TIME}`;
$('#platformText').textContent = isNative ? `${platform === 'ios' ? 'iOS' : 'Android'} app` : (matchMedia('(display-mode: standalone)').matches ? 'Home-screen app' : 'Website');
$('#offlineBox').hidden = isNative;
$('#checkUpdateBtn').addEventListener('click', () => checkForUpdates(true));
$('#applyUpdateBtn').addEventListener('click', () => applyNow());
$('#offlineBtn').addEventListener('click', async () => {
  const b = $('#offlineBtn');
  b.disabled = true;
  try {
    await cacheEngineForOffline(p => (b.textContent = `Downloading… ${Math.round(p * 100)}%`));
    b.textContent = 'Available offline ✓';
  } catch (e) {
    b.disabled = false;
    b.textContent = 'Make available offline';
    toast(e.message || 'Download failed — check your connection.');
  }
});

let toastedVersion = null;
onUpdateState(s => {
  if (s.message) $('#updateMsg').textContent = s.message;
  $('#applyUpdateBtn').hidden = s.status !== 'ready';
  $('#applyUpdateBtn').textContent = isNative ? 'Restart to update' : 'Reload to update';
  $('#checkUpdateBtn').disabled = s.status === 'checking' || s.status === 'downloading';
  $('#updateDot').hidden = s.status !== 'ready';
  if (s.status === 'ready' && toastedVersion !== (s.available || 'web')) {
    toastedVersion = s.available || 'web';
    toast(s.available ? `Update ${s.available} ready.` : 'A new version is ready.', {
      label: running ? 'Later' : (isNative ? 'Restart' : 'Reload'),
      run: () => { if (!running) applyNow(); },
    });
  }
});

window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });

refresh();
initUpdater();
