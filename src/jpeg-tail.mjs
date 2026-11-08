// SPDX-License-Identifier: MIT
import {withTail, admitTail, packTailSteps, isoGainMap, gainMapOf, mpfImages, restoreJPEGSteps, MAX_NESTING} from './jpeg-reconstruction.mjs';
import {fault} from './admit.mjs';
import {carried, stage, PASSED, unread} from './step-journal.mjs';

const WINDOW = 131072;
function* nextJPEG(jpeg, end) {
  return yield* stage('tail-search', function* () {
    let at = 0, found = false;
    while (!found && at + 2 < jpeg.length - end) {
      const next = yield* carried('tail-search-window', () => {
        const part = jpeg.subarray(end + at, Math.min(jpeg.length, end + at + WINDOW + 2));
        let i = 0;
        while (i + 2 < part.length && !(part[i] === 255 && part[i + 1] === 216 && part[i + 2] === 255)) i++;
        return {at: at + i, found: i + 2 < part.length};
      });
      if (next !== PASSED) ({at, found} = next);
    }
    return at;
  });
}

function* exactTail(jpeg, file, maxPixels) {
  return yield* stage('tail-check', function* () {
    let back;
    try { back = yield* restoreJPEGSteps(file, null, {maxPixels}); }
    catch (error) { if (unread(error)) throw error; return false; }
    if (!back || back.length !== jpeg.length) return false;
    let at = 0, same = true;
    while (same && at < jpeg.length) {
      const next = yield* carried('tail-compare', () => {
        const end = Math.min(jpeg.length, at + WINDOW), actual = back.subarray(at, end), expected = jpeg.subarray(at, end);
        return {at: end, same: actual.every((v, i) => v === expected[i])};
      });
      if (next !== PASSED) ({at, same} = next);
    }
    return same;
  });
}

export function* longTail(jpeg, end, file, depth, next, maxPixels) {
  const soi = yield* nextJPEG(jpeg, end), tailLength = jpeg.length - end;
  let out = null;
  if (soi + 2 < tailLength && depth + 2 <= MAX_NESTING) {
    try {
      admitTail(soi);
      const inner = yield* next(jpeg.subarray(end + soi)), packed = yield* packTailSteps(jpeg.subarray(end, end + soi));
      const size = Uint8Array.of(packed.length >>> 24, (packed.length >>> 16) & 255, (packed.length >>> 8) & 255, packed.length & 255);
      const declared = !depth && isoGainMap(jpeg)?.length === 4 && mpfImages(jpeg).some(image => image.start === end + soi);
      const metadata = declared ? isoGainMap(jpeg.subarray(end + soi)) : null;
      if (metadata && metadata.length > 4 && metadata.length < 65536) {
        const {bundle, rest} = gainMapOf(inner, metadata);
        out = withTail(file, 2, soi, [size, packed, rest], bundle);
      } else out = withTail(file, 1, soi, [size, packed, inner]);
    }
    catch (error) { if (error.code !== 'JXL_JPEG' && error.code !== 'JXL_DIMENSIONS') throw error; }
  }
  if (!out) { admitTail(tailLength); out = withTail(file, 0, tailLength, [yield* packTailSteps(jpeg.subarray(end))]); }
  if (!depth) {
    if (!(yield* exactTail(jpeg, out, maxPixels))) throw fault('JXL_JPEG', 'JPEG: JPEG syntax cannot be reconstructed exactly');
  }
  return out;
}
