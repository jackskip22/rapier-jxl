// SPDX-License-Identifier: MIT
import {admitSignal, check, callers, abortable} from './primitives.mjs';
import {optionSymbol} from './primitives.mjs';
export const PREVIEW = /* @__PURE__ */ optionSymbol('preview');

export function previewCall(options, geometry) {
  if (options.onPreview === undefined) return;
  admitSignal(options.signal);
  const preview = createPreview(options.onPreview, options.signal);
  delete options.onPreview;
  options[PREVIEW] = (bytes, details) => { check(options.signal); preview.offer(bytes, {...geometry?.(), ...details}); check(options.signal); };
  return preview;
}

export function createPreview(callback, signal) {
  const refs = {callback, signal};
  let pending, timer, active, rejected, cleanup, busy = false, closed = false, last = -Infinity;
  const sent = new WeakSet();
  const close = () => {
    if (closed) return;
    closed = true; pending = undefined; refs.callback = undefined;
    clearTimeout(timer); timer = undefined;
    try { refs.signal?.removeEventListener?.('abort', close); } catch (reason) { cleanup = {reason}; }
    refs.signal = undefined;
  };
  const ready = () => { busy = false; pump(); };
  const failed = reason => { rejected ??= {reason}; busy = false; };
  const checked = () => { if (rejected) throw callers(rejected.reason); check(signal); };
  const pump = () => {
    if (closed) return;
    try { checked(); } catch (reason) { failed(reason); close(); return; }
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
      active = Promise.resolve(refs.callback(preview)).then(ready, failed);
    } catch (reason) { failed(reason); }
  };
  try { signal?.addEventListener('abort', close, {once: true}); if (signal?.aborted) close(); }
  catch (reason) { close(); throw callers(reason); }
  return {
    offer(bytes, details) {
      if (closed) return;
      checked();
      if (sent.has(bytes) || pending?.bytes === bytes) return;
      if (!(bytes instanceof Uint8Array) || !bytes.length ||
          !Number.isSafeInteger(details?.width) || !Number.isSafeInteger(details?.height) ||
          details.width < 1 || details.height < 1) return;
      pending = {bytes, ...details};
      pump();
      checked();
    },
    async finish() {
      close(); checked();
      try { await abortable(active, signal); } finally { checked(); }
      if (cleanup) throw callers(cleanup.reason);
    },
    close,
  };
}
