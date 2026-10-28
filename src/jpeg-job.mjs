// SPDX-License-Identifier: MIT
import {parseJPEG} from './jfif.mjs';
import {admitEffort} from './effort-level.mjs';
import {JPEG_LIMITS} from './limits.mjs';
import {complete} from './bits.mjs';
import {fault, admitSize, job} from './admit.mjs';
import {carryJPEG} from './jpeg-reconstruction.mjs';

export function jpegAnswer(it) {
  complete(it);
  return {bytes: it.bytes, width: it.width, height: it.height, orientation: it.orientation};
}

export function jpegJob(jpeg, options, coefficients) {
  const it = job(jpegSteps(jpeg, options, coefficients, shown => Object.assign(it, shown)));
  return it;
}

export function jpegSteps(jpeg, options, coefficients, shown) {
  const effort = admitEffort(options);
  if (options?.icc !== undefined && options.icc !== 'preserve') throw fault('JXL_INPUT', 'JPEG ICC mode is preserve, or omitted for named-profile compatibility.');
  if (options?.iccCompression !== undefined && (options.icc !== 'preserve' || !['auto', 'prefix', 'lz77'].includes(options.iccCompression)))
    throw fault('JXL_INPUT', 'JPEG ICC compression is auto, prefix or lz77 and requires icc:preserve.');
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'A JPEG is a non-empty Uint8Array.');
  const profileOptions = {preserveICC: options?.icc === 'preserve', compression: options?.iccCompression};
  return carry(jpeg, effort, shown, coefficients, profileOptions);
}

function* carry(jpeg, effort, shown, coefficients, profileOptions) {
  const parsed = parseJPEG(jpeg, true, profileOptions);
  parsed.jpegReconstruction = true;
  admitSize(parsed.width, parsed.height, JPEG_LIMITS);
  const swapped = parsed.orientation >= 5;
  shown({width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation});
  return carryJPEG(jpeg, parsed, yield* coefficients(parsed, effort), effort, coefficients.contextsFrom);
}
