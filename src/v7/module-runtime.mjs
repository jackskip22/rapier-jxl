import {object, check, fail, pixelLimit, LARGEST} from './primitives.mjs';
import {isRowBridge, bridgedRows} from './rows.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {DRIVE} from './drive.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';

export function moduleRuntime(module, {name, gpu = false, helpers, helper: file} = {}) {
  let pool = null;
  const helper = file && {...file, module: file.module ?? name, protocol: WORKER_PROTOCOL, wasm: module.configureWasm?.[Symbol.for('rapier-jxl.wasm-supplied')]};
  const closed = new WeakSet();
  const helperModule = () => {
    if (!helpers || !helper) return Promise.reject(fail('JXL_OPTIONS', 'helpers are for a module that encodes.'));
    if (!pool) { pool = helpers(); pool.catch(() => { pool = null; }); }
    return pool;
  };
  const driven = typeof module.encode === 'function' ? module.encode[DRIVE] : undefined;
  const lone = hooks => ({
    owned: true,
    pool: hooks.alone === false ? undefined : async pixels => {
      const {reservedHelpers, helperPool} = await helperModule();
      if (reservedHelpers(hooks.helpers, pixels) < 2) return null;
      return helperPool(hooks.owner ?? hooks.helpers, hooks.helpers, pixels, helper).catch(error => { if (error?.lost && !hooks.signal?.aborted) return null; throw error; });
    },
    split: hooks.owner ? async request => (await helperModule()).splitOnIdle(hooks.owner, hooks.helpers, request, hooks.signal, helper) : undefined,
  });
  return Object.freeze({
    module: name,
    async run(operation, input, options = {}, hooks = {}) {
      object(options); check(hooks.signal);
      if (typeof module[operation] !== 'function') throw fail('JXL_OPTIONS', `This codec's module has no ${operation}.`);
      if (hooks.lane && helpers && helper) {
        try { return await (await helperModule()).helperJob(hooks.owner, hooks.helpers, {kind: 'whole', operation, input, options, maxPixels: hooks.maxPixels, webgpu: hooks.webgpu}, {...hooks, helper}); }
        catch (error) { if (!error?.lost || hooks.signal?.aborted) throw error; }
      }
      const maxPixels = Math.min(options.maxPixels === undefined ? Infinity : pixelLimit(options.maxPixels, operation === 'encode' || operation === 'capture' || operation === 'decode' ? LARGEST : undefined), hooks.maxPixels ?? 40000000);
      const execution = {maxPixels, ...(gpu && operation === 'encode' && {webgpu: options.webgpu ?? hooks.webgpu})};
      const {webgpu: _webgpu, ...rest} = options;
      const call = {...(gpu ? options : rest), ...execution, signal: hooks.signal, onProgress: hooks.onProgress};
      if (isRowBridge(input)) {
        const port = input.rowsPort;
        try { return await module[operation](bridgedRows(input), call); } finally { port.close(); }
      }
      try {
        if (operation === 'encode' && driven && helpers && helper && hooks.helpers && !hooks.lane) return await driven(input, call, lone(hooks));
        return await module[operation](input, call);
      } finally { if (typeof ImageBitmap === 'function' && input instanceof ImageBitmap || typeof VideoFrame === 'function' && input instanceof VideoFrame) input.close(); }
    },
    async prepare(operation, {webgpu, owner, helpers: reservation} = {}) {
      if (typeof module[operation] !== 'function') throw fail('JXL_OPTIONS', `This codec's module has no ${operation}.`);
      if (gpu && operation === 'encode' && webgpu === 'required') await requireWebGPU('required');
      if (operation === 'encode' && owner && reservation?.count && helpers && helper) {
        const pool = await helperModule();
        if (!closed.has(owner)) await pool.warmHelpers(owner, reservation, helper);
      }
      return module.prepare?.(operation);
    },
    async release(owner, final = false) { if (final) closed.add(owner); if (pool) await (await pool).closeHelpers(owner, final); },
  });
}
