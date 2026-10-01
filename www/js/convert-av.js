// Video / audio conversion through ffmpeg.wasm (single-threaded core, so it
// works on GitHub Pages and inside the iOS/Android app without special headers).
import { buildArgs, parseProbe, parseTime } from './ffmpeg-args.js';

const base = new URL('../', import.meta.url);
const FFMPEG_MODULE = new URL('vendor/ffmpeg/index.js', base).href;
const CORE_JS = new URL('vendor/ffmpeg-core/ffmpeg-core.js', base).href;
const CORE_WASM = new URL('vendor/ffmpeg-core/ffmpeg-core.wasm', base).href;

let ffmpeg = null;
let loading = null;
let logSink = null;   // current job's log listener
let mountSeq = 0;

export function engineLoaded() { return !!ffmpeg; }

export async function loadEngine(onStatus) {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    onStatus?.('Loading video engine…');
    let mod;
    try {
      mod = await import(FFMPEG_MODULE);
    } catch (e) {
      throw new Error('Video engine files are missing. Run "npm run build" (or let GitHub Actions build) so vendor/ is populated.');
    }
    const ff = new mod.FFmpeg();
    ff.on('log', ({ message }) => logSink?.(message));
    await ff.load({ coreURL: CORE_JS, wasmURL: CORE_WASM });
    ffmpeg = ff;
    return ff;
  })();
  try { return await loading; } finally { loading = null; }
}

/** Kill the running job. The engine is reloaded on the next conversion. */
export function cancelEngine() {
  if (ffmpeg) { try { ffmpeg.terminate(); } catch {} }
  ffmpeg = null;
}

/** Put a File into the ffmpeg FS. Mounts it (no copy) when possible, otherwise copies bytes. */
async function stageInput(ff, file) {
  const dir = `/in${++mountSeq}`;
  const safeName = file.name.replace(/[^\w.\-]+/g, '_') || 'input';
  try {
    await ff.createDir(dir);
    const named = safeName === file.name ? file : new File([file], safeName, { type: file.type });
    await ff.mount('WORKERFS', { files: [named] }, dir);
    return { path: `${dir}/${safeName}`, cleanup: async () => { try { await ff.unmount(dir); await ff.deleteDir(dir); } catch {} } };
  } catch {
    try { await ff.deleteDir(dir); } catch {}
    const path = `/${mountSeq}_${safeName}`;
    await ff.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return { path, cleanup: async () => { try { await ff.deleteFile(path); } catch {} } };
  }
}

async function run(ff, args, onLine) {
  const lines = [];
  logSink = (m) => { lines.push(m); if (lines.length > 400) lines.shift(); onLine?.(m); };
  try {
    const code = await ff.exec(args);
    return { code, log: lines.join('\n') };
  } finally {
    logSink = null;
  }
}

export async function probe(file, onStatus) {
  const ff = await loadEngine(onStatus);
  const input = await stageInput(ff, file);
  try {
    const { log } = await run(ff, ['-hide_banner', '-i', input.path]);
    return parseProbe(log);
  } finally {
    await input.cleanup();
  }
}

/**
 * Convert a media file. Returns a Blob.
 * @param {File} file
 * @param {string} target
 * @param {object} opts
 * @param {(p:number|null, label?:string)=>void} onProgress
 */
export async function convertAV(file, target, opts, onProgress) {
  const ff = await loadEngine(s => onProgress(null, s));
  onProgress(null, 'Reading file…');
  const input = await stageInput(ff, file);
  try {
    const { log: probeLog } = await run(ff, ['-hide_banner', '-i', input.path]);
    const info = parseProbe(probeLog);
    if (!info.hasVideo && !info.hasAudio) throw new Error('No audio or video found in this file.');
    if (['mp3', 'm4a', 'wav'].includes(target) && !info.hasAudio) throw new Error('This file has no audio track.');
    if (['mp4', 'mp4-h264', 'mov', 'webm', 'gif'].includes(target) && !info.hasVideo) throw new Error('This file has no video track.');

    const { args, ext, mime, expectDuration } = buildArgs(target, input.path, info, opts);
    const outName = args[args.length - 1];
    onProgress(0, target === 'mp4' ? 'Repackaging…' : 'Converting…');
    const progressHandler = ({ progress }) => { if (!expectDuration && progress >= 0 && progress <= 1) onProgress(progress); };
    ff.on('progress', progressHandler);
    let result;
    try {
      result = await run(ff, args, line => {
        if (!expectDuration) return;
        const t = parseTime(line);
        if (t != null) onProgress(Math.min(0.99, t / expectDuration));
      });
    } finally {
      ff.off('progress', progressHandler);
    }
    if (result.code !== 0) {
      const tail = result.log.split('\n').filter(l => /error|invalid|not|fail/i.test(l)).slice(-3).join(' · ');
      throw new Error(tail || 'Conversion failed.');
    }
    onProgress(1, 'Finishing…');
    const data = await ff.readFile(outName);
    await ff.deleteFile(outName).catch(() => {});
    return { blob: new Blob([data], { type: mime }), ext, info };
  } finally {
    await input.cleanup();
  }
}

/** Encode a still image (PNG blob) to WebP with ffmpeg — fallback for browsers (Safari) without WebP canvas encoding. */
export async function encodeWebpViaEngine(pngBlob, quality, onProgress) {
  const ff = await loadEngine(s => onProgress?.(null, s));
  const name = `/still_${++mountSeq}.png`;
  await ff.writeFile(name, new Uint8Array(await pngBlob.arrayBuffer()));
  try {
    const { args, mime } = buildArgs('webp', name, {}, { quality });
    const { code, log } = await run(ff, args);
    if (code !== 0) throw new Error(log.split('\n').slice(-2).join(' '));
    const data = await ff.readFile('out.webp');
    await ff.deleteFile('out.webp').catch(() => {});
    return new Blob([data], { type: mime });
  } finally {
    await ff.deleteFile(name).catch(() => {});
  }
}
