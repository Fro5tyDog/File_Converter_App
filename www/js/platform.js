// Platform glue: detects the Capacitor shell and saves/shares output files.

const cap = () => window.Capacitor;
export const isNative = !!cap()?.isNativePlatform?.();
export const platform = isNative ? cap().getPlatform() : 'web';

const pluginCache = {};
export function plugin(name) {
  if (!isNative) return null;
  if (pluginCache[name]) return pluginCache[name];
  const register = window.capacitorExports?.registerPlugin || cap()?.registerPlugin;
  if (register) return (pluginCache[name] = register(name));
  return cap()?.Plugins?.[name] || null;
}

export const canWebShareFiles = (files) => {
  try { return !!navigator.canShare?.({ files }); } catch { return false; }
};

/** Trigger a regular browser download. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Write a Blob to the app cache dir in chunks (keeps memory low for big videos). Returns a file URI. */
async function writeNativeCacheFile(blob, name) {
  const Filesystem = plugin('Filesystem');
  if (!Filesystem) throw new Error('Filesystem plugin missing');
  const path = `exports/${Date.now()}_${name}`;
  const CHUNK = 3 * 1024 * 1024; // multiple of 3 so base64 chunks concatenate cleanly
  for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
    const data = toBase64(await blob.slice(off, off + CHUNK).arrayBuffer());
    if (off === 0) await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true });
    else await Filesystem.appendFile({ path, data, directory: 'CACHE' });
    if (blob.size === 0) break;
  }
  const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
  return uri;
}

export async function clearNativeExports() {
  const Filesystem = plugin('Filesystem');
  if (!Filesystem) return;
  try { await Filesystem.rmdir({ path: 'exports', directory: 'CACHE', recursive: true }); } catch {}
}

/**
 * Hand files to the OS share sheet ("Save Image", "Save Video", "Save to Files", AirDrop…).
 * @param {{blob: Blob, name: string}[]} items
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>}
 */
export async function shareFiles(items) {
  const files = items.map(i => new File([i.blob], i.name, { type: i.blob.type }));
  if (canWebShareFiles(files)) {
    try {
      await navigator.share({ files });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      if (!isNative) throw e;
      // fall through to native plugin
    }
  }
  if (isNative) {
    const Share = plugin('Share');
    const uris = [];
    for (const i of items) uris.push(await writeNativeCacheFile(i.blob, i.name));
    try {
      await Share.share({ files: uris, dialogTitle: 'Save or share' });
      return 'shared';
    } catch (e) {
      if (/cancel/i.test(e?.message || '')) return 'cancelled';
      throw e;
    }
  }
  for (const i of items) downloadBlob(i.blob, i.name);
  return 'downloaded';
}
