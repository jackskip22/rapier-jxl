// SPDX-License-Identifier: MIT
import {gaborishRows} from './photo-v6.mjs';
import {bandedOutputs} from './photo-reconstruct-bands.mjs';
import {rebuildPicture} from './photo-rebuild.mjs';
import {rebuildKernels} from './rebuild-kernels.mjs';
import {codedBytesFromLinear} from './color-bytes.mjs';
import {nativeRGBA} from './photo-output.mjs';
import {layoutPicture, unpackLayout} from './photo-layout-picture.mjs';
import {packRow} from './photo-packed-picture.mjs';
import {maskEnergy} from './photo-mask.mjs';
import {xybStrategies} from './varblocks.mjs';
import {restorationSizes, RESTORE_ROWS} from './vardct-inverse.mjs';
import {fault} from './fault.mjs';
import {scoreBandGeometry, scoreBandFits, SCORE_RECON_ROWS, SCORE_COEFF_ROWS} from './band-geometry.mjs';
import {scoreBandCapacity} from './photo-band-storage.mjs';

const CAPTURE_OR_UPLOAD = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true);

export function scoreBandBytes(width, height, alpha = false) {
  const w = Math.ceil(width / 8) * 8, h = Math.min(Math.ceil(height / 8) * 8, SCORE_RECON_ROWS), p = w * h, blocks = p / 64;
  const blocks52 = (w / 8) * (Math.min(Math.ceil(height / 8) * 8, SCORE_COEFF_ROWS) / 8), page = n => Math.ceil(n / 65536) * 65536;
  const {inputBytes, outputBytes} = scoreBandCapacity(width, height, alpha);
  const workFrom = page(3674112 + 36 * blocks + 131072 + Math.ceil(w / 2048) * 16384 + 12 * p);
  const restore = restorationSizes(w, h, {gaborish: true, epf: {iters: 1}}, RESTORE_ROWS)
    .reduce((sum, n) => sum + Math.ceil(n / 16) * 16, 0);
  const rebuild = page(Math.max(workFrom + 192 * blocks52 * 4, workFrom + 12 * blocks52 * 64 + 4 * p + restore + 65536));
  const planes = 24 * w * Math.min(Math.ceil(height / 8) * 8, 80), small = 48 * blocks52;
  return inputBytes + 2 * outputBytes + 272 * 65536 + rebuild + planes + small + 4 * 1048576;
}

export const nativeBandOf = (width, origin = 0) => (linear, from, count, out, at, y = at / width) => nativeRGBA(
  linear.map(p => p.subarray(from, from + count)), width, count / width, {y: y + origin},
  new Uint8Array(out.buffer, out.byteOffset + at * 4, count * 4));

export function scoreBandWorkspace(width, height) {
  const w = Math.ceil(width / 8) * 8, h = Math.ceil(height / 8) * 8, geometry = scoreBandGeometry(width, height);
  const h384 = Math.min(h, SCORE_RECON_ROWS), p = w * h384, blocks = p / 64, blocks52 = (w / 8) * (Math.min(h, SCORE_COEFF_ROWS) / 8);
  const page = n => Math.ceil(n / 65536) * 65536;
  const workFrom = page(3674112 + 36 * blocks + 131072 + Math.ceil(w / 2048) * 16384 + 12 * p);
  const restore = restorationSizes(w, h384, {gaborish: true, epf: {iters: 1}}, RESTORE_ROWS)
    .reduce((sum, n) => sum + Math.ceil(n / 16) * 16, 0);
  const totalRebuild = page(Math.max(workFrom + 192 * blocks52 * 4, workFrom + 12 * blocks52 * 64 + 4 * p + restore + 65536));
  const small = new Int32Array(12 * blocks52);
  let planes = null, sAt = 0, wAt = 0, callIdx = 0, wasmI32 = null, tempRated = null;
  return {width, height, geometry, get planes() { return planes; }, get gaborish() { return null; },
    fits: (w, h) => scoreBandFits(geometry, scoreBandGeometry(w, h)),
    ensurePlanes() {
      if (!planes) planes = [0, 1, 2].map(() => new Float64Array(w * Math.min(h, 80)));
    },
    reset(w, h, rated = false, needRebuild = true) {
      if (!scoreBandFits(geometry, scoreBandGeometry(w, h))) throw fault('JXL_INTERNAL', 'photo-band-score:geometry');
      sAt = 0; callIdx = 0;
      if (rated) {
        tempRated = new Int32Array(206 * blocks52);
        wasmI32 = tempRated; wAt = 0;
      } else if (needRebuild) {
        tempRated = null;
        const rk = rebuildKernels();
        rk.reserve([totalRebuild - rk.arena]);
        wasmI32 = rk.i32; wAt = workFrom >> 2;
      } else {
        tempRated = null; wasmI32 = null; wAt = 0;
      }
    },
    releaseTemp() { if (wasmI32 === tempRated) wasmI32 = null; tempRated = null; },
    allocate(n) {
      if (!Number.isSafeInteger(n) || n < 0) throw fault('JXL_INTERNAL', 'photo-band-score:workspace');
      const idx = callIdx++;
      if (!tempRated && idx !== 1 && sAt + n <= small.length) {
        const values = small.subarray(sAt, sAt += n);
        values.fill(0);
        return values;
      }
      if (!wasmI32 || wAt + n > wasmI32.length) throw fault('JXL_INTERNAL', 'photo-band-score:workspace');
      const values = wasmI32.subarray(wAt, wAt += n);
      values.fill(0);
      return values;
    },
  };
}

const sourceOf = (rows, top, width) => {
  const end = top + rows.length / (width * 4);
  return {subarray(a, b) {
    if (a < top * width * 4 || b > end * width * 4) throw fault('JXL_INTERNAL', 'photo-band-score:bounds');
    return rows.subarray(a - top * width * 4, b - top * width * 4);
  }};
};

export function scoreBandOutputs(recipe, rows, top, width, height, y0, y1, workspace, into, rated = false) {
  if (!into) throw fault('JXL_INTERNAL', 'photo-band-score:into');
  workspace?.reset(width, height, rated, true);
  try {
    const origin = recipe.origin, W = Math.ceil(width / 8) * 8;
    let planeRows = null;
    if (recipe.sharedDct) {
      planeRows = () => { throw fault('JXL_INTERNAL', 'photo-band-score:dct'); };
    } else if (recipe.sharedPlanes) {
      const sp = recipe.sharedPlanes;
      planeRows = () => ({planes: sp.planes, top: sp.top, stride: W});
    } else {
      const source = sourceOf(rows, top, width);
      workspace?.ensurePlanes?.();
      const planes = gaborishRows(source, width, height, recipe.gaborish, false, workspace?.planes);
      planeRows = (from, to, x0, x1) => {
        const band = planes(from + origin, to + origin, x0, x1);
        return {...band, top: band.top - origin, stride: W};
      };
    }
    const base = {...recipe.base, ...(recipe.sharedDct && {dctPack: recipe.sharedDct}), planeRows};
    const image = layoutPicture(base, width, base.height, unpackLayout(recipe.layout), rated ? {...recipe.options, rated: true} : recipe.options, false, workspace?.allocate);
    if (recipe.gaborish?.transform) {
      const from = (y0 - origin) * width, count = (y1 - y0) * width;
      const made = rebuildPicture(image.lazyStrategy.rows(0, image.components[0].rows, true),
        {rgba: false, linear: true, views: true, transform: recipe.gaborish.transform, sliceFrom: from, sliceCount: count, transformOut: into.package});
      if (!made.transformed) codedBytesFromLinear(made.sliced ? made.linear : made.linear.map(p => p.subarray(from, from + count)), count, recipe.gaborish.transform, into.package);
      return {pack: into.package, own: into.native};
    }
    const {package: pack, native: own} = bandedOutputs(image, y1 - y0, nativeBandOf(width, origin), null,
      y0 - origin, y1 - origin, into);
    if (!rated) return {pack, own};
    const stride = recipe.base.components[0].stride, from = (y0 - origin) / 8 * stride;
    return {pack, own, rates: image.rates.slice(from, from + Math.ceil((y1 - y0) / 8) * stride)};
  } finally {
    workspace?.releaseTemp?.();
  }
}

export const shapeBandChoices = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ||
  (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function shapeBandChoices(task, workspace) {
  const {width, height, top, rows, sharedPlanes, planeTop, gaborish, base: b, maskWeight, options, by0, by1} = task;
  workspace?.reset(width, height);
  const stride = b.stride, W = stride * 8;
  let planeRows;
  if (sharedPlanes) {
    planeRows = () => ({planes: sharedPlanes, top: planeTop, stride: W});
  } else {
    const end = top + rows.length / (width * 4);
    const source = {subarray(a, e) {
      if (a < top * width * 4 || e > end * width * 4) throw fault('JXL_INTERNAL', 'photo-band-score:bounds');
      return rows.subarray(a - top * width * 4, e - top * width * 4);
    }};
    workspace?.ensurePlanes?.();
    const rowFn = gaborishRows(source, width, height, gaborish, false, workspace?.planes, workspace?.gaborish);
    planeRows = (f, t, x0, x1) => ({stride: W, ...rowFn(f, t, x0, x1)});
  }
  const empty = new Int16Array(0);
  const localBase = {
    width: b.width, height: b.height,
    components: b.quants.map(quant => ({h: 1, v: 1, stride, rows: b.fullRows, quant, coeffs: empty})),
    quantScale: b.quantScale, epf: b.epf, xyb: b.xyb, ycbcr: b.ycbcr,
    ...(b.quantFields && {quantFields: b.quantFields, quantFieldBase: b.quantFieldBase}),
    ...(b.cfl && {cfl: b.cfl}),
    planeRows,
  };
  return xybStrategies(localBase, width, height, {...options, ...(maskWeight && {maskWeight}), priceOnly: true, chooseOnly: true, regionRows: [by0, by1]});
};

export const maskBandEnergy = CAPTURE_OR_UPLOAD ? null : function maskBandEnergy(task, workspace) {
  const {width, height, top, rows, gaborish, stride, by0, by1} = task;
  workspace?.reset(width, height, false, false);
  const source = sourceOf(rows, top, width);
  workspace?.ensurePlanes?.();
  const rowFn = gaborishRows(source, width, height, gaborish, false, workspace?.planes);
  const hf = new Float64Array((by1 - by0) * stride);
  for (let by = by0; by < by1; by++) {
    const {planes: p, top: pTop} = rowFn(by * 8, by * 8 + 8);
    maskEnergy(p, pTop - by0 * 8, stride, by - by0, by - by0 + 1, hf);
  }
  return hf;
};

export const packBandRow = CAPTURE_OR_UPLOAD ? null : function packBandRow(task, workspace) {
  const {recipe, rows, top, width, height, gy} = task;
  workspace?.reset(width, height, false, true);
  const origin = recipe.origin, W = Math.ceil(width / 8) * 8;
  let planeRows;
  if (recipe.sharedPlanes) {
    const sp = recipe.sharedPlanes;
    planeRows = () => ({planes: sp.planes, top: sp.top, stride: W});
  } else {
    const source = sourceOf(rows, top, width);
    workspace?.ensurePlanes?.();
    const planes = gaborishRows(source, width, height, recipe.gaborish, false, workspace?.planes);
    planeRows = (from, to, x0, x1) => {
      const band = planes(from + origin, to + origin, x0, x1);
      return {...band, top: band.top - origin, stride: W};
    };
  }
  const base = {...recipe.base, planeRows};
  const image = layoutPicture(base, width, base.height, unpackLayout(recipe.layout), recipe.options, false, workspace?.allocate);
  const band = image.lazyStrategy.rows(0, image.components[0].rows, true);
  return packRow(band, 0, gy * 32);
};
