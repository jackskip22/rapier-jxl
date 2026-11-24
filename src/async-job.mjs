// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export function checkSignal(signal) {
  if (signal !== undefined && typeof signal?.throwIfAborted !== 'function') throw fault('JXL_OPTIONS', 'signal: AbortSignal');
  signal?.throwIfAborted();
}

export async function finishEncoding(job, {progress, signal} = {}) {
  checkSignal(signal);
  let channel = typeof MessageChannel === 'function' ? undefined : false, immediate = typeof setImmediate === 'function', lastTurn = performance.now();
  const turn = () => new Promise(resolve => {
    if (immediate) try { setImmediate(resolve); return; } catch { immediate = false; }
    if (channel !== false) try {
      channel ||= new MessageChannel();
      channel.port1.onmessage = resolve;
      channel.port2.postMessage(0);
      return;
    } catch { channel = false; }
    setTimeout(resolve, 0);
  });
  try {
    signal?.throwIfAborted();
    for await (const fraction of job) {
      signal?.throwIfAborted();
      if (typeof progress === 'function' && fraction < 1) progress(fraction);
      signal?.throwIfAborted();
      if (signal && performance.now() - lastTurn >= 8) {
        await turn(); lastTurn = performance.now(); signal?.throwIfAborted();
      }
    }
    signal?.throwIfAborted();
    if (typeof progress === 'function') progress(1);
    return job.bytes;
  } finally {
    if (channel) { channel.port1.close(); channel.port2.close(); }
  }
}
