// SPDX-License-Identifier: MIT
// Rapier JXL: a JPEG XL encoder in pure JavaScript, the one Rapier's page carries. This is the core: pixels in, a bare
// codestream out, exact or lossy, alpha exact. A JPEG is carried by jpeg.mjs and a photograph written by photo.mjs;
// a module's author takes the layers from writer.mjs. No WebAssembly, no build step, no dependency, nothing read or
// fetched at run time.
import {inspectPixels, losslessSteps} from './lossless.mjs';
import {lossySteps} from './lossy.mjs';
import {LIMITS, complete, part} from './bits.mjs';
import {admitOptions, admitPixels, job} from './admit.mjs';

// What one call takes at most (bits.mjs): the 16 MiB codestream, 24 million pixels, 16,384 on a side. Larger asks are
// refused with a coded error before any work, the way a decoder would refuse them after it.
export {LIMITS};

// Straight RGBA bytes, row by row, to a codestream. Quality 100 (the default) is exact: an opaque alpha is dropped, a
// grey picture keeps one channel, up to 2048 colours use a palette when its complete stream is smaller, and direct
// colour goes through reversible YCoCg with gradient or average prediction chosen by samples. Quality 1 to 99 is lossy
// modular on libjxl's quality-to-distance curve (not equivalent PSNR), alpha still exact; a picture of few colours is
// answered exact when that is fewer bytes. The samples are sRGB, or Display P3 with {colorSpace: 'display-p3'}: the
// header declares the space and the samples are written as they are. The options are read before any work.
export function encode(data, width, height, options) { return complete(encodeSteps(data, width, height, options)); }

// The same work as a job (admit.mjs): the call admitted at once, then a group of one pass per step, the same bytes.
export function encodeSteps(data, width, height, options) {
  const {quality, colorSpace} = admitOptions(options);
  admitPixels(data, width, height);
  return job(pixelSteps(data, width, height, quality, colorSpace));
}

function* pixelSteps(data, width, height, quality, colorSpace) {
  const shape = inspectPixels(data, width, height);
  if (quality >= 100) return yield* losslessSteps(data, width, height, {shape, colorSpace});
  if (!shape.palette) return yield* lossySteps(data, width, height, {quality, shape, colorSpace});
  // The exact stream of a few-colour picture is cheap to make (256-pixel sections), so it is made first: a lossy
  // attempt that runs out of memory (its planes and Squeeze copies cost eight bytes a pixel and more) still answers.
  const exact = yield* part(losslessSteps(data, width, height, {shape, colorSpace}), 0, 2);
  let bytes;
  try { bytes = yield* part(lossySteps(data, width, height, {quality, shape, colorSpace}), 1, 2); }
  catch (error) { if (!(error instanceof RangeError) || error.code) throw error; bytes = exact; }
  return exact.length <= bytes.length ? exact : bytes;
}
