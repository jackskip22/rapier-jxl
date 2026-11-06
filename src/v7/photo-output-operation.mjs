// SPDX-License-Identifier: MIT
import {check, fail} from './primitives.mjs';

export async function photoOutputOperation(source, {cacheBytes = 0, signal, maxPixels} = {}, {prepare, metric: createMetric, read}) {
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
    release(() => lifetime.abort(fail('JXL_INTERNAL', 'The output measurement is closed.')));
    release(() => current?.destroy());
    if (failed) throw failure;
  };
  try {
    signal?.addEventListener('abort', stop, {once: true}); stop(); check(operationSignal);
    metric = createMetric(source, {cacheBytes, signal: operationSignal, maxPixels});
    source = null;
  } catch (error) { try { destroy(); } catch {} throw error; }
  if (!metric) { destroy(); return null; }
  return {
    domain: metric.domain,
    async measure(bytes, want) {
      check(signal); check(operationSignal);
      if (!metric || busy) throw fail('JXL_INTERNAL', 'The output measurement is closed or already in use.');
      if (!(bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', 'A photo producer must return complete bytes.');
      busy = true;
      let restored = null;
      try {
        restored = await read(bytes, {...readOptions, format: metric.format});
        check(signal); check(operationSignal);
        if (!metric) throw fail('JXL_INTERNAL', 'The output measurement is closed.');
        if (!animation && restored.animation) throw fail('JXL_INTERNAL', 'A still photo producer returned an animation.');
        return metric.measure(restored, want);
      } finally { restored = null; busy = false; }
    },
    destroy,
  };
}
