// Convert tab: change file formats. Each file has its own Convert button; "Convert all" queues the rest.
import { ACCEPT, kindOf, extOf, baseName, TARGETS, KIND_TARGETS, KIND_LABEL, defaultTarget, engineFor, formatBytes } from '../formats.js';
import { convertImage, imagesToAnimatedGif, isHeic } from '../convert-image.js';
import { isNative } from '../platform.js';
import { $, el, toast, thumb, progressEl, setProgress, setState, showResult, saveResults, canShare, friendlyError, fileInput, dateStamp } from '../ui.js';

let av = null;
const getAV = async () => (av ??= await import('../convert-av.js'));

const items = [];
const queue = [];
let seq = 0;
let pumping = false;
let current = null;
let combo = null;
let avReadyHint = isNative;
let root;

export function init(section) {
  root = section;
  const input = $('#convInput', root);
  input.accept = ACCEPT;
  fileInput(input, addFiles);
  $('#convAll', root).addEventListener('click', () => (pumping ? stopAll() : convertAll()));
  $('#convSaveAll', root).addEventListener('click', () => saveResults(doneResults()));
  $('#convClear', root).addEventListener('click', clearAll);
  const toggle = $('#combineToggle', root);
  toggle.addEventListener('change', () => { $('#combineOpts', root).hidden = !toggle.checked; clearCombo(); refresh(); });
  $('#combineDelay', root).addEventListener('change', clearCombo);
  $('#combineSize', root).addEventListener('change', clearCombo);
  refresh();
}

export const isBusy = () => pumping;
export const onFiles = (files) => addFiles(files);

// ---------------------------------------------------------------- adding
function addFiles(files) {
  let skipped = 0;
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) { skipped++; continue; }
    const ext = extOf(file.name) || (file.type.split('/')[1] || '').replace('quicktime', 'mov');
    const item = {
      id: ++seq, file, kind, ext,
      target: defaultTarget(kind, ext),
      opts: { quality: 0.9, maxSize: 0, crf: 23, fps: 12, gifWidth: 480, start: 0, length: 0 },
      status: 'ready', result: null,
    };
    if (kind === 'video' && item.target === 'gif') item.opts.length = 10;
    items.push(item);
    $('#convList', root).append(renderItem(item));
  }
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's' : ''} skipped — format not supported here. Try the Zip tab.`);
  refresh();
}

// ---------------------------------------------------------------- rendering
function optionControls(item) {
  const t = item.target, o = item.opts;
  const engine = engineFor(item.kind, t);
  const wrap = [];
  const num = (label, key, placeholder) => el('label', {}, label,
    el('input', { type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: o[key] || '', placeholder, oninput: e => { o[key] = parseFloat(e.target.value) || 0; resetItem(item); } }));
  const sel = (label, key, options) => el('label', {}, label,
    el('select', { onchange: e => { o[key] = Number(e.target.value); resetItem(item); } },
      options.map(([v, l]) => el('option', { value: v, selected: Number(o[key]) === Number(v) }, l))));

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
  wrap.push(num('Start at (sec)', 'start', '0'));
  wrap.push(num('Length (sec)', 'length', 'All'));
  return wrap;
}

function renderItem(item) {
  const sizeWarn = item.file.size > 900 * 1024 * 1024 && item.kind === 'video';
  const li = el('li', { class: 'item' });
  item.el = li;
  const t = thumb(item.file, item.ext || item.kind);
  item.thumbUrl = t.url;
  const toSel = el('select', { class: 'to', 'aria-label': 'Convert to', onchange: e => setTarget(item, e.target.value) },
    KIND_TARGETS[item.kind].map(k => el('option', { value: k, selected: k === item.target }, TARGETS[k].label)));
  const optsBox = el('div', { class: 'opts', hidden: true });
  const optsBtn = el('button', { class: 'opts-toggle', type: 'button', 'aria-expanded': 'false', onclick: () => {
    const open = optsBox.hidden; optsBox.hidden = !open; optsBtn.setAttribute('aria-expanded', String(open));
  } }, 'Options');
  const go = el('button', { class: 'btn small primary go', type: 'button', onclick: () => enqueue(item) }, 'Convert');

  li.append(
    t.box,
    el('div', { class: 'meta' },
      el('div', { class: 'name', title: item.file.name }, item.file.name),
      el('div', { class: 'sub' }, `${formatBytes(item.file.size)} · ${KIND_LABEL[item.kind]}`,
        sizeWarn ? el('span', { class: 'warn' }, ' · large file, may run out of memory') : null)),
    el('button', { class: 'icon-btn remove', type: 'button', 'aria-label': 'Remove', onclick: () => removeItem(item) }, '✕'),
    el('div', { class: 'route' },
      el('span', { class: 'fmt' }, (item.ext || item.kind).toUpperCase()),
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
      toSel, optsBtn, go),
    el('p', { class: 'note' }),
    optsBox, progressEl(), el('div', { class: 'err' }), el('div', { class: 'result' }),
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
  if (item.status === 'working' || item.status === 'queued') return;
  item.result = null;
  setState(item, 'ready');
  refresh();
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

function clearAll() {
  if (pumping) return;
  [...items].forEach(removeItem);
  clearCombo();
  refresh();
}

// ---------------------------------------------------------------- combine images → GIF
const imageItems = () => items.filter(i => ['image', 'heic', 'gif'].includes(i.kind));
const combining = () => $('#combineToggle', root).checked && imageItems().length >= 2;

function clearCombo() {
  if (combo && combo.status !== 'working') {
    const qi = queue.indexOf(combo);
    if (qi >= 0) queue.splice(qi, 1);
    combo.el.remove(); combo = null;
  }
}

function makeCombo() {
  const n = imageItems().length;
  combo = { id: 'combo', isCombo: true, status: 'ready' };
  combo.el = el('li', { class: 'item combo' },
    el('div', { class: 'thumb' }, 'GIF'),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, 'Animated GIF'), el('div', { class: 'sub' }, `${n} frames`)),
    el('span'), progressEl(), el('div', { class: 'err' }), el('div', { class: 'result' }));
  $('#convList', root).prepend(combo.el);
  return combo;
}

async function runCombine(job) {
  const { blob } = await imagesToAnimatedGif(imageItems().map(i => i.file), {
    delay: Number($('#combineDelay', root).value), maxSize: Number($('#combineSize', root).value),
  }, (p, label) => setProgress(job, p, label));
  job.result = { blob, name: `animated-${dateStamp()}.gif` };
  const url = URL.createObjectURL(blob);
  $('.thumb', job.el).replaceChildren(el('img', { src: url, alt: '' }));
}

// ---------------------------------------------------------------- queue
function enqueue(item) {
  if (item.status === 'working' || item.status === 'queued') return;
  setState(item, 'queued');
  queue.push(item);
  refresh();
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  refresh();
  try {
    while (queue.length) {
      const job = queue.shift();
      current = job;
      await runJob(job);
      current = null;
      refresh();
    }
  } finally {
    pumping = false;
    refresh();
    if (document.hidden && doneResults().length) toast('Conversion finished.');
  }
}

async function runJob(job) {
  setState(job, 'working');
  setProgress(job, null, 'Starting…');
  try {
    if (job.isCombo) {
      await runCombine(job);
    } else {
      const engine = engineFor(job.kind, job.target);
      let out;
      if (engine === 'image') {
        setProgress(job, null, isHeic(job.file) ? 'Decoding HEIC…' : 'Converting…');
        out = await convertImage(job.file, job.target, job.opts, {
          webpFallback: async (png, q) => { setProgress(job, null, 'Encoding WebP…'); return (await getAV()).encodeWebpViaEngine(png, q); },
        });
      } else {
        out = await (await getAV()).convertAV(job.file, job.target, job.opts, (p, label) => setProgress(job, p, label));
        avReadyHint = true;
      }
      job.result = { blob: out.blob, name: `${baseName(job.file.name)}.${out.ext}` };
    }
    setState(job, 'done');
    showResult(job, job.result, { before: job.file?.size });
  } catch (e) {
    console.error(e);
    setState(job, 'error', job.stopped ? 'Stopped.' : friendlyError(e));
  }
}

function convertAll() {
  if (combining() && !combo) makeCombo();
  if (combo && combo.status !== 'done') enqueue(combo);
  for (const item of items) {
    if (combining() && imageItems().includes(item)) continue;
    if (item.status === 'ready' || item.status === 'error') enqueue(item);
  }
}

function stopAll() {
  for (const job of queue.splice(0)) setState(job, 'ready');
  if (current && !current.isCombo && engineFor(current.kind, current.target) === 'av') {
    current.stopped = true;
    av?.cancelEngine();
  }
  refresh();
}

const doneResults = () => [...(combo?.status === 'done' ? [combo] : []), ...items.filter(i => i.status === 'done')].map(i => i.result);

// ---------------------------------------------------------------- footer + state
function refresh() {
  const has = items.length > 0;
  $('#convBar', root).hidden = !has;
  $('#convEmpty', root).hidden = has;
  const imgs = imageItems().length;
  const toggle = $('#combineToggle', root);
  $('#combine', root).hidden = imgs < 2;
  if (imgs < 2 && toggle.checked) { toggle.checked = false; $('#combineOpts', root).hidden = true; clearCombo(); }
  $('#combineCount', root).textContent = `${imgs} images selected`;

  const pending = items.filter(i => (i.status === 'ready' || i.status === 'error') && !(combining() && imageItems().includes(i))).length
    + (combining() && (!combo || combo.status === 'ready' || combo.status === 'error') ? 1 : 0);
  const btn = $('#convAll', root);
  btn.textContent = pumping ? `Stop${queue.length ? ` (${queue.length + 1} left)` : ''}` : pending ? (items.length > 1 ? `Convert all (${pending})` : 'Convert') : 'Done ✓';
  btn.classList.toggle('danger', pumping);
  btn.disabled = !pumping && !pending;
  $('#convClear', root).disabled = pumping;
  const done = doneResults();
  const saveAll = $('#convSaveAll', root);
  saveAll.hidden = pumping || done.length < 2;
  saveAll.textContent = `${canShare() ? 'Save' : 'Download'} all (${done.length})`;
  // Per-file buttons are pointless with only one file (the bar does the same)
  root.classList.toggle('single', items.length === 1 && !combining());
}