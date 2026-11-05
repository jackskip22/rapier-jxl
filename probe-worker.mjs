// SPDX-License-Identifier: MIT
// Plain harness worker (no rapier-jxl): reports the shape of what arrives and whether this realm can read it the way
// rapier-jxl's worker does (an ImageBitmap drawn on an OffscreenCanvas 2D context, willReadFrequently, sRGB).
import {shape, realm} from './shape.mjs';
self.addEventListener('message', e => {
  const {tag, value} = e.data || {};
  const out = {tag, realm: realm(), shape: shape(value)};
  try {
    if (typeof ImageBitmap === 'function' && value instanceof ImageBitmap) {
      if (typeof OffscreenCanvas !== 'function') throw new Error('no OffscreenCanvas');
      const c = new OffscreenCanvas(value.width, value.height), g = c.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
      if (!g) throw new Error('OffscreenCanvas 2D context is null');
      g.drawImage(value, 0, 0);
      const d = g.getImageData(0, 0, value.width, value.height).data;
      out.read = {ok: true, via: 'OffscreenCanvas', first: Array.from(d.slice(0, 4)), length: d.length};
    } else if (value && ArrayBuffer.isView(value.data)) out.read = {ok: true, via: 'data', first: Array.from(value.data.slice(0, 4)), length: value.data.length};
    else out.read = {ok: false, error: 'no pixels: neither ImageBitmap nor {data view}'};
  } catch (err) { out.read = {ok: false, error: String(err?.message || err).slice(0, 200)}; }
  self.postMessage(out);
});
self.postMessage({ready: true, realm: realm()});
