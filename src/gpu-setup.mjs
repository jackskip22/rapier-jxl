// SPDX-License-Identifier: MIT
export function gpuSetup(start, {signal, dispose = owner => owner?.destroy?.()} = {}) {
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.aborted !== 'boolean'))
    return Promise.reject(new TypeError('signal must be an AbortSignal.'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let canceled = false;
    const release = owner => { try { dispose(owner); } catch {  } };
    const onAbort = () => { canceled = true; signal.removeEventListener('abort', onAbort); release(); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, {once: true});
    let pending;
    try { pending = start(); }
    catch (error) { signal?.removeEventListener('abort', onAbort); reject(error); return; }
    Promise.resolve(pending).then(owner => {
      signal?.removeEventListener('abort', onAbort);
      if (canceled || signal?.aborted) { release(owner); if (!canceled) reject(signal.reason); }
      else resolve(owner);
    }, error => { signal?.removeEventListener('abort', onAbort); if (!canceled) reject(error); });
  });
}
