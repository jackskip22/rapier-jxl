// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {fixedStrategyImage} from './varblock-core.mjs';
import {packRows} from './photo-packed-picture.mjs';
import {timed} from './stage-trace.mjs';

const pack = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : packRows;

export function layoutPicture(base, width, height, layout, options, keep = true, storage = null) {
  const {planeRows: _r, devicePlanes: _d, planes: _p, ...fields} = base;
  const stride = base.components[0].stride, built = new Map(), packed = keep ? [] : null;
  const rates = options.rated ? new Float64Array(stride * base.components[0].rows) : null;
  let byRow = null, made = [0, 0];
  const rows = (by0, by1) => {
    for (const key of built.keys()) if (((key % 16777216) / stride | 0) < by0) built.delete(key);
    if (!byRow) { byRow = Array.from({length: base.components[0].rows}, () => []); for (const entry of layout) byRow[entry.by].push(entry); }
    const end = Math.min(byRow.length, by1), from = by0 >= made[0] && by0 < made[1] ? made[1] : by0;
    if (from < end) base.planeRows?.(from * 8, end * 8);
    made = [by0, Math.max(end, from)];
    const entries = [];
    for (let by = by0; by < Math.min(by1, byRow.length); by++) entries.push(...byRow[by]);
    const image = fixedStrategyImage(base, width, height, {...options, ...(rates && {ratesOut: rates}), layout: entries, built}, storage).image;
    if (packed && pack) pack(image, by0, by1, packed);
    return image;
  };
  let whole = null;
  return {...fields, width, height, components: base.components, layout, ...(rates && {rates}),
    lazyStrategy: {rows, packed,
      hold: exact => { whole = timed('materialize:device-levels', () => fixedStrategyImage(base, width, height, {...options, layout, exact}, storage).image); },
      materialize: () => { const made = whole; whole = null; return made ?? timed('materialize', () => fixedStrategyImage(base, width, height, {...options, layout}, storage).image); }}};
}

export function scoreBandPicture(base, width, height, layout, options) {
  const fixed = {...base, components: base.components.map(c => ({...c, coeffs: new Int16Array(0)}))};
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
  'lambda', 'weights', 'detailWeight', 'inhom', 'lowScale'];
const fixedOptions = (options, allocate, seen) => Object.fromEntries(FIXED_OPTIONS.filter(key => options[key] !== undefined).map(key => [key, owned(options[key], allocate, seen)]));

export function bandRecipe(recipe, y0, y1, allocate = allocated) {
  const source = recipe.base, stride = source.components[0].stride, seen = new Map();
  const at = Math.max(0, Math.floor((y0 - 8) / 64) * 64), by1 = Math.min(source.components[0].rows, Math.ceil((y1 + 8) / 64) * 8);
  const origin = by1 - at / 8 < 8 ? Math.max(0, at - 64) : at, by0 = origin / 8, rows = by1 - by0;
  const base = {width: source.width, height: Math.min(source.height, by1 * 8) - origin,
    components: source.components.map(c => ({h: c.h, v: c.v, stride, rows, quant: owned(c.quant, allocate), coeffs: allocate(Int16Array, 0)})),
    quantScale: source.quantScale, epf: source.epf, xyb: source.xyb, ycbcr: source.ycbcr,
    orientation: source.orientation, colorSpace: source.colorSpace, gab: owned(source.gab, allocate)};
  if (source.epfIterations !== undefined) base.epfIterations = source.epfIterations;
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
  return {base, layout: layout.subarray(0, used), options, gaborish: owned(recipe.gaborish, allocate, seen), origin};
}