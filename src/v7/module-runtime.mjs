import {object, check, fail, pixelLimit, PIXELS} from './primitives.mjs';
import {isRowBridge, bridgedRows} from './rows.mjs';
import {DRIVE} from './drive.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {JPEG_SOURCE, JPEG_SOURCE_WIRE} from './jpeg-choice-policy.mjs';
import {RETAIN_INPUT} from './ownership.mjs';
import {CONFIGURED_WEBGPU} from './webgpu.mjs';
import {suppliedWasm} from '../wasm-modules.mjs';
const encodes = operation => operation === 'encode' || operation === 'fit' || operation === 'variants';

export function moduleRuntime(module, {name, gpu = false, helpers, helper: file, ready} = {}) {
  let pool = null;
  const helper = !(typeof __RAPIER_JXL_JPEG__ !== "undefined" && __RAPIER_JXL_JPEG__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && file && {...file, module: file.module ?? name, protocol: WORKER_PROTOCOL, wasm: suppliedWasm};
  const closed = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : new WeakSet(), checkOp = op => { if (typeof module[op] !== 'function') throw fail('JXL_OPTIONS', `unknown operation: ${op}`); };
  const helperModule = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? null : signal => {
    const load = () => {
      if (!helpers || !helper) return Promise.reject(fail('JXL_OPTIONS', 'helpers: unsupported here'));
      if (!pool) { pool = helpers(); pool.catch(() => { pool = null; }); }
      return pool;
    };
    const waiting = ready?.(signal);
    return waiting ? waiting.then(load) : load();
  };
  const lone = ((typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) ? null : hooks => ({
    owned: hooks.owned !== false,
    stage: (pixels, jobBytes, geometry) => {
      if (!pool) return;
      return helperModule(hooks.signal).then(({reservedHelpers, retireBandHelpers}) => retireBandHelpers(hooks.owner ?? hooks.helpers,
        jobBytes !== undefined && reservedHelpers(hooks.helpers, pixels, jobBytes) > 0 ? geometry : undefined));
    },
    pool: hooks.alone === false ? undefined : async (pixels, jobBytes, geometry, floor) => {
      const {reservedHelpers, helperPool, retireBandHelpers} = await helperModule(hooks.signal);
      if (reservedHelpers(hooks.helpers, pixels, jobBytes, floor) < (jobBytes === undefined ? 2 : 1)) {
        await retireBandHelpers(hooks.owner ?? hooks.helpers);
        return null;
      }
      return helperPool(hooks.owner ?? hooks.helpers, hooks.helpers, pixels, helper, jobBytes, geometry, floor).catch(error => { if (error?.lost && !hooks.signal?.aborted) return null; throw error; });
    },
    split: hooks.owner ? async request => (await helperModule(hooks.signal)).splitOnIdle(hooks.owner, hooks.helpers, request, hooks.signal, helper) : undefined,
  });
  return Object.freeze({
    module: name,
    async run(operation, input, options = {}, hooks = {}) {
      try {
      object(options); check(hooks.signal);
      checkOp(operation);
      if (!(typeof __RAPIER_JXL_JPEG__ !== "undefined" && __RAPIER_JXL_JPEG__ === true || typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && hooks.lane && helpers && helper) {
        try { return await (await helperModule(hooks.signal)).helperJob(hooks.owner, hooks.helpers, {kind: 'whole', operation, input, options, maxPixels: hooks.maxPixels, webgpu: hooks.webgpu}, {...hooks, helper}); }
        catch (error) { if (!error?.lost || hooks.signal?.aborted) throw error; }
      }
      let originalJpeg;
      if (!((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) && Object.hasOwn(options, JPEG_SOURCE_WIRE)) {
        const {[JPEG_SOURCE_WIRE]: source, ...publicOptions} = options;
        originalJpeg = source; options = publicOptions;
      }
      const maxPixels = Math.min(options.maxPixels === undefined ? Infinity : pixelLimit(options.maxPixels), hooks.maxPixels ?? PIXELS);
      const execution = {maxPixels, ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && gpu && encodes(operation) && {webgpu: options.webgpu ?? hooks.webgpu})};
      const {webgpu: _webgpu, ...rest} = options;
      const call = {...(gpu || operation === 'capture' ? options : rest), ...execution,
        ...(!((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) && originalJpeg !== undefined && {[JPEG_SOURCE]: originalJpeg}),
        ...(operation === 'capture' && options.webgpu === undefined && hooks.webgpu !== undefined && {webgpu: hooks.webgpu}),
        ...(!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && operation === 'format' && hooks.webgpu !== undefined && {[CONFIGURED_WEBGPU]: hooks.webgpu}), signal: hooks.signal, onProgress: hooks.onProgress,
        ...(hooks.onPreview && {onPreview: hooks.onPreview}), ...(hooks.onFrame && {onFrame: hooks.onFrame}), ...(!((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) && name === 'rapier-jxl/animation' && hooks.retainInput && {[RETAIN_INPUT]: hooks.retainInput})};
      if (!(typeof __RAPIER_JXL_JPEG__ !== "undefined" && __RAPIER_JXL_JPEG__ === true) && isRowBridge(input)) {
        const port = input.rowsPort;
        try { return await module[operation](bridgedRows(input), call); } finally { port.close(); }
      }
      const driven = !((typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) && encodes(operation) && module[operation][DRIVE];
      if (driven && helpers && helper && hooks.helpers && !hooks.lane) return await driven(input, call, lone(hooks));
      return await module[operation](input, call);
      } finally { if (hooks.owned !== false && (typeof ImageBitmap === 'function' && input instanceof ImageBitmap || typeof VideoFrame === 'function' && input instanceof VideoFrame)) input.close(); }
    },
    async prepare(operation, {webgpu, owner, helpers: reservation} = {}) {
      checkOp(operation);
      if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && gpu && (encodes(operation) || operation === 'format') && webgpu === 'required') await gpu('required');
      if (!((typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) || (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_NO_HELPERS__ !== 'undefined' && __RAPIER_JXL_NO_HELPERS__ === true)) && !((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) && encodes(operation) && owner && reservation?.count && helpers && helper) {
        const loaded = await helperModule();
        if (!closed.has(owner)) await loaded.warmHelpers(owner, reservation, helper);
      }
      const takes = module.prepare?.operations;
      return module.prepare?.(takes ? (takes.includes(operation) ? operation : takes[0]) : undefined);
    },
    async release(owner, final = false) {
      if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
        if (final) closed.add(owner);
        if (pool) await (await pool).closeHelpers(owner, final);
      }
    },
  });
}

