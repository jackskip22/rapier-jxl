// SPDX-License-Identifier: MIT
import {completionOptions} from './result-operation.mjs';
import {fitWith} from './preparation-fit.mjs';
import {variantsWith} from './preparation-variants.mjs';
import {DRIVE} from './drive.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {check, fail, declared, optionSymbol} from './primitives.mjs';
import {JOURNAL} from '../step-journal.mjs';
import {previewCall} from './preview.mjs';
import {DEVICE_RAN} from './result-reference.mjs';
import {withinCall, withinPicture} from '../call-scope.mjs';
import {suppliedWasm} from '../wasm-modules.mjs';

export const VARIANTS_HELPERS = /* @__PURE__ */ optionSymbol('rapier-jxl.variants-helpers');

export function withVariantsHelpers(runtime, pool, name, file, ready) {
  const helper = file && {...file, module: name, protocol: WORKER_PROTOCOL, wasm: suppliedWasm};
  const closed = new WeakSet();
  return Object.freeze({...runtime,
    run(operation, input, options, hooks = {}) {
      if (operation === 'variants' && helper && hooks.helpers?.count && !hooks.lane && hooks.alone !== false) {
        const owner = hooks.owner ?? hooks.helpers;
        options = {...options, [VARIANTS_HELPERS]: {
          reservation: hooks.helpers,
          encode(picture, encodeOptions, {signal, onProgress} = {}) {
            const send = () => {
              if (closed.has(owner)) throw fail('JXL_CLOSED', 'closing');
              return pool.helperJob(owner, hooks.helpers, {
                kind: 'whole', operation: 'encode', input: picture, options: encodeOptions,
                maxPixels: hooks.maxPixels, webgpu: hooks.webgpu,
              }, {signal, onProgress, helper});
            };
            const waiting = ready?.(signal);
            return waiting ? waiting.then(send) : send();
          },
        }};
      }
      return runtime.run(operation, input, options, hooks);
    },
    release(owner, final) {
      if (final) closed.add(owner);
      return Promise.resolve().then(() => runtime.release(owner, final)).catch(cause => {
        let code;
        try { code = cause?.code; } catch {}
        if (typeof code === 'string' && code.startsWith('JXL_')) throw cause;
        throw Object.assign(fail('JXL_WORKER', 'terminate() failed'), {cause});
      });
    },
  });
}

export function preparationWith(encode, hooks) {
  const bind = run => {
    const invoke = async (input, journal, variantHelpers, completion, helpers) => {
      const options = completion.options;
      const preview = previewCall(options);
      const drive = helpers && encode[DRIVE];
      const local = (picture, settings) => withinPicture(() => encode(picture, settings));
      const direct = drive ? (picture, settings) => withinPicture(() => drive(picture, settings, helpers)) : local;
      let ran = false;
      const markRan = () => { ran = true; };
      const marked = hooks.device ? (picture, settings) => direct(picture, {...settings, [DEVICE_RAN]: markRan}) : direct;
      const markedLocal = hooks.device ? (picture, settings) => local(picture, {...settings, [DEVICE_RAN]: markRan}) : local;
      const coder = journal === undefined ? marked : (picture, settings) => marked(picture, {...settings, [JOURNAL]: journal});
      const callHooks = journal !== undefined ? {...hooks, journal}
        : variantHelpers ? {...hooks, variantHelpers, localEncode: markedLocal, ...(hooks.device && {markDeviceRan: markRan})} : hooks;
      try {
        let result = await run(coder, input, options, callHooks).catch(error => { throw declared(error); });
        if (hooks.device) result = Array.isArray(result) ? result.map(each => ({...each, usedWebGPU: ran})) : {...result, usedWebGPU: ran};
        await completion.finish();
        await preview?.finish();
        return result;
      } finally { preview?.close(); }
    };
    const settle = (input, given, helpers) => {
      let completion;
      return withinCall(() => {
        const journal = given?.[JOURNAL], variantHelpers = given?.[VARIANTS_HELPERS];
        const clean = journal === undefined && variantHelpers === undefined ? given
          : (({[JOURNAL]: _journal, [VARIANTS_HELPERS]: _vh, ...rest}) => rest)(given);
        completion = completionOptions(clean);
        return invoke(input, journal, variantHelpers, completion, helpers);
      }).then(result => { check(completion.options.signal); return result; });
    };
    const operation = (input, options) => settle(input, options);
    operation[DRIVE] = (input, options, helpers) => settle(input, options, helpers);
    return operation;
  };
  return {fit: bind(fitWith), variants: bind(variantsWith)};
}
