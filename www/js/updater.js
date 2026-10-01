// Self-updating, two ways:
//  • Web / GitHub Pages: service worker. A new deploy installs in the background → "Reload" prompt.
//  • iOS / Android app: Capgo updater plugin in self-hosted mode. The app fetches update.json from
//    your GitHub Pages site, downloads the new web bundle zip, and swaps it in on next launch
//    (or immediately when you tap "Restart"). No app store, no re-sideloading for web changes.
import { APP_VERSION, UPDATE_MANIFEST_URL, BUILD_TIME } from './config.js';
import { isNative, plugin } from './platform.js';

export { APP_VERSION, BUILD_TIME };

const listeners = new Set();
let state = { status: 'idle', message: '', available: null };
function set(patch) { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); }
export function onUpdateState(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }

export function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchManifest() {
  if (!UPDATE_MANIFEST_URL) throw new Error('No update URL configured (local dev build).');
  const res = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Update check failed (${res.status})`);
  return res.json();
}

// ---------------- native (Capacitor + Capgo self-hosted) ----------------
let pendingBundle = null;

async function nativeCheck(manual) {
  const Updater = plugin('CapacitorUpdater');
  if (!Updater) { set({ status: 'error', message: 'Updater plugin not installed in this build.' }); return; }
  set({ status: 'checking', message: 'Checking for updates…' });
  try {
    const m = await fetchManifest();
    if (compareVersions(m.version, APP_VERSION) <= 0) {
      set({ status: 'latest', message: `You're on the latest version (${APP_VERSION}).` });
      return;
    }
    if (pendingBundle?.version === m.version) {
      set({ status: 'ready', available: m.version, message: `Version ${m.version} is ready.` });
      return;
    }
    set({ status: 'downloading', available: m.version, message: `Downloading ${m.version}…` });
    let bundle;
    try {
      bundle = await Updater.download({ url: m.url, version: m.version, checksum: m.checksum || undefined });
    } catch (e) {
      // Already downloaded earlier? Reuse it.
      const { bundles } = await Updater.list();
      bundle = bundles?.find(b => b.version === m.version && b.status !== 'error');
      if (!bundle) throw e;
    }
    await Updater.next({ id: bundle.id });
    pendingBundle = bundle;
    set({ status: 'ready', available: m.version, message: `Version ${m.version} downloaded. Restart to use it.` });
  } catch (e) {
    set({ status: manual ? 'error' : 'idle', message: manual ? (e.message || String(e)) : '' });
  }
}

export async function applyNow() {
  if (isNative && pendingBundle) {
    await plugin('CapacitorUpdater').set({ id: pendingBundle.id }); // reloads the webview
  } else if (swWaiting) {
    swWaiting.postMessage({ type: 'SKIP_WAITING' });
  } else {
    location.reload();
  }
}

// ---------------- web (service worker) ----------------
let swReg = null;
let swWaiting = null;

function watchWorker(reg) {
  const offer = (w) => {
    swWaiting = w;
    set({ status: 'ready', message: 'A new version is ready.' });
  };
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (!w) return;
    set({ status: 'downloading', message: 'Downloading update…' });
    w.addEventListener('statechange', () => {
      if (w.state === 'installed') {
        if (navigator.serviceWorker.controller) offer(w);
        else set({ status: 'latest', message: 'Ready to work offline.' });
      }
    });
  });
}

async function webCheck(manual) {
  if (!swReg) { if (manual) set({ status: 'error', message: 'Updates need the hosted (https) version.' }); return; }
  set({ status: 'checking', message: 'Checking for updates…' });
  try {
    await swReg.update();
    if (!swReg.installing && !swReg.waiting) {
      // Also compare against the published version so the message is meaningful
      let latest = APP_VERSION;
      try { latest = (await fetchManifest()).version; } catch {}
      set({ status: 'latest', message: compareVersions(latest, APP_VERSION) > 0 ? `Version ${latest} is deploying — try again in a minute.` : `You're on the latest version (${APP_VERSION}).` });
    }
  } catch (e) {
    set({ status: manual ? 'error' : 'idle', message: manual ? 'Offline — could not check for updates.' : '' });
  }
}

export function checkForUpdates(manual = false) {
  return isNative ? nativeCheck(manual) : webCheck(manual);
}

export async function initUpdater() {
  if (isNative) {
    const Updater = plugin('CapacitorUpdater');
    // Tell the plugin this bundle booted fine; otherwise it rolls back to the previous one.
    try { await Updater?.notifyAppReady(); } catch {}
    setTimeout(() => checkForUpdates(false), 2500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdates(false); });
    return;
  }
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    swReg = await navigator.serviceWorker.register('./sw.js');
    watchWorker(swReg);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return; reloading = true; location.reload();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) swReg.update().catch(() => {}); });
  } catch (e) {
    console.warn('SW registration failed', e);
  }
}

/** Pre-download the video engine so it works offline (web only; the app bundles it already). */
export async function cacheEngineForOffline(onProgress) {
  const { files } = await (await fetch('vendor/manifest.json', { cache: 'no-store' })).json();
  let done = 0;
  for (const f of files) {
    const res = await fetch(f);
    if (!res.ok) throw new Error(`Download failed: ${f}`);
    await res.arrayBuffer();
    onProgress?.(++done / files.length);
  }
}
