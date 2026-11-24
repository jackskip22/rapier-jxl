// SPDX-License-Identifier: MIT
import {photoDomain, nativePhotoRGB8} from './photo-samples.mjs';
import {cpuMeasure} from './photo-measure.mjs';
import {linearFromRGBA} from './linear-table.mjs';
import {linearFromTransform} from './color-bytes.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';
import {captureComposeOver} from './capture-kernels.mjs';

import {compileKernels} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';
import {s2Dimensions} from './ssimulacra2-input.mjs';

const BACKGROUNDS = [255, 0];
const check = signal => { if (signal?.aborted) throw signal.reason; };
export const preparePictureMeasure = () => compileKernels();

const opaque = rgba => {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
};

function over(rgba, width, height, background) {
  const out = new Uint8Array(rgba.subarray(0, width * height * 4));
  if (!captureComposeOver(out, rgba, width, height, background)) throw fault('JXL_WASM', 'WebAssembly SIMD required');
  return out;
}

function worse(a, b) {
  const out = {...a, ssimulacra2: Math.min(a.ssimulacra2, b.ssimulacra2)};
  if (a.nativeScores && b.nativeScores) {
    const low = key => Math.min(a.nativeScores[key], b.nativeScores[key]);
    out.nativeScores = {package: low('package'), native: low('native'), minimum: low('minimum')};
  }
  for (const key of ['cells', 'blocks']) if (a[key] && b[key]) out[key] = a[key].map((value, i) => Math.max(value, b[key][i]));
  return out;
}

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
  let closed = false, sourceOpaque = null, alphaLooks = null;
  const makeLook = background => {
    const src = background === null ? source.data : over(source.data, width, height, background);
    return cpuMeasure(null, width, height, {
      reference: isP3 ? () => linearFromTransform(src, width * height, P3_TRANSFORM) : {rgba: src},
      immutable: true,
      native: background === null ? true : !isP3,
      cacheBytes,
      reconstruct: picture => {
        const rgba = background === null ? picture.rgba : over(picture.rgba, width, height, background);
        return isP3 ? linearFromTransform(rgba, width * height, P3_TRANSFORM) : linearFromRGBA(rgba, width * height);
      },
      rgbaOutputs: isP3 ? undefined : picture => {
        const pkg = background === null ? picture.rgba : over(picture.rgba, width, height, background);
        return picture.native
          ? [{kind: 'package', rgba: pkg}, {kind: 'native', rgba: background === null ? picture.native : over(picture.native, width, height, background)}]
          : [{kind: 'package', rgba: pkg}];
      },
    });
  };
  const measure = makeLook(null);
  return {
    domain: 'decoded-output',
    measure(picture, want) {
      if (closed) throw fault('JXL_INTERNAL', 'photo-picture-measure:closed');
      check(signal);
      if (picture.width !== width || picture.height !== height || !picture.rgba)
        throw fault('JXL_DIMENSIONS', 'shown picture: size mismatch');
      sourceOpaque ??= opaque(source.data);
      const useAlpha = !sourceOpaque || !opaque(picture.rgba) || Boolean(picture.native && !opaque(picture.native));
      const scores = useAlpha
        ? worse(...(alphaLooks ??= BACKGROUNDS.map(makeLook)).map(look => look(picture, want)))
        : measure(picture, want);
      check(signal);
      return scores;
    },
    destroy() {
      if (closed) return;
      closed = true;
      measure.destroy();
      if (alphaLooks) for (const look of alphaLooks) look.destroy();
      alphaLooks = source = null;
    },
  };
}
