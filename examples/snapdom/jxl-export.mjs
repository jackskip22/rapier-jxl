// SPDX-License-Identifier: MIT
/** SnapDOM 3 export plug-in: `result.toJxl()`, on rapier-jxl 7's capture encoder. Pass `encode` from
 * `rapier-jxl/capture` (one shared module worker, started on the first call) or `encoder.capture` from your own
 * `createEncoder()`. */
export function jxlExport({encode, maxError = 0} = {}) {
  if (typeof encode !== 'function') throw new TypeError('jxlExport requires encode (rapier-jxl/capture)');
  return {
    name: 'jxl-export',
    // Optional, called by the host before a capture: starts the worker with a one-pixel encode, so the first export
    // does not wait for it. An export-only plug-in keeps SnapDOM's repeat-capture caching.
    prepare: () => encode({data: new Uint8Array(4), width: 1, height: 1}).then(() => {}),
    defineExports({exports}) {
      return {
        async jxl(_ctx, options = {}) {
          options.signal?.throwIfAborted();
          // SnapDOM's own canvas export of the captured clone: its size, scale and background options apply.
          const canvas = await exports.canvas(options);
          const bytes = await encode(canvas, {maxError: options.maxError ?? maxError, signal: options.signal, onProgress: options.onProgress});
          return new Blob([bytes], {type: 'image/jxl'});
        },
      };
    },
  };
}
