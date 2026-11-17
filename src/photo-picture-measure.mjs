// SPDX-License-Identifier: MIT
import {photoDomain, nativePhotoRGB8} from './photo-samples.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {linearFromRGBA} from './linear-table.mjs';
import {linearFromTransform} from './color-bytes.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';

import {compileKernels} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';
import {s2Dimensions} from './ssimulacra2-input.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
export const preparePictureMeasure = () => compileKernels();

function nativeP3RGB8(picture, domain) {
  const {samples, encoding, icc} = domain;
  return (picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray) && !icc &&
    samples.sampleFormat === 'uint' && samples.bitDepth === 8 && !samples.alphaPremultiplied &&
    samples.intensityTarget === 255 && encoding.space === 'rgb' &&
    encoding.whitePoint === 'd65' && encoding.primaries === 'display-p3' && encoding.transferFunction === 'srgb';
}

export function pictureMeasure(source, {cacheBytes = 0, signal, maxPixels} = {}) {
  check(signal);
  const {width, height} = source, domain = photoDomain(source, {maxPixels});
  const isSrgb = nativePhotoRGB8(source, domain), isP3 = !isSrgb && nativeP3RGB8(source, domain);
  if (!isSrgb && !isP3) return null;
  s2Dimensions(width, height);
  let closed = false;
  const reference = isP3 ? () => linearFromTransform(source.data, width * height, P3_TRANSFORM) : {rgba: source.data};
  const measure = cpuMeasure(null, width, height, {
    reference,
    immutable: true,
    native: true,
    cacheBytes,
    reconstruct: picture => isP3 ? linearFromTransform(picture.rgba, width * height, P3_TRANSFORM) : linearFromRGBA(picture.rgba, width * height),
    rgbaOutputs: isP3 ? undefined : picture => picture.native ? [{kind: 'package', rgba: picture.rgba}, {kind: 'native', rgba: picture.native}]
      : [{kind: 'package', rgba: picture.rgba}],
  });
  return {
    domain: 'decoded-output',
    measure(picture, want) {
      if (closed) throw fault('JXL_INTERNAL', 'photo-picture-measure:closed');
      check(signal);
      if (picture.width !== width || picture.height !== height || !picture.rgba)
        throw fault('JXL_DIMENSIONS', 'shown picture: size mismatch');
      const scores = measure(picture, want); check(signal); return scores;
    },
    destroy() { if (closed) return; closed = true; measure.destroy(); source = null; },
  };
}
