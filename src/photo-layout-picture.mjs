// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {reconstructionRows} from './band-geometry.mjs';
import {fixedStrategyImage} from './varblock-core.mjs';
import {packRows} from './photo-packed-picture.mjs';
import {timed} from './stage-trace.mjs';

const pack = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : packRows;

export function layoutPicture(base, width, height, layout, options, keep = true, storage = null) {
  const {planeRows: _r, devicePlanes: _d, planes: _p, dctPack: _dp, ...fields} = base;
  const stride = base.components[0].stride, built = new Map(), packed = keep ? [] : null;
  const rates = options.rated ? new Float64Array(stride * base.components[0].rows) : null;
  let byRow = null, made = [0, 0];
  const rows = (by0, by1, compact = false) => {
    for (const key of built.keys()) if (((key % 16777216) / stride | 0) < by0) built.delete(key);
    if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (const entry of layout) byRow[entry.by].push(entry); }
    const end = Math.min(byRow.length, by1), from = by0 >= made[0] && by0 < made[1] ? made[1] : by0;
    if (from < end && !base.dctPack && !storage) base.planeRows?.(from * 8, end * 8);
    made = [by0, Math.max(end, from)];
    const entries = [];
    for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
    const image = fixedStrategyImage(base, width, height, {...options, ...(rates && {ratesOut: rates}), layout: entries, built, ...(compact && !rates && {compactBy0: by0, compactBy1: by1})}, storage).image;
    if (packed && pack) pack(image, by0, by1, packed);
    return image;
  };
  let whole = null;
  return {...fields, width, height, components: base.components, layout, ...(rates && {rates}),
    lazyStrategy: {rows, packed, held: () => !!whole,
      hold: exact => { whole = timed('materialize:device-levels', () => fixedStrategyImage(base, width, height, {...options, ...(rates && {ratesOut: rates}), layout, exact}, storage).image); },
      materialize: () => { const made = whole; whole = null; return made ?? timed('materialize', () => fixedStrategyImage(base, width, height, {...options, ...(rates && {ratesOut: rates}), layout}, storage).image); }}};
}

export function scoreBandPicture(base, width, height, layout, options) {
  const fixed = {...base, components: base.components.map(c => ({...c, coeffs: new Int16Array(0)}))};
  if (base.sourceRgba) Object.defineProperty(fixed, "sourceRgba", {value: base.sourceRgba, enumerable: false, configurable: true});
  const image = layoutPicture(fixed, width, height, layout, options);
  image.recipe = {base: fixed, layout: packLayout(layout), options, gaborish: fixed.rowsRecipe};
  return image;
}

export const packLayout = layout => { const out = new Int32Array(layout.length * 3); layout.forEach(({id, bx, by}, i) => { out[i * 3] = id; out[i * 3 + 1] = bx; out[i * 3 + 2] = by; }); return out; };
export const unpackLayout = packed => Array.from({length: packed.length / 3}, (_, i) => ({id: packed[i * 3], bx: packed[i * 3 + 1], by: packed[i * 3 + 2]}));

const allocated = (Type, length) => new Type(length);
const owned = (value, allocate, seen = new Map()) => {
  if (ArrayBuffer.isView(value)) {
    let out = seen.get(value);
    if (!out) { out = allocate(value instanceof Uint8Array ? Uint8Array : value.constructor, value.length); out.set(value); seen.set(value, out); }
    return out;
  }
  return Array.isArray(value) ? value.map(entry => owned(entry, allocate, seen))
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, owned(entry, allocate, seen)])) : value;
};
const FIXED_OPTIONS = ['deadzone', 'deadzoneMap', 'compactDct8', 'dct8Bands', 'sizeScale', 'smallScale', 'tableBands', 'perceptual', 'model', 'ids', 'rate',
  'lambda', 'weights', 'detailWeight', 'inhom', 'lowScale', 'gentleChromaDz'];
const fixedOptions = (options, allocate, seen) => Object.fromEntries(FIXED_OPTIONS.filter(key => options[key] !== undefined).map(key => [key, owned(options[key], allocate, seen)]));

export function bandRecipe(recipe, y0, y1, allocate = allocated, margin) {
  const source = recipe.base, stride = source.components[0].stride, seen = new Map();
  const [by0, by1] = margin === 0 ? [y0 / 8, Math.min(source.components[0].rows, Math.ceil(y1 / 8))] : reconstructionRows(source, y0, y1, true), origin = by0 * 8, rows = by1 - by0;
  const base = {width: source.width, height: Math.min(source.height, by1 * 8) - origin,
    components: source.components.map(c => ({h: c.h, v: c.v, stride, rows, quant: owned(c.quant, allocate), coeffs: allocate(Int16Array, 0)})),
    quantScale: source.quantScale, adaptiveLFSmoothing: source.adaptiveLFSmoothing, epf: source.epf, xyb: source.xyb, ycbcr: source.ycbcr,
    orientation: source.orientation, colorSpace: source.colorSpace, gab: owned(source.gab, allocate)};
  for (const [key, value] of Object.entries(source)) if (!(key in base) && (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')) base[key] = value;
  if (source.quantFields) {
    base.quantFields = owned(source.quantFields.subarray(by0 * stride, by1 * stride), allocate);
    base.quantFieldBase = source.quantFieldBase;
  }
  if (source.sharpness) base.sharpness = owned(source.sharpness.subarray(by0 * stride, by1 * stride), allocate);
  if (source.alpha) base.alpha = owned(source.alpha.subarray(origin * source.width * 4, (origin + base.height) * source.width * 4), allocate);
  if (source.cfl) {
    const cfl = source.cfl, from = (by0 / 8) * cfl.width, to = Math.ceil(by1 / 8) * cfl.width;
    base.cfl = {width: cfl.width, x: owned(cfl.x.subarray(from, to), allocate), b: owned(cfl.b.subarray(from, to), allocate)};
  }
  const layout = allocate(Int32Array, 3 * stride * rows);
  let used = 0;
  for (let i = 0; i < recipe.layout.length; i += 3) {
    const by = recipe.layout[i + 2];
    if (by >= by0 && by < by1) {
      if (used + 3 > layout.length) throw fault('JXL_INTERNAL', 'photo-layout-picture:blocks');
      layout[used++] = recipe.layout[i]; layout[used++] = recipe.layout[i + 1]; layout[used++] = by - by0;
    }
  }
  const options = fixedOptions({...recipe.options, deadzoneMap: undefined}, allocate, seen), zones = recipe.options.deadzoneMap;
  if (zones) options.deadzoneMap = owned(zones.subarray(by0 * stride, by1 * stride), allocate);
  let sharedDct = null, sharedPlanes = null;
  const sab = typeof SharedArrayBuffer === 'function';
  if (sab && source.dctPack?.planes?.[0]?.buffer instanceof SharedArrayBuffer) {
    const dp = source.dctPack, rawAt = dp.at.subarray(by0 * stride, by1 * stride);
    let allPacked = true;
    for (let i = 0; i < used; i += 3) if (rawAt[layout[i + 2] * stride + layout[i + 1]] === 0xffffffff) { allPacked = false; break; }
    if (allPacked) {
      const atSlice = owned(rawAt, allocate);
      let lowAtSlice = null, lowsSlice = null;
      if (dp.lowAt && dp.lows) {
        const rawLow = dp.lowAt.subarray(by0 * stride, by1 * stride);
        let minL = 0xffffffff, maxL = 0;
        for (let i = 0; i < rawLow.length; i++) {
          const v = rawLow[i];
          if (v !== 0xffffffff) { if (v < minL) minL = v; if (v > maxL) maxL = v; }
        }
        if (minL !== 0xffffffff) {
          const endL = Math.min(dp.lows.length, maxL + 192);
          lowAtSlice = allocate(Uint32Array, rawLow.length);
          for (let i = 0; i < rawLow.length; i++) lowAtSlice[i] = rawLow[i] === 0xffffffff ? 0xffffffff : rawLow[i] - minL;
          lowsSlice = owned(dp.lows.subarray(minL, endL), allocate);
        }
      }
      sharedDct = {planes: dp.planes, at: atSlice, lowAt: lowAtSlice, lows: lowsSlice};
    }
  } else if (sab && source.planes?.[0]?.buffer instanceof SharedArrayBuffer) {
    const totalRows = source.planes[0].length / (stride * 8);
    const p0 = Math.max(0, origin - 64), p1 = Math.min(totalRows, origin + rows * 8 + 64);
    sharedPlanes = {planes: source.planes.map(p => p.subarray(p0 * stride * 8, p1 * stride * 8)), top: p0 - origin};
  }
  return {base, layout: layout.subarray(0, used), options, gaborish: owned(recipe.gaborish, allocate, seen), origin,
    ...(sharedDct && {sharedDct}), ...(sharedPlanes && {sharedPlanes})};
}