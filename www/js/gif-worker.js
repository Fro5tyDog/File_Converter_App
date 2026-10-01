import { encodeGIF } from './gif-encoder.js';
self.onmessage = (e) => {
  const { frames, opts } = e.data;
  try {
    const bytes = encodeGIF(frames, { ...opts, onProgress: p => self.postMessage({ progress: p }) });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
