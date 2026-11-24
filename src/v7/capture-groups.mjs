// SPDX-License-Identifier: MIT
import {GROUPS} from './groups.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {groupHelpers, settledAll} from './capture-group-pool.mjs';
import {suppliedWasm} from '../wasm-modules.mjs';
export function withGroups(runtime, module, name, file, ready) {
  const pool = groupHelpers({...file, module: name, protocol: WORKER_PROTOCOL, wasm: suppliedWasm});
  const closed = new WeakSet();
  const answer = (hooks, request, signal) => {
    const owner = hooks.owner ?? hooks.helpers;
    const run = () => closed.has(owner) || signal?.aborted ? null : pool.answer(owner, hooks.helpers, request, signal);
    const waiting = ready?.(signal);
    return waiting ? waiting.then(run) : run();
  };
  return Object.freeze({...runtime,
    run: (operation, input, options, hooks = {}) => runtime.run(operation, input, operation === 'capture' && hooks.helpers?.count && !hooks.lane
      ? {...options, [GROUPS]: (request, signal) => answer(hooks, request, signal)} : options, hooks),
    prepare: async (operation, settings = {}) => {
      const prepared = await runtime.prepare(operation, settings);
      const waiting = ready?.();
      if (waiting) await waiting;
      if (operation === 'capture' && settings.owner && settings.helpers?.count && !closed.has(settings.owner)) await pool.warm(settings.owner, settings.helpers);
      return prepared;
    },
    release: async (owner, final) => { if (final) closed.add(owner); await settledAll([pool.release(owner, final), runtime.release(owner, final)]); }});
}
