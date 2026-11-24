// SPDX-License-Identifier: MIT
import {fault, abortError} from './fault.mjs';
export const turn = () => new Promise(resolve => {
  try { setImmediate(resolve); return; } catch {}
  try { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); resolve(); }; channel.port2.postMessage(0); return; } catch {}
  setTimeout(resolve, 0);
});
let held = () => false, active = false, locked = false;
const waiting = [];
export const captureHeld = check => { held = check; };
export const exclusiveActive = () => active;
const take = () => locked ? new Promise(grant => waiting.push(grant)) : (locked = true, null);
const pass = () => { const next = waiting.shift(); if (next) next(); else locked = false; };
async function outside(read) {
  active = false; pass();
  try { return await read(); }
  finally { const wait = take(); if (wait) await wait; while (held()) await turn(); active = true; }
}
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
      cancel(reason === undefined ? abortError() : reason);
    };
    (async () => {
      await take();
      try {
        while (work !== null && held()) await turn();
        if (work === null) return;
        const start = work;
        work = null; detach();
        active = true;
        try { resolve(await start(outside)); } catch (error) { reject(error); } finally { active = false; }
      } finally { pass(); }
    })();
    if (signal) try {
      if (signal.aborted) abort();
      else { signal.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort(); }
    } catch (error) { cancel(error); }
  });
}
