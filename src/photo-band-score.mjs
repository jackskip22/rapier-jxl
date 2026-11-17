// SPDX-License-Identifier: MIT
import {gaborishRows} from './photo-v6.mjs';
import {bandedOutputs} from './photo-reconstruct-bands.mjs';
import {rebuildPicture} from './photo-rebuild.mjs';
import {codedBytesFromLinear} from './color-bytes.mjs';
import {nativeRGBA} from './photo-output.mjs';
import {layoutPicture, unpackLayout} from './photo-layout-picture.mjs';
import {restorationSizes, RESTORE_ROWS} from './vardct-inverse.mjs';
import {fault} from './fault.mjs';

export function scoreBandBytes(width, height) {
  const w = Math.ceil(width / 8) * 8, h = Math.min(Math.ceil(height / 8) * 8, 384), p = w * h, blocks = p / 64;
  const tiles = Math.ceil(w / 64) * Math.ceil(h / 64), page = n => Math.ceil(n / 65536) * 65536;
  const payload = 4 * width * Math.min(height, 640) + 4 * p + 76 * blocks + 8 * tiles + 65536;
  const restore = restorationSizes(w, h, {gaborish: true, epf: {iters: 3}}, RESTORE_ROWS)
    .reduce((sum, n) => sum + Math.ceil(n / 16) * 16, 0);
  const rebuild = page(3674112 + 1579008 + 90112 + 8192 * Math.ceil(w / 2048) + 28 * p + 36 * blocks + restore + 1024);
  return payload + 40 * 1048576 + rebuild + 40 * w * Math.min(Math.ceil(height / 8) * 8, 400) + 16 * w
    + 2 * (12 * p + 12 * blocks) + 64 * blocks + 8 * tiles + 8 * p + 8 * 1048576
    + 20 * width * Math.min(height, 256);
}

export const nativeBandOf = (width, origin = 0) => (linear, from, count, out, at, y = at / width) => nativeRGBA(
  linear.map(p => p.subarray(from, from + count)), width, count / width, {y: y + origin},
  new Uint8Array(out.buffer, out.byteOffset + at * 4, count * 4));

export function scoreBandWorkspace(width, height) {
  const w = Math.ceil(width / 8) * 8, h = Math.ceil(height / 8) * 8;
  const planes = [0, 1, 2].map(() => new Float64Array(w * Math.min(h, 400)));
  const gaborish = {original: new Float64Array(w * Math.min(h, 400))};
  const coefficients = new Int32Array(195 * (w / 8) * (Math.min(h, 384) / 8));
  let at = 0;
  return {width, height, planes, gaborish, coefficients,
    reset(w, h) {
      if (w !== width || h !== height) throw fault('JXL_INTERNAL', 'photo-band-score:geometry');
      at = 0;
    },
    allocate(n) {
      if (!Number.isSafeInteger(n) || n < 0 || at + n > coefficients.length) throw fault('JXL_INTERNAL', 'photo-band-score:workspace');
      const values = coefficients.subarray(at, at += n);
      values.fill(0);
      return values;
    },
  };
}

export function scoreBandOutputs(recipe, rows, top, width, height, y0, y1, workspace, into) {
  if (!into) throw fault('JXL_INTERNAL', 'photo-band-score:into');
  workspace?.reset(width, height);
  const end = top + rows.length / (width * 4), origin = recipe.origin;
  const source = {subarray(a, b) {
    if (a < top * width * 4 || b > end * width * 4) throw fault('JXL_INTERNAL', 'photo-band-score:bounds');
    return rows.subarray(a - top * width * 4, b - top * width * 4);
  }};
  const planes = gaborishRows(source, width, height, recipe.gaborish, false, workspace?.planes, workspace?.gaborish);
  const base = {...recipe.base, planeRows(from, to, x0, x1) {
    const band = planes(from + origin, to + origin, x0, x1);
    return {...band, top: band.top - origin, stride: Math.ceil(width / 8) * 8};
  }};
  const image = layoutPicture(base, width, base.height, unpackLayout(recipe.layout), recipe.options, false, workspace?.allocate);
  if (recipe.gaborish?.transform) {
    const made = rebuildPicture(image.lazyStrategy.rows(0, image.components[0].rows), {rgba: false, linear: true, views: true});
    const from = (y0 - origin) * width, count = (y1 - y0) * width;
    codedBytesFromLinear(made.linear.map(p => p.subarray(from, from + count)), count, recipe.gaborish.transform, into.package);
    return {pack: into.package, own: into.native};
  }
  const {package: pack, native: own} = bandedOutputs(image, y1 - y0, nativeBandOf(width, origin), null,
    y0 - origin, y1 - origin, into);
  return {pack, own};
}