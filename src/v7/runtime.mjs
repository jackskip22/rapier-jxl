import {check, object} from './primitives.mjs';
import {runCodec} from './run-codec.mjs';

let helpersUsed = false;
export async function release(owner) {
  if (helpersUsed) await (await import('../helper-pool.mjs')).closeHelpers(owner);
}

let pool = null;
const helperPool = () => {
  if (!pool) { pool = import('../helper-pool.mjs'); pool.catch(() => { pool = null; }); }
  return pool;
};
export async function run(operation, input, options = {}, hooks = {}) {
  object(options); check(hooks.signal);
  if (hooks.lane) {
    helpersUsed = true;
    try { return await (await helperPool()).helperJob(hooks.owner, hooks.helpers, {kind: 'whole', operation, input, options, maxPixels: hooks.maxPixels}, hooks); }
    catch (error) { if (!error?.lost || hooks.signal?.aborted) throw error; }
  }
  if (hooks.helpers && !hooks.lane) await helperPool().catch(() => {});
  return runCodec(operation, input, options, hooks, hooks.helpers && !hooks.lane ? helpersDrive : undefined);
}

async function helpersDrive(steps, hooks, gpu, pixels) {
  const {drain} = await import('./common.mjs');
  const helpers = hooks.alone !== false && await helperPool(), workers = helpers ? helpers.reservedHelpers(hooks.helpers, pixels) : 0;
  if (workers < 2) return drain(steps, hooks.owner && hooks.helpers ? {...hooks, split: async request => { helpersUsed = true; return (await helperPool()).splitOnIdle(hooks.owner, hooks.helpers, request, hooks.signal); }} : hooks, gpu);
  helpersUsed = true;
  const {parallelJob} = await import('../parallel.mjs');
  return drain(parallelJob(steps, {pool: await helpers.helperPool(hooks.owner ?? hooks.helpers, hooks.helpers, pixels), signal: hooks.signal, gpu}), hooks);
}
