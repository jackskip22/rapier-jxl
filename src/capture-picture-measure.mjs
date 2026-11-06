// SPDX-License-Identifier: MIT
import {captureDomain} from './capture-domain.mjs';
import {admitSize, fault} from './admit.mjs';
import {EDGE} from './limits.mjs';
import {s2Dimensions, s2RGBA} from './ssimulacra2-input.mjs';
import {linearFromTransform, P3_TRANSFORM} from './color-transform.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {compileKernels} from './kernel-runtime.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
export const prepareCapturePictureMeasure = () => compileKernels();

export function capturePictureMeasure(source, {cacheBytes = 0, signal, maxPixels} = {}) {
  check(signal); captureDomain(source);
  const {width, height, colorSpace = 'srgb'} = source;
  if (maxPixels !== undefined) {
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
      throw fault('JXL_INPUT', 'A capture measurement pixel limit is a positive whole number.');
    admitSize(width, height, {pixels: maxPixels, edge: EDGE});
  }
  const pixels = s2Dimensions(width, height), native = colorSpace === 'srgb';
  let referencePixels = s2RGBA(source.data, pixels, true), closed = false;
  const linear = data => native ? linearFromRGBA(data, pixels)
    : linearFromTransform(data, pixels, P3_TRANSFORM);
  const measure = cpuMeasure(null, width, height, {
    reference: native ? {rgba: referencePixels} : linear(referencePixels), immutable: true, native, cacheBytes,
    reconstruct: image => linear(image.data),
    rgbaOutputs: native ? image => [{kind: 'native', rgba: image.data}] : null,
    distanceDetails: true,
  });
  source = null;
  return {
    format: 'rgba-unorm8',
    domain: 'decoded-output',
    measure(picture, want) {
      if (closed) throw fault('JXL_INTERNAL', 'The capture picture measurement is closed.');
      check(signal);
      if (picture.width !== width || picture.height !== height)
        throw fault('JXL_DIMENSIONS', 'Native picture dimensions differ from the measurement reference.');
      captureDomain(picture);
      if ((picture.colorSpace ?? 'srgb') !== colorSpace)
        throw fault('JXL_PLATFORM', 'Native picture readback did not preserve the capture color domain.');
      const data = s2RGBA(picture.data, pixels, true);
      for (let y = 0; y < height; y++) {
        check(signal);
        for (let at = y * width * 4 + 3, end = (y + 1) * width * 4; at < end; at += 4)
          if (referencePixels[at] !== data[at])
            throw fault('JXL_PLATFORM', 'Native picture readback did not preserve the capture alpha samples.');
      }
      const scores = measure({data}, want); check(signal); return scores;
    },
    destroy() {
      if (closed) return;
      closed = true; referencePixels = null; measure.destroy();
    },
  };
}
