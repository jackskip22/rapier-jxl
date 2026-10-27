/** SnapDOM 3 export plugin. The host owns and closes the encoder. */
export function jxlExport({ encoder, maxError = 0, gpu = 'auto' } = {}) {
  if (typeof encoder?.encode !== 'function') {
    throw new TypeError('jxlExport requires an encoder');
  }
  return {
    name: 'jxl-export',
    defineExports({ exports }) {
      return {
        async jxl(_ctx, options = {}) {
          options.signal?.throwIfAborted();
          const canvas = await exports.canvas(options);
          const bytes = await encoder.encode(canvas, {
            maxError: options.maxError ?? maxError,
            gpu: options.gpu ?? gpu,
            signal: options.signal,
            onProgress: options.onProgress,
          });
          return new Blob([bytes], { type: 'image/jxl' });
        },
      };
    },
  };
}
