// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
export const turn = () => new Promise(resolve => {
  try { setImmediate(resolve); return; } catch {}
  try { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); resolve(); }; channel.port2.postMessage(0); return; } catch {}
  setTimeout(resolve, 0);
});
let queue = Promise.resolve();
export function exclusive(work, signal) {
  return new Promise((resolve, reject) => {
    const detach = () => {
      try { signal?.removeEventListener?.('abort', abort); } catch {}
      signal = null;
    };
    const cancel = reason => { work = null; detach(); reject(reason); };
    const abort = () => {
      if (work === null) return;
      let reason;
      try { reason = signal.reason; } catch (error) { reason = error; }
      cancel(reason === undefined ? fault('JXL_ABORTED', 'The job was aborted.') : reason);
    };
    const run = queue.then(() => {
      if (work === null) return;
      const start = work;
      work = null; detach();
      return start();
    });
    queue = run.catch(() => {});
    run.then(resolve, reject);
    if (signal) try {
      if (signal.aborted) abort();
      else { signal.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort(); }
    } catch (error) { cancel(error); }
  });
}
