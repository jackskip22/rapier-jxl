// SPDX-License-Identifier: MIT
// Rapier JXL's JPEG door: a JPEG carried as its coefficients into JPEG XL, its quantised DCT coefficients,
// quantisation tables, colour and subsampling kept, only the entropy coding changed, so the picture decodes to the
// JPEG's own pixels in fewer bytes. Baseline, extended sequential and progressive scans, with restarts; 8-bit; grey,
// YCbCr or RGB; an Exif orientation kept; a profile that is sRGB or Display P3 by what it does declared in the header.
// Not carried: the JPEG reconstruction data (the JPEG file itself cannot be rebuilt from the stream), the ICC bytes,
// Exif beyond the orientation, XMP. A JPEG this path does not take (arithmetic coding, 12-bit, lossless, CMYK, a DNL
// height, another colour profile, a file cut short) is refused as JXL_JPEG; decode it and encode its pixels instead.
import {parseJPEG} from './jfif.mjs';
import {coefficientEffortSteps} from './coefficient-effort.mjs';
import {admitEffort} from './effort-level.mjs';
import {JPEG_LIMITS, complete} from './bits.mjs';
import {fault, admitSize, job} from './admit.mjs';

// This door's limits (bits.mjs): 64 million pixels, its memory 6.4 bytes a pixel at 4:4:4 and 3.3 at 4:2:0 besides the
// JPEG at that size, so a phone's 24 and 48 megapixel JPEGs are carried.
export {JPEG_LIMITS as LIMITS};

export function transcode(jpeg, options) {
  const it = transcodeSteps(jpeg, options);
  complete(it);
  return {bytes: it.bytes, width: it.width, height: it.height, orientation: it.orientation};
}

// The same work as a job (admit.mjs): the scans read in the first step, which also sets the job's width, height and
// orientation (the picture as shown), then the VarDCT writer's steps.
export function transcodeSteps(jpeg, options) {
  const effort = admitEffort(options);
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'A JPEG is a non-empty Uint8Array.');
  if (jpeg.length > JPEG_LIMITS.bytes) throw fault('JXL_SIZE', 'A JPEG is at most 16 MiB.');
  const it = job(carry(jpeg, effort, shown => Object.assign(it, shown)));
  return it;
}

function* carry(jpeg, effort, shown) {
  const parsed = parseJPEG(jpeg);
  admitSize(parsed.width, parsed.height, JPEG_LIMITS);
  const swapped = parsed.orientation >= 5;
  shown({width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation});
  return yield* coefficientEffortSteps(parsed, effort);
}
