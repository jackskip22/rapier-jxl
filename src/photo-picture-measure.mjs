// SPDX-License-Identifier: MIT
import {photoDomain, nativePhotoRGB8} from './photo-samples.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {butteraugliLinearFromRGBA} from './butteraugli.mjs';
import {compileKernels} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';
import {s2Dimensions} from './ssimulacra2-input.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
export const preparePictureMeasure = () => compileKernels();

export function pictureMeasure(source, {cacheBytes = 0, signal, maxPixels} = {}) {
  check(signal);
  const {width, height} = source;
  if (!nativePhotoRGB8(source, photoDomain(source, {maxPixels}))) return null;
  s2Dimensions(width, height);
  let closed = false;
  const measure = cpuMeasure(null, width, height, {reference: {rgba: source.data}, immutable: true, native: true, cacheBytes,
    reconstruct: picture => butteraugliLinearFromRGBA(picture.rgba, width * height),
    rgbaOutputs: picture => [{kind: 'package', rgba: picture.rgba}], distanceDetails: false});
  return {
    domain: 'decoded-output',
    measure(picture, want) {
      if (closed) throw fault('JXL_INTERNAL', 'The picture measurement is closed.');
      check(signal);
      if (picture.width !== width || picture.height !== height || !picture.rgba)
        throw fault('JXL_DIMENSIONS', 'The shown picture differs from the measurement reference.');
      const scores = measure(picture, want); check(signal); return scores;
    },
    destroy() { if (closed) return; closed = true; measure.destroy(); source = null; },
  };
}
