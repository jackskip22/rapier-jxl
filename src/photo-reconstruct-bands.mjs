// SPDX-License-Identifier: MIT
import {reconstruct} from './reconstruct.mjs';
import {captureLinearRGBAInto as toRGBAInto} from './capture-kernels.mjs';
import {rebuildPicture, rebuildable} from './photo-rebuild.mjs';
import {memoryPlan} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {bandScratch} from './band-scratch.mjs';
import {RECON_MARGIN, reconstructionRows} from './band-geometry.mjs';
export {RECON_MARGIN};

export function subBase(base, bx0, by0, bx1, by1) {
  const sliced = sliceBlocks(base, bx0, by0, bx1, by1), W = base.components[0].stride * 8, w = (bx1 - bx0) * 8;
  sliced.planes = base.planes.map(p => { const o = new p.constructor(w * (by1 - by0) * 8); for (let y = 0; y < (by1 - by0) * 8; y++) o.set(p.subarray((by0 * 8 + y) * W + bx0 * 8, (by0 * 8 + y) * W + bx0 * 8 + w), y * w); return o; });
  return sliced;
}

export function subImage(image, bx0, by0, bx1, by1) {
  if (image.lazyStrategy) return subImage(image.lazyStrategy.rows(by0, by1, bx0 === 0 && bx1 === image.components[0].stride), bx0, by0, bx1, by1);
  const sub = sliceBlocks(image, bx0, by0, bx1, by1), sd = image.strategyData;
  if (!sd) return sub;
  if (sd.compact && bx0 === 0 && bx1 === image.components[0].stride && sd.compact.by0 === by0 && sd.compact.rows === by1 - by0) {
    sub.strategyData = {compact: sd.compact, tables: sd.tables, stride: bx1 - bx0};
    return sub;
  }
  const stride = bx1 - bx0, rows = by1 - by0, at = new Int32Array(stride * rows).fill(-1), blocks = [];
  const push = b => {
    if (b.bx >= bx0 && b.bx < bx1 && b.by >= by0 && b.by < by1) {
      const moved = bx0 === 0 && by0 === 0 ? b : {id: b.id, bx: b.bx - bx0, by: b.by - by0, bw: b.bw, bh: b.bh,
        area: b.area, size: b.size, order: b.order, coeffs: b.coeffs, dc: b.dc, levels: b.levels};
      for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) at[(moved.by + y) * stride + moved.bx + x] = blocks.length;
      blocks.push(moved);
    }
  };
  if (!sd.packed && Array.isArray(sd.groups)) {
    const gxN = Math.ceil(image.components[0].stride / 32), gyN = Math.ceil(image.components[0].rows / 32);
    for (let gy = Math.max(0, (by0 >> 5) - 1), gy1 = Math.min(gyN, Math.ceil(by1 / 32)); gy < gy1; gy++)
      for (let gx = bx0 >> 5, gx1 = Math.min(gxN, Math.ceil(bx1 / 32)); gx < gx1; gx++)
        for (const b of sd.groups[gy * gxN + gx] ?? []) push(b);
  } else for (const b of sd.blocks) push(b);
  sub.strategyData = {groups: [blocks], blocks, at, tables: sd.tables, stride};
  return sub;
}

function sliceBlocks(image, bx0, by0, bx1, by1) {
  const comps = image.components, stride = comps[0].stride, sw = bx1 - bx0, sh = by1 - by0, n = sw * sh, fullRow = bx0 === 0 && sw === stride;
  const rows = (arr, per, row0 = 0) => {
    if (fullRow && ArrayBuffer.isView(arr)) return arr.subarray((by0 - row0) * stride * per, (by1 - row0) * stride * per);
    const o = ArrayBuffer.isView(arr) ? new arr.constructor(n * per) : new Float64Array(n * per);
    for (let y = 0; y < sh; y++) {
      const from = ((by0 - row0 + y) * stride + bx0) * per;
      if (ArrayBuffer.isView(arr)) o.set(arr.subarray(from, from + sw * per), y * sw * per);
      else for (let x = 0; x < sw * per; x++) o[y * sw * per + x] = arr[from + x];
    }
    return o;
  };
  const cfl = image.cfl, tw = Math.ceil(sw / 8), th = Math.ceil(sh / 8), tiles = arr => {
    if (bx0 === 0 && tw === cfl.width) return arr.subarray((by0 / 8) * tw, (by0 / 8 + th) * tw);
    const o = new arr.constructor(tw * th);
    for (let y = 0; y < th; y++) o.set(arr.subarray((by0 / 8 + y) * cfl.width + bx0 / 8, (by0 / 8 + y) * cfl.width + bx0 / 8 + tw), y * tw);
    return o;
  };
  const {planes: _planes, values: _values, coefficientRows, ...coded} = image;
  const observed = coefficientRows?.(by0, by1);
  const width = Math.min(image.width, bx1 * 8) - bx0 * 8, height = Math.min(image.height, by1 * 8) - by0 * 8;
  let alpha = null;
  if (image.alpha) {
    alpha = new image.alpha.constructor(width * height * 4);
    for (let y = 0; y < height; y++) alpha.set(image.alpha.subarray(((by0 * 8 + y) * image.width + bx0 * 8) * 4, ((by0 * 8 + y) * image.width + bx0 * 8 + width) * 4), y * width * 4);
  }
  return {...coded, width, height, alpha,
    components: comps.map((c, channel) => ({...c, stride: sw, rows: sh, dcRow0: undefined, ...(observed ? {coeffs: rows(observed[channel], 64, by0)}
      : c.coeffs?.length === stride * comps[0].rows * 64 ? {coeffs: rows(c.coeffs, 64)} : {}),
      ...(c.dc ? {dc: rows(c.dc, 1, c.dcRow0 ?? 0)} : {})})),
    quantFields: image.quantFields ? rows(image.quantFields, 1) : image.quantFields,
    ...(image.sharpness ? {sharpness: rows(image.sharpness, 1)} : {}),
    ...(cfl ? {cfl: {...cfl, width: tw, x: tiles(cfl.x), b: tiles(cfl.b)}} : {})};
}

export function bandRGBA(image, y0, y1) {
  const {width} = image, stride = image.components[0].stride;
  const [by0, by1] = reconstructionRows(image, y0, y1);
  const skip = (y0 - by0 * 8) * width, count = (y1 - y0) * width;
  const made = rebuildPicture(subImage(image, 0, by0, stride, by1), {views: true, sliceFrom: skip, sliceCount: count});
  return made.sliced ? made.rgba : made.rgba.subarray(skip * 4, (skip + count) * 4);
}

export function bandedRGBA(image, rows = 512, convert = toRGBAInto, from = 0, to = image.height) {
  const {width, height} = image, stride = image.components[0].stride, end = Math.min(height, to);
  const out = new Uint8ClampedArray(width * (end - from) * 4), decoded = convert === toRGBAInto && rebuildable(image);
  for (let y0 = from; y0 < end; y0 += rows) {
    const y1 = Math.min(height, y0 + rows);
    if (decoded) { out.set(bandRGBA(image, y0, y1), (y0 - from) * width * 4); continue; }
    const [by0, by1] = reconstructionRows(image, y0, y1);
    convert(reconstruct(subImage(image, 0, by0, stride, by1)), (y0 - by0 * 8) * width, (y1 - y0) * width, out, (y0 - from) * width);
  }
  return out;
}

export function bandedOutputs(image, rows, native, sink = null, from = 0, to = image.height, into = null, whole = null) {
  const {width, height} = image, stride = image.components[0].stride;
  if (into) {
    const end = Math.min(height, to), bytes = width * (end - from) * 4;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || end !== Math.min(height, from + rows))
      throw fault('JXL_INTERNAL', 'photo-reconstruct-bands:band');
    if (!(into.package instanceof Uint8Array) || !(into.native instanceof Uint8Array) ||
        into.package.length !== bytes || into.native.length !== bytes || into.package.buffer === into.native.buffer)
      throw fault('JXL_INTERNAL', 'photo-reconstruct-bands:into');
  }
  const band = !!sink || !!into;
  const pack = band ? null : whole?.[0] ?? new Uint8ClampedArray(width * height * 4), own = band ? null : whole?.[1] ?? new Uint8ClampedArray(width * height * 4), decoded = rebuildable(image);
  for (let y0 = from; y0 < Math.min(height, to); y0 += rows) {
    const y1 = Math.min(height, y0 + rows), [by0, by1] = reconstructionRows(image, y0, y1);
    const sub = into && decoded && image.lazyStrategy && by0 === 0 && by1 === image.components[0].rows
      ? image.lazyStrategy.rows(by0, by1, true) : subImage(image, 0, by0, stride, by1);
    const from = (y0 - by0 * 8) * width, count = (y1 - y0) * width;
    const bandPack = into?.package ?? (sink ? bandScratch(Uint8ClampedArray, 'band-package', count * 4) : pack),
      bandOwn = into?.native ?? (sink ? bandScratch(Uint8ClampedArray, 'band-native', count * 4) : own);
    const at = band ? 0 : y0 * width;
    if (decoded) {
      const made = rebuildPicture(sub, {rgba: true, linear: true, views: true, sliceFrom: from, sliceCount: count});
      bandPack.set(made.sliced ? made.rgba : made.rgba.subarray(from * 4, (from + count) * 4), at * 4);
      native(made.linear, made.sliced ? 0 : from, count, bandOwn, at, y0);
    } else {
      const linear = reconstruct(sub);
      toRGBAInto(linear, from, count, bandPack, at);
      native(linear, from, count, bandOwn, at, y0);
    }
    sink?.(y0, y1 - y0, bandPack, bandOwn);
  }
  return sink ? null : into ?? {package: pack, native: own};
}

export function exactScores(cpu, reference, width, height, image, want = {}, memory = cpu.memory ?? null) {
  const plan = memory ?? memoryPlan(width * height, {width, height});
  if (!plan.banded) return cpu(image, want);
  if (typeof cpu.banded !== 'function') throw fault('JXL_INPUT', 'cpu.banded: function');
  return cpu.banded(image, want);
}