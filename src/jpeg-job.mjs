// SPDX-License-Identifier: MIT
import {parseJPEGSteps, groupRows} from './jfif.mjs';
import {stage} from './step-journal.mjs';
import {admitEffort} from './effort-level.mjs';
import {JPEG_LIMITS} from './limits.mjs';
import {complete} from './bits.mjs';
import {fault, admitSize, job} from './admit.mjs';
import {carryJPEGSteps, JBRD_TAIL} from './jpeg-reconstruction.mjs';
import {offloading} from './offload.mjs';

const BANDS_FROM = 48 << 20;
const EDGE = globalThis.navigator?.userAgent === 'Cloudflare-Workers' || typeof globalThis.EdgeRuntime === 'string';

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
  if (options?.icc !== undefined && options.icc !== 'preserve') throw fault('JXL_INPUT', 'JPEG icc is preserve, or omitted.');
  if (options?.iccCompression !== undefined && (options.icc !== 'preserve' || !['auto', 'prefix', 'lz77'].includes(options.iccCompression)))
    throw fault('JXL_INPUT', 'JPEG ICC compression is auto, prefix or lz77, with icc: preserve.');
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'A JPEG is a non-empty Uint8Array.');
  const profileOptions = {preserveICC: options?.icc === 'preserve', compression: options?.iccCompression, maxPixels: options?.maxPixels, bands: options?.bands};
  return carry(jpeg, effort, shown, coefficients, profileOptions, typeof options?.tails === 'function' ? options.tails : null);
}

function* carry(jpeg, effort, shown, coefficients, profileOptions, tails, depth = 0) {
  const read = yield* stage('parse', function* () {
    const {band, rows, ...data} = yield* parseJPEGSteps(jpeg, true, {...profileOptions, maxPixels: profileOptions.maxPixels ?? JPEG_LIMITS.pixels, bands: profileOptions.bands ?? (!offloading() && {from: EDGE ? 0 : BANDS_FROM})});
    if (data.bandFrame) {
      for (const c of data.components) delete c.band;
      for (const {scan} of data.bandFrame.bands) for (const s of scan) { delete s.dc; delete s.ac; }
    }
    return data;
  });
  const parsed = read.bandFrame ? Object.assign(read, groupRows(jpeg, read.bandFrame)) : read;
  parsed.jpegReconstruction = true;
  admitSize(parsed.width, parsed.height, JPEG_LIMITS);
  const swapped = parsed.orientation >= 5;
  shown?.({width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation});
  const codestream = yield* stage('coefficients', () => coefficients(parsed, effort), undefined, false, true), end = parsed.end;
  if (jpeg.length - end <= JBRD_TAIL || !tails) return yield* carryJPEGSteps(jpeg, parsed, codestream, effort, coefficients.contextsFrom);
  const file = yield* carryJPEGSteps(jpeg.subarray(0, end), parsed, codestream, effort, coefficients.contextsFrom);
  return yield* tails(jpeg, end, file, depth, next => carry(next, effort, null, coefficients, profileOptions, tails, depth + 1), profileOptions.maxPixels);
}
