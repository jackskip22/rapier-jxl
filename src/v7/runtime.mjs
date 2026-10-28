import {check, object} from './primitives.mjs';
import {runCodec} from './run-codec.mjs';

let helpersUsed = false;
export async function release(owner) {
  if (helpersUsed) await (await import('../parallel.mjs')).closeHelpers(owner);
}

export async function run(operation, input, options = {}, hooks = {}) {
  object(options); check(hooks.signal);
  if (hooks.lane) {
    helpersUsed = true;
    return (await import('../parallel.mjs')).helperJob(hooks.owner, hooks.helpers, {kind: 'whole', operation, input, options, maxPixels: hooks.maxPixels}, hooks);
  }
  return runCodec(operation, input, options, hooks, hooks.helpers ? helpersDrive : undefined);
}

async function helpersDrive(steps, hooks, gpu, pixels) {
  const {drain} = await import('./common.mjs');
  const parallel = hooks.alone !== false && await import('../parallel.mjs'), workers = parallel ? parallel.reservedHelpers(hooks.helpers, pixels) : 0;
  if (workers < 2) return drain(steps, hooks.owner && hooks.helpers ? {...hooks, split: async request => { helpersUsed = true; return (await import('../parallel.mjs')).splitOnIdle(hooks.owner, hooks.helpers, request, hooks.signal); }} : hooks, gpu);
  helpersUsed = true;
  return drain(parallel.parallelJob(steps, {pool: await parallel.helperPool(hooks.owner ?? hooks.helpers, hooks.helpers, pixels), signal: hooks.signal, gpu}), hooks);
}
