// SPDX-License-Identifier: MIT
// Reference plugin for SnapDOM 3.x. A few dozen lines SnapDOM can own.
// `result.toJxl()` after `snapdom(element, {plugins: [jxl()]})`, or `snapdom.toJxl(element)` once installed.
import {encodeCapture} from 'rapier-jxl/capture';

export function jxl() {
  return {
    name: 'jxl',
    defineExports({exports}) {
      return {
        jxl: async (ctx, opts = {}) => {
          const requested = ctx.export?.requestedOptions ?? {};
          const canvas = await exports.canvas({
            ...opts,
            scale: Object.hasOwn(requested, 'scale') ? opts.scale : 1,
            dpr: Object.hasOwn(requested, 'dpr') ? opts.dpr : 1,
          });
          const context = canvas.getContext('2d', {willReadFrequently: true});
          const {data, width, height} = context.getImageData(0, 0, canvas.width, canvas.height);
          const bytes = await encodeCapture(data, width, height, {
            signal: opts.signal,
            nearLossless: opts.nearLossless === true,
            ...(opts.maxColorError !== undefined ? {maxColorError: opts.maxColorError} : {}),
          });
          return new Blob([bytes], {type: 'image/jxl'});
        },
      };
    },
  };
}

export function install(snapdom) {
  snapdom.plugins(jxl());
  snapdom.toJxl = (element, options) => snapdom(element, {...options, plugins: [jxl()]}).then(result => result.toJxl(options));
  return snapdom;
}
