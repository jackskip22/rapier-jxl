// SPDX-License-Identifier: MIT
export function checkSignal(signal) {
  if (signal !== undefined && typeof signal?.throwIfAborted !== 'function') throw new TypeError('signal must be an AbortSignal.');
  signal?.throwIfAborted();
}

export async function finishEncoding(job, {progress, signal, hurrySignal} = {}) {
  checkSignal(signal);
  if (hurrySignal !== undefined && typeof hurrySignal?.throwIfAborted !== 'function')
    throw new TypeError('hurrySignal must be an AbortSignal.');
  let channel = typeof MessageChannel === 'function' ? undefined : false, immediate = typeof setImmediate === 'function', lastTurn = performance.now();
  const hurry = () => { job.hurry = true; };
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
    hurrySignal?.addEventListener('abort', hurry, {once: true});
    if (hurrySignal?.aborted) hurry();
    signal?.throwIfAborted();
    for await (const fraction of job) {
      signal?.throwIfAborted();
      if (typeof progress === 'function' && fraction < 1) progress(fraction);
      signal?.throwIfAborted();
      if ((signal || hurrySignal) && performance.now() - lastTurn >= 8) {
        await turn(); lastTurn = performance.now(); signal?.throwIfAborted();
      }
    }
    signal?.throwIfAborted();
    if (typeof progress === 'function') progress(1);
    return job.bytes;
  } finally {
    hurrySignal?.removeEventListener('abort', hurry);
    if (channel) { channel.port1.close(); channel.port2.close(); }
  }
}
