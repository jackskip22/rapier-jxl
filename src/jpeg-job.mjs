// SPDX-License-Identifier: MIT
import {parseJPEGSteps, groupRows} from './jfif.mjs';
import {stage, journaling, journalJoin} from './step-journal.mjs';
import {withRenderingIntent} from './v7/header-intent.mjs';
import {admitEffort} from './effort-level.mjs';
import {LIMITS} from './limits.mjs';
import {complete} from './bits.mjs';
import {fault, admitSize, job} from './admit.mjs';
import {carryJPEGSteps, JBRD_TAIL, tailCut} from './jpeg-reconstruction.mjs';
import {offloading} from './offload.mjs';
import {jpegKernels} from './jpeg-kernels.mjs';

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
  const effort = admitEffort(options, undefined, coefficients.effortTen === true);
  if (options?.icc !== undefined && options.icc !== 'preserve') throw fault('JXL_INPUT', 'icc: preserve');
  if (options?.iccCompression !== undefined && (options.icc !== 'preserve' || !['auto', 'prefix', 'lz77'].includes(options.iccCompression)))
    throw fault('JXL_INPUT', 'iccCompression: auto, prefix or lz77 with icc: preserve');
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'input: nonempty Uint8Array');
  const profileOptions = {preserveICC: options?.icc === 'preserve', compression: options?.iccCompression, maxPixels: options?.maxPixels, bands: options?.bands};
  const outside = typeof options?.outside === 'function' ? options.outside : null;
  const belowBytes = options?.belowBytes > 0 ? options.belowBytes : 0;
  return carry(jpeg, effort, shown, coefficients, profileOptions, typeof options?.tails === 'function' ? options.tails : null, 0, outside, typeof options?.gainMap === 'function' ? options.gainMap : null, belowBytes);
}

function* carry(jpeg, effort, shown, coefficients, profileOptions, tails, depth = 0, outside = null, gainMap = null, belowBytes = 0, orientation = 0) {
  const read = yield* stage('parse', function* () {
    const {band, rows, ...data} = yield* parseJPEGSteps(jpeg, true, {...profileOptions, maxPixels: profileOptions.maxPixels ?? LIMITS.pixels, bands: profileOptions.bands ?? (!(!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()) && {from: EDGE ? 0 : BANDS_FROM})});
    if (data.bandFrame) {
      for (const c of data.components) delete c.band;
      for (const {scan} of data.bandFrame.bands) for (const s of scan) { delete s.dc; delete s.ac; }
    }
    return data;
  });
  const parsed = read.bandFrame ? Object.assign(read, groupRows(jpeg, read.bandFrame)) : read;
  parsed.jpegReconstruction = true;
  if (orientation && !parsed.hasOrientation) parsed.orientation = orientation;
  if (profileOptions.preserveICC) parsed.preserveICC = true;
  if (profileOptions.scalarMap) parsed.scalarMap = true;
  admitSize(parsed.width, parsed.height, LIMITS);
  const swapped = parsed.orientation >= 5;
  shown?.({width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation});
  if (belowBytes > 0 && !journaling() && (jpegKernels()?.acLowerBound?.(parsed) ?? 0) > belowBytes) return new Uint8Array(0);
  const codestream = withRenderingIntent(yield* stage('coefficients', () => coefficients(parsed, effort), undefined, false, true),
    parsed.renderingIntent, journaling() ? journalJoin : undefined), end = parsed.end;
  let foundGainMap;
  const promoted = gainMap && !depth && tails && jpeg.length > end && !!(yield* stage('gain-map-check', function* () { return !!(foundGainMap = gainMap(jpeg, end)); }));
  if ((jpeg.length - end <= JBRD_TAIL && !promoted) || !tails) return yield* carryJPEGSteps(jpeg, parsed, codestream, effort, coefficients.contextsFrom, coefficients.iccCoder);
  const cut = promoted ? end : end + (yield* stage('tail-cut', function* () { return tailCut(jpeg, end); }));
  const file = yield* carryJPEGSteps(jpeg.subarray(0, cut), parsed, codestream, effort, coefficients.contextsFrom, coefficients.iccCoder);
  outside?.(jpeg.length - cut);
  return yield* tails(jpeg, cut, file, depth, next => carry(next, effort, null, coefficients, promoted ? {...profileOptions, scalarMap: true} : profileOptions, tails, depth + 1, null, null, 0, promoted ? parsed.orientation : 0), profileOptions.maxPixels, gainMap, foundGainMap);
}
