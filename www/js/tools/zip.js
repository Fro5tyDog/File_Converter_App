// Zip tab: bundle any files into one .zip.
import { createZip } from '../zip-writer.js';
import { extOf, formatBytes } from '../formats.js';
import { $, el, thumb, progressEl, setProgress, setState, showResult, friendlyError, fileInput, dateStamp } from '../ui.js';

const files = [];
let seq = 0, busy = false, root, resultItem = null;

export function init(section) {
  root = section;
  fileInput($('#zipInput', root), onFiles);
  const folder = $('#zipFolderInput', root);
  // Folder picking works on desktop browsers; iOS has no folder picker
  const folderOk = 'webkitdirectory' in folder && !/iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#zipFolderBtn', root).hidden = !folderOk;
  fileInput(folder, onFiles);
  $('#zipCreate', root).addEventListener('click', create);
  $('#zipClear', root).addEventListener('click', () => { if (!busy) { files.splice(0); clearResult(); render(); } });
  $('#zipName', root).placeholder = `files-${dateStamp()}`;
  $('#zipCompress', root).addEventListener('change', clearResult);
  render();
}

export const isBusy = () => busy;

export function onFiles(list) {
  for (const file of list) files.push({ id: ++seq, file, path: file.webkitRelativePath || '' });
  clearResult();
  render();
}

function clearResult() {
  if (resultItem && !busy) { resultItem.el.remove(); resultItem = null; }
}

function render() {
  $('#zipList', root).replaceChildren(...files.map(f => {
    const t = thumb(null, extOf(f.file.name) || 'FILE');
    return el('li', { class: 'row' },
      t.box,
      el('div', { class: 'meta' },
        el('div', { class: 'name', title: f.path || f.file.name }, f.path || f.file.name),
        el('div', { class: 'sub' }, formatBytes(f.file.size))),
      el('button', { class: 'icon-btn remove', type: 'button', 'aria-label': 'Remove', disabled: busy, onclick: () => {
        files.splice(files.indexOf(f), 1); clearResult(); render();
      } }, '✕'));
  }));
  const has = files.length > 0;
  const total = files.reduce((n, f) => n + f.file.size, 0);
  $('#zipBar', root).hidden = !has;
  $('#zipSettings', root).hidden = !has;
  $('#zipEmpty', root).hidden = has;
  $('#zipCount', root).textContent = has ? `${files.length} file${files.length > 1 ? 's' : ''} · ${formatBytes(total)}` : '';
  const btn = $('#zipCreate', root);
  btn.disabled = busy || !has;
  btn.textContent = busy ? 'Zipping…' : 'Create ZIP';
  $('#zipClear', root).disabled = busy;
}

async function create() {
  if (busy || !files.length) return;
  clearResult();
  busy = true;
  render();
  const name = ($('#zipName', root).value.trim() || `files-${dateStamp()}`).replace(/[\\/:*?"<>|]+/g, '-').replace(/\.zip$/i, '');
  const total = files.reduce((n, f) => n + f.file.size, 0);
  const item = { el: el('li', { class: 'item' },
    el('div', { class: 'thumb' }, 'ZIP'),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, `${name}.zip`), el('div', { class: 'sub' }, `${files.length} files · ${formatBytes(total)}`)),
    el('span'), progressEl(), el('div', { class: 'err' }), el('div', { class: 'result' })) };
  resultItem = item;
  $('#zipResult', root).replaceChildren(item.el);
  setState(item, 'working');
  try {
    const blob = await createZip(files.map(f => ({ file: f.file, path: f.path })), {
      compress: $('#zipCompress', root).checked,
      onProgress: (p, n) => setProgress(item, p, n ? `Adding ${n}` : 'Finishing…'),
    });
    item.result = { blob, name: `${name}.zip` };
    setState(item, 'done');
    showResult(item, item.result, { before: total });
  } catch (e) {
    console.error(e);
    setState(item, 'error', friendlyError(e));
  } finally {
    busy = false;
    render();
  }
}