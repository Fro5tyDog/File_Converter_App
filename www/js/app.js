// App shell: tabs, global drag & drop / paste, settings and updates.
import { isNative, platform } from './platform.js';
import { initUpdater, checkForUpdates, applyNow, onUpdateState, cacheEngineForOffline, APP_VERSION, BUILD_TIME } from './updater.js';
import { $, $$, toast } from './ui.js';
import * as convert from './tools/convert.js';
import * as scan from './tools/scan.js';
import * as compress from './tools/compress.js';
import * as zip from './tools/zip.js';

const TOOLS = { convert, scan, compress, zip };
let active = 'convert';

for (const [name, tool] of Object.entries(TOOLS)) tool.init($(`#tab-${name}`));

// ---------------------------------------------------------------- tabs
function show(name, { remember = true } = {}) {
  if (!TOOLS[name]) name = 'convert';
  active = name;
  for (const sec of $$('.tool')) sec.hidden = sec.id !== `tab-${name}`;
  for (const a of $$('.tabbar a')) {
    const on = a.dataset.tab === name;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#title').textContent = $(`#tab-${name}`).dataset.title;
  if (remember) {
    try { localStorage.setItem('tab', name); } catch {}
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }
  window.scrollTo({ top: 0 });
}

for (const a of $$('.tabbar a')) a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.tab); });
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
let initial = location.hash.slice(1);
if (!TOOLS[initial]) { try { initial = localStorage.getItem('tab') || 'convert'; } catch { initial = 'convert'; } }
show(initial);

// Files handed from one tool to another (e.g. Compress → "Send to Zip")
document.addEventListener('send-to', (e) => {
  const { tab, files } = e.detail;
  show(tab);
  TOOLS[tab].onFiles(files);
  toast(`Added to ${$(`#tab-${tab}`).dataset.title}.`);
});

// ---------------------------------------------------------------- drag & drop / paste → active tab
const dropZone = () => $(`#tab-${active} .drop`);
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dropZone()?.classList.add('over');
}));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => {
  if (t === 'dragleave' && e.relatedTarget) return;
  e.preventDefault();
  dropZone()?.classList.remove('over');
}));
document.addEventListener('drop', e => { const f = e.dataTransfer?.files; if (f?.length) TOOLS[active].onFiles([...f]); });
document.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea')) return;
  const f = e.clipboardData?.files;
  if (f?.length) TOOLS[active].onFiles([...f]);
});

const anyBusy = () => Object.values(TOOLS).some(t => t.isBusy());

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
      label: isNative ? 'Restart' : 'Reload',
      run: () => { if (anyBusy()) toast('Finish the current job first, then restart from Settings.'); else applyNow(); },
    });
  }
});

$('#preview').addEventListener('click', e => { if (e.target.id === 'preview') e.target.close(); });
window.addEventListener('beforeunload', e => { if (anyBusy()) { e.preventDefault(); e.returnValue = ''; } });

initUpdater();