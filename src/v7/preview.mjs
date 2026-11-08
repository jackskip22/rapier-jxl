// SPDX-License-Identifier: MIT
import {admitSignal, check} from './primitives.mjs';
export const PREVIEW = Symbol('preview');

export function previewCall(options, geometry) {
  if (options.onPreview === undefined) return;
  admitSignal(options.signal);
  const preview = createPreview(options.onPreview, options.signal);
  delete options.onPreview;
  options[PREVIEW] = (bytes, details) => { check(options.signal); preview.offer(bytes, {...geometry?.(), ...details}); check(options.signal); };
  return preview;
}

export function createPreview(callback, signal) {
  let pending, timer, busy = false, closed = false, last = -Infinity;
  const sent = new WeakSet();
  const close = () => {
    if (closed) return;
    closed = true; pending = undefined; callback = undefined;
    clearTimeout(timer); timer = undefined;
    signal?.removeEventListener?.('abort', close); signal = undefined;
  };
  const ready = () => { busy = false; pump(); };
  const pump = () => {
    if (closed || signal?.aborted) { close(); return; }
    if (busy || !pending || timer !== undefined) return;
    const delay = last + 100 - performance.now();
    if (delay > 0) {
      timer = setTimeout(() => { timer = undefined; pump(); }, delay);
      return;
    }
    const candidate = pending; pending = undefined;
    busy = true; sent.add(candidate.bytes);
    try {
      const {bytes, width, height, orientation, measurements = []} = candidate;
      const preview = {bytes: new Uint8Array(bytes),
        width: orientation >= 5 ? height : width, height: orientation >= 5 ? width : height,
        measurements: measurements.map(value => ({...value, ...(value.region && {region: {...value.region}})}))};
      last = performance.now();
      Promise.resolve(callback(preview)).then(ready, ready);
    } catch { ready(); }
  };
  signal?.addEventListener('abort', close, {once: true});
  return {
    offer(bytes, details) {
      if (closed || signal?.aborted || sent.has(bytes) || pending?.bytes === bytes) return;
      if (!(bytes instanceof Uint8Array) || !bytes.length ||
          !Number.isSafeInteger(details?.width) || !Number.isSafeInteger(details?.height) ||
          details.width < 1 || details.height < 1) return;
      pending = {bytes, ...details};
      pump();
    },
    close,
  };
}
