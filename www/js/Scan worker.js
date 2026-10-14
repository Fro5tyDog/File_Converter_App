import { processPage, detectDocument } from './scan-image.js';
self.onmessage = (e) => {
  const { id, op, src, settings } = e.data;
  try {
    if (op === 'detect') {
      self.postMessage({ id, quad: detectDocument(src) });
    } else {
      const { image, white } = processPage(src, settings);
      const data = image.data === src.data ? image.data.slice() : image.data;
      const transfer = [data.buffer];
      if (white) transfer.push(white.buffer);
      self.postMessage({ id, image: { width: image.width, height: image.height, data }, white }, transfer);
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};