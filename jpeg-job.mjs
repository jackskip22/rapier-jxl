// SPDX-License-Identifier: MIT
// One checked JPEG job shared by the prefix and optional ANS doors.
import {parseJPEG} from './jfif.mjs';
import {admitEffort} from './effort-level.mjs';
import {JPEG_LIMITS, complete} from './bits.mjs';
import {fault, admitSize, job} from './admit.mjs';

export function jpegAnswer(it) {
  complete(it);
  return {bytes: it.bytes, width: it.width, height: it.height, orientation: it.orientation};
}

export function jpegJob(jpeg, options, coefficients) {
  const effort = admitEffort(options);
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'A JPEG is a non-empty Uint8Array.');
  if (jpeg.length > JPEG_LIMITS.bytes) throw fault('JXL_SIZE', 'A JPEG is at most 16 MiB.');
  const it = job(carry(jpeg, effort, shown => Object.assign(it, shown), coefficients));
  return it;
}

// The first step reads the scans and sets the shown dimensions and orientation;
// the selected coefficient writer then owns the remaining steps. Admission is shared.
function* carry(jpeg, effort, shown, coefficients) {
  const parsed = parseJPEG(jpeg);
  admitSize(parsed.width, parsed.height, JPEG_LIMITS);
  const swapped = parsed.orientation >= 5;
  shown({width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation});
  return yield* coefficients(parsed, effort);
}
