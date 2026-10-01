// Pure helpers that turn a target format + options into ffmpeg arguments.
// Kept free of browser APIs so they can be tested with a desktop ffmpeg.

/** Parse ffmpeg's "-i" banner into something useful. */
export function parseProbe(log) {
  const info = { duration: 0, video: null, audio: null, hasVideo: false, hasAudio: false };
  const dur = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) info.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]);
  const v = log.match(/Stream #\d+:\d+[^:]*: Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (v) {
    info.hasVideo = true;
    info.video = { codec: v[1], width: +v[2], height: +v[3] };
    const fps = log.match(/Video:[^\n]*?([\d.]+) fps/);
    if (fps) info.video.fps = parseFloat(fps[1]);
    const rot = log.match(/rotation of (-?[\d.]+) degrees|rotate\s*:\s*(-?\d+)/);
    if (rot) info.video.rotation = parseFloat(rot[1] ?? rot[2]);
  }
  const a = log.match(/Stream #\d+:\d+[^:]*: Audio: (\w+)/);
  if (a) { info.hasAudio = true; info.audio = { codec: a[1] }; }
  return info;
}

/** Parse "time=00:00:03.45" from a progress log line → seconds, or null. */
export function parseTime(line) {
  const m = line.match(/time=\s*(-?)(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m || m[1] === '-') return null;
  return (+m[2]) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
}

/** Scale filter that limits the longest side to `max` px and keeps even dimensions. */
export function scaleFilter(max) {
  if (!max) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return `scale='if(gte(iw,ih),min(${max},iw),-2)':'if(gte(iw,ih),-2,min(${max},ih))'`;
}

const MP4_SAFE_VIDEO = ['h264', 'hevc', 'mpeg4', 'av1'];
const MP4_SAFE_AUDIO = ['aac', 'mp3', 'alac', 'ac3', 'eac3', 'opus', 'flac'];

/**
 * @param {string} target  one of: mp4, mp4-h264, mov, webm, gif, mp3, m4a, wav, webp
 * @param {string} input   path inside the ffmpeg FS
 * @param {object} probe   result of parseProbe
 * @param {object} o       options
 * @returns {{args: string[], ext: string, mime: string, expectDuration: number}}
 */
export function buildArgs(target, input, probe, o = {}) {
  const pre = ['-hide_banner', '-nostdin', '-y'];
  const trim = [];
  let expectDuration = probe.duration || 0;
  if (o.start > 0) { trim.push('-ss', String(o.start)); expectDuration = Math.max(0, expectDuration - o.start); }
  const inArgs = [...trim, '-i', input];
  if (o.length > 0) { inArgs.push('-t', String(o.length)); expectDuration = Math.min(expectDuration || o.length, o.length); }

  switch (target) {
    case 'mp4': {
      // Fast path: copy streams into an MP4 container (MOV → MP4 in seconds, no quality loss).
      const vOk = !probe.hasVideo || MP4_SAFE_VIDEO.includes(probe.video.codec);
      const aOk = !probe.hasAudio || MP4_SAFE_AUDIO.includes(probe.audio.codec);
      if (!vOk || !aOk || o.forceEncode) return buildArgs('mp4-h264', input, probe, o);
      const args = [...pre, ...inArgs, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy'];
      if (probe.video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
      args.push('-movflags', '+faststart', '-map_metadata', '0', 'out.mp4');
      return { args, ext: 'mp4', mime: 'video/mp4', expectDuration };
    }
    case 'mp4-h264': {
      const args = [...pre, ...inArgs, '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', String(o.crf ?? 23),
        '-pix_fmt', 'yuv420p', '-vf', scaleFilter(o.maxSize),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
        '-movflags', '+faststart', 'out.mp4'];
      return { args, ext: 'mp4', mime: 'video/mp4', expectDuration };
    }
    case 'mov': {
      const args = [...pre, ...inArgs, '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', String(o.crf ?? 23),
        '-pix_fmt', 'yuv420p', '-vf', scaleFilter(o.maxSize),
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', 'out.mov'];
      return { args, ext: 'mov', mime: 'video/quicktime', expectDuration };
    }
    case 'webm': {
      const args = [...pre, ...inArgs, '-map', '0:v:0?', '-map', '0:a:0?',
        '-c:v', 'libvpx', '-b:v', '0', '-crf', String(o.crf ? o.crf + 8 : 30), '-deadline', 'realtime', '-cpu-used', '8',
        '-vf', scaleFilter(o.maxSize ?? 1280), '-c:a', 'libvorbis', '-q:a', '4', 'out.webm'];
      return { args, ext: 'webm', mime: 'video/webm', expectDuration };
    }
    case 'gif': {
      const fps = o.fps || 12;
      const width = o.gifWidth || 480;
      const vf = `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`;
      const args = [...pre, ...inArgs, '-an', '-vf', vf, '-loop', '0', 'out.gif'];
      return { args, ext: 'gif', mime: 'image/gif', expectDuration };
    }
    case 'mp3':
      return { args: [...pre, ...inArgs, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2', 'out.mp3'], ext: 'mp3', mime: 'audio/mpeg', expectDuration };
    case 'm4a':
      return { args: [...pre, ...inArgs, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.m4a'], ext: 'm4a', mime: 'audio/mp4', expectDuration };
    case 'wav':
      return { args: [...pre, ...inArgs, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', 'out.wav'], ext: 'wav', mime: 'audio/wav', expectDuration };
    case 'webp': // still image → webp (used when the browser can't encode WebP itself)
      return { args: [...pre, '-i', input, '-frames:v', '1', '-c:v', 'libwebp', '-quality', String(Math.round((o.quality ?? 0.85) * 100)), 'out.webp'], ext: 'webp', mime: 'image/webp', expectDuration: 0 };
    default:
      throw new Error('Unknown target ' + target);
  }
}
