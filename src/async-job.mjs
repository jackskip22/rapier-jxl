// SPDX-License-Identifier: MIT
export function checkSignal(signal) {
  if (signal !== undefined && typeof signal?.throwIfAborted !== 'function') throw new TypeError('signal must be an AbortSignal.');
  signal?.throwIfAborted();
}

export async function finishEncoding(job, {progress, signal} = {}) {
  checkSignal(signal);
  let channel, lastTurn = performance.now();
  const turn = () => new Promise(resolve => {
    if (typeof setImmediate === 'function') { setImmediate(resolve); return; }
    channel ||= new MessageChannel();
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(0);
  });
  try {
    signal?.throwIfAborted();
    for await (const fraction of job) {
      signal?.throwIfAborted();
      if (typeof progress === 'function' && fraction < 1) progress(fraction);
      signal?.throwIfAborted();
      if (signal && performance.now() - lastTurn >= 8) {
        await turn(); lastTurn = performance.now(); signal.throwIfAborted();
      }
    }
    signal?.throwIfAborted();
    if (typeof progress === 'function') progress(1);
    return job.bytes;
  } finally {
    channel?.port1.close(); channel?.port2.close();
  }
}
