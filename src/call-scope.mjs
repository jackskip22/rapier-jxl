// SPDX-License-Identifier: MIT
import {abortReason, fault} from './fault.mjs';

let calls = 0, pictures = 0, arena = null, endDue = false, rewindDue = false;
const rewinds = new Set(), ends = new Set(), waiters = [];
const retiring = new Set(), RETIREMENT_MS = 3000;
function finishScopes() {
  if (retiring.size) return;
  if (!pictures && rewindDue) { rewindDue = false; for (const rewind of rewinds) rewind(); }
  if (!calls && endDue) { endDue = false; for (const end of ends) end(); }
}
export async function withinCall(run) {
  calls++;
  try { return await run(); }
  finally { if (--calls === 0) { endDue = true; finishScopes(); } }
}
export async function withinPicture(run) {
  pictures++;
  try { return await run(); }
  finally { if (--pictures === 0) { rewindDue = true; finishScopes(); } }
}
export const inCall = () => calls > 0 || retiring.size > 0;
export const arenaLeased = () => !!arena || retiring.size > 0;
export const onCallEnd = (rewind, end) => { rewinds.add(rewind); ends.add(end); };

function acquireArena(signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  for (const held of retiring) if (held.failure) return Promise.reject(held.failure);
  if (!arena && !retiring.size) return arena = {release: false};
  return new Promise((resolve, reject) => {
    const waiter = {
      grant(owner) {
        signal?.removeEventListener?.('abort', onAbort);
        resolve(owner);
      },
      refuse(reason) {
        signal?.removeEventListener?.('abort', onAbort);
        reject(signal?.aborted ? abortReason(signal) : reason);
      },
    };
    const onAbort = () => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      reject(abortReason(signal));
    };
    if (signal?.addEventListener) signal.addEventListener('abort', onAbort, {once: true});
    waiters.push(waiter);
  });
}

function admitArena() {
  if (arena || retiring.size) return;
  const next = waiters.shift();
  if (next) next.grant(arena = {release: false});
}
function releaseArena(owner) {
  if (!owner || arena !== owner) return;
  owner.release = true;
  if (retiring.size) return;
  arena = null;
  admitArena();
}

export function deferRetirement(pending, cleanup) {
  if (!pending) return cleanup();
  const held = {failure: null};
  retiring.add(held);
  const refuse = error => {
    held.failure ??= Object.assign(fault('JXL_WEBGPU', 'GPU retirement did not complete'), error === undefined ? {} : {cause: error});
    for (const waiter of waiters.splice(0)) waiter.refuse(held.failure);
  };
  const timer = setTimeout(() => refuse(), RETIREMENT_MS);
  Promise.resolve(pending).then(cleanup, cleanup).then(() => {
    clearTimeout(timer);
    retiring.delete(held);
    if (!retiring.size && arena?.release) arena = null;
    try { finishScopes(); }
    catch (error) { retiring.add(held); refuse(error); return; }
    admitArena();
  }, error => { clearTimeout(timer); refuse(error); });
}

export async function withArenaLease(signal, run) {
  const wait = acquireArena(signal);
  const state = {owner: typeof wait?.then === 'function' ? await wait : wait};
  try { return await run(read => outsideArena(state, read)); }
  finally { releaseArena(state.owner); }
}
async function outsideArena(state, read) {
  releaseArena(state.owner);
  state.owner = null;
  try { return await read(); }
  finally { const wait = acquireArena(); state.owner = typeof wait?.then === 'function' ? await wait : wait; }
}
