// SPDX-License-Identifier: MIT
import {check, fail} from './primitives.mjs';

export async function photoOutputOperation(source, {cacheBytes = 0, signal, maxPixels, crops} = {}, {prepare, metric: createMetric, read}) {
  check(signal); await prepare(); check(signal);
  const animation = Array.isArray(source.frames), lifetime = new AbortController(), operationSignal = lifetime.signal;
  const stop = () => { try { check(signal); } catch (reason) { lifetime.abort(reason); } };
  const readOptions = {width: source.width, height: source.height, colorSpace: source.colorSpace ?? 'srgb',
    maxPixels: source.width * source.height, signal: operationSignal};
  let metric = null, closed = false, busy = false;
  const destroy = () => {
    if (closed) return;
    closed = true;
    const current = metric; metric = null; source = null;
    let failed = false, failure;
    const release = work => { try { work(); } catch (error) { if (!failed) { failed = true; failure = error; } } };
    release(() => signal?.removeEventListener?.('abort', stop));
    release(() => lifetime.abort(fail('JXL_INTERNAL', 'photo-output-operation:measure-1')));
    release(() => current?.destroy());
    if (failed) throw failure;
  };
  try {
    signal?.addEventListener('abort', stop, {once: true}); stop(); check(operationSignal);
    metric = createMetric(source, {cacheBytes, signal: operationSignal, maxPixels, ...(crops?.length && {crops})});
    source = null;
  } catch (error) { try { destroy(); } catch {} throw error; }
  if (!metric) { destroy(); return null; }
  return {
    domain: metric.domain,
    async measure(bytes, want, image) {
      check(signal); check(operationSignal);
      if (!metric || busy) throw fail('JXL_INTERNAL', 'photo-output-operation:measure-2');
      if (!(bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', 'photo-output-operation:measure-3');
      busy = true;
      let restored = null;
      try {
        restored = await read(bytes, {...readOptions, format: metric.format}, image);
        check(signal); check(operationSignal);
        if (!metric) throw fail('JXL_INTERNAL', 'photo-output-operation:measure-4');
        if (!animation && restored.animation) throw fail('JXL_INTERNAL', 'photo-output-operation:measure-5');
        return metric.measure(restored, want);
      } finally { restored = null; busy = false; }
    },
    destroy,
  };
}
