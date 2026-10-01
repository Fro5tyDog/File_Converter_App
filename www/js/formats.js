// What we accept, how we classify it, and which outputs each kind can turn into.

const EXT = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'ico', 'jfif'],
  heic: ['heic', 'heif'],
  gif: ['gif'],
  video: ['mov', 'mp4', 'm4v', 'webm', 'mkv', 'avi', '3gp', '3g2', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aiff', 'aif', 'caf', 'wma', 'amr'],
};

export const ACCEPT = [
  'image/*', 'video/*', 'audio/*',
  ...Object.values(EXT).flat().map(e => '.' + e),
].join(',');

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name) {
  return (name || 'file').replace(/\.[^.]+$/, '');
}

/** @returns {'image'|'heic'|'gif'|'video'|'audio'|null} */
export function kindOf(file) {
  const ext = extOf(file.name);
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k;
  const t = file.type || '';
  if (/image\/hei[cf]/.test(t)) return 'heic';
  if (t === 'image/gif') return 'gif';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return null;
}

export const TARGETS = {
  png:        { label: 'PNG',  engine: 'image', note: 'Lossless, keeps transparency' },
  jpg:        { label: 'JPG',  engine: 'image', note: 'Small, works everywhere' },
  webp:       { label: 'WEBP', engine: 'image', note: 'Smaller than JPG' },
  gif:        { label: 'GIF',  engine: 'auto',  note: 'Animated for videos' },
  mp4:        { label: 'MP4',  engine: 'av',    note: 'Fast repackage, no quality loss' },
  'mp4-h264': { label: 'MP4 · H.264', engine: 'av', note: 'Re-encode for maximum compatibility' },
  mov:        { label: 'MOV',  engine: 'av',    note: 'QuickTime, H.264' },
  webm:       { label: 'WEBM', engine: 'av',    note: 'For the web (slow to encode)' },
  mp3:        { label: 'MP3',  engine: 'av',    note: 'Audio only' },
  m4a:        { label: 'M4A',  engine: 'av',    note: 'Audio only (AAC)' },
  wav:        { label: 'WAV',  engine: 'av',    note: 'Uncompressed audio' },
};

export const KIND_TARGETS = {
  image: ['png', 'jpg', 'webp', 'gif'],
  heic:  ['png', 'jpg', 'webp', 'gif'],
  gif:   ['mp4-h264', 'webm', 'png', 'jpg', 'webp'],
  video: ['mp4', 'mp4-h264', 'gif', 'mov', 'webm', 'mp3', 'm4a', 'wav'],
  audio: ['mp3', 'm4a', 'wav'],
};

export const KIND_LABEL = { image: 'Image', heic: 'iPhone photo', gif: 'GIF', video: 'Video', audio: 'Audio' };

export function defaultTarget(kind, ext) {
  switch (kind) {
    case 'heic': return 'png';
    case 'image': return ext === 'png' ? 'jpg' : 'png';
    case 'gif': return 'mp4-h264';
    case 'video': return ext === 'mp4' || ext === 'm4v' ? 'gif' : 'mp4';
    case 'audio': return ext === 'mp3' ? 'm4a' : 'mp3';
  }
  return null;
}

/** Which engine runs this kind→target. */
export function engineFor(kind, target) {
  const e = TARGETS[target].engine;
  if (e !== 'auto') return e;
  return kind === 'video' ? 'av' : 'image';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
