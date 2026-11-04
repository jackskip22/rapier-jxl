// SPDX-License-Identifier: MIT
import {withTail, admitTail, packTail, isoGainMap, gainMapOf, mpfImages, restoreJPEG, MAX_NESTING} from './jpeg-reconstruction.mjs';
import {fault} from './admit.mjs';

export function* longTail(jpeg, end, file, depth, next, maxPixels) {
  const tail = jpeg.subarray(end);
  let soi = 0;
  while (soi + 2 < tail.length && !(tail[soi] === 0xFF && tail[soi + 1] === 0xD8 && tail[soi + 2] === 0xFF)) soi++;
  let out = null;
  if (soi + 2 < tail.length && depth + 2 <= MAX_NESTING) {
    try {
      admitTail(soi);
      const inner = yield* next(tail.subarray(soi)), packed = packTail(tail.subarray(0, soi));
      const size = Uint8Array.of(packed.length >>> 24, (packed.length >>> 16) & 255, (packed.length >>> 8) & 255, packed.length & 255);
      const declared = !depth && isoGainMap(jpeg)?.length === 4 && mpfImages(jpeg).some(image => image.start === end + soi);
      const metadata = declared ? isoGainMap(tail.subarray(soi)) : null;
      if (metadata && metadata.length > 4 && metadata.length < 65536) {
        const {bundle, rest} = gainMapOf(inner, metadata);
        out = withTail(file, 2, soi, [size, packed, rest], bundle);
      } else out = withTail(file, 1, soi, [size, packed, inner]);
    }
    catch (error) { if (error.code !== 'JXL_JPEG' && error.code !== 'JXL_DIMENSIONS') throw error; }
  }
  if (!out) { admitTail(tail.length); out = withTail(file, 0, tail.length, [packTail(tail)]); }
  if (!depth) {
    let back = null;
    try { back = restoreJPEG(out, null, {maxPixels}); } catch {}
    if (!back || back.length !== jpeg.length || !back.every((v, i) => v === jpeg[i])) throw fault('JXL_JPEG', 'JPEG: JPEG syntax cannot be reconstructed exactly');
  }
  return out;
}
