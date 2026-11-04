// SPDX-License-Identifier: MIT
import {photoEngine, tokenArenaEnd} from './capture-kernels.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {fusedFrameRows} from './capture-fused.mjs';
import {rgbCoefficientSteps} from './photo-dct.mjs';
import {complete} from './bits.mjs';

const GROUP_PLANES = 3 * 131072;

export function groupPass(data, width, dx, dy, boxes, fw, fh, {quality, colorSpace, areas, limit, ac = null}, contexts, density, scan) {
  const engine = photoEngine();
  if (!engine) return null;
  const {simd, memory, P, R} = engine, top = Math.min(limit ?? engine.limit, engine.limit), stride = Math.ceil(fw / 8), w8 = stride * 8, groupsX = Math.ceil(fw / 256);
  const planes = tokenArenaEnd(contexts) + 65535 & ~65535, rowsAt = planes + groupsX * GROUP_PLANES;
  const arena = {memory, base: rowsAt, limit: engine.limit, grow: end => engine.grow(end)};
  const rows = fusedFrameRows(data, width, dx, dy, boxes, 256, arena, w8);
  if (!rows) return null;
  const rowsEnd = rowsAt + 16 * boxes.length + width + 16 + w8 * 256 * 4 + 15 & ~15, dcAt = rowsEnd, cache = dcAt + 3 * 32 * stride * 2 + 7 & ~7;
  if (cache > top) return null;
  engine.grow(cache);
  const kept = [];
  let at = cache, refused = false, spilled = 0;
  const view = () => { const b = memory.buffer; return {u8: new Uint8Array(b), i16: new Int16Array(b), u16: new Uint16Array(b), i32: new Int32Array(b), f64: new Float64Array(b)}; };
  const basisAt = basis => {
    const {f64} = view(), pair = R + 512;
    f64.set(basis, R >> 3);
    for (let u = 0; u < 8; u += 2) for (let x = 0; x < 8; x++) { f64[(pair >> 3) + u * 8 + x * 2] = basis[u * 8 + x]; f64[(pair >> 3) + u * 8 + x * 2 + 1] = basis[(u + 1) * 8 + x]; }
    return pair;
  };
  const tiles = (rowsView, w, h, bx0, by0, bw, bh, tableOf, cflOf, unused, s, basis, quantScale) => {
    const SCRATCH = P + 98304, SRC = SCRATCH + 512, OUT = SRC + 16384, SUMS = OUT + 24576, TABS = SUMS + 32, TABLES = TABS + 256;
    const {u8, i32, f64} = view(), count = bw * bh, slots = new Map();
    for (let n = 0; n < count; n++) {
      const t = tableOf(by0 + (n / bw | 0), bx0 + n % bw);
      let a = slots.get(t);
      if (a === undefined) {
        a = TABLES + slots.size * 3072;
        if (a + 3072 > R || t.length !== 384) { refused = true; return false; }
        f64.set(t, a >> 3); slots.set(t, a);
      }
      i32[(TABS >> 2) + n] = a;
    }
    simd.rgbTile(rowsView.byteOffset + by0 * 8 * w * 4 + bx0 * 32, w * 4, bw, bh, P, R, basisAt(basis), SCRATCH, TABS, OUT, quantScale, SUMS);
    const [ax, ab] = cflOf(f64[SUMS >> 3], f64[(SUMS >> 3) + 1], f64[(SUMS >> 3) + 2]);
    simd.rgbQuant(P, count, TABS, ax, ab, OUT, quantScale);
    const gx = bx0 >> 5, gw = Math.min(32, stride - gx * 32), group = planes + gx * GROUP_PLANES;
    for (let c = 0; c < 3; c++) for (let y = 0; y < bh; y++) {
      const from = OUT + (c * count + y * bw) * 128, to = group + c * 131072 + (((by0 + y) & 31) * gw + (bx0 & 31)) * 128;
      u8.copyWithin(to, from, from + bw * 128);
    }
    return true;
  };
  const close = (gx, bh, dcBand) => {
    const bw = Math.min(32, stride - gx * 32), coeff = planes + gx * GROUP_PLANES;
    const args = P, counts = P + 128 + 393216, buckets = counts + 3072, ctxAt = buckets + 1024;
    const orders = ctxAt + 64, zd = orders + 192, nz = zd + 8192, values = nz + 12288, ids = values + 786432;
    let v = view();
    for (let c = 0; c < 3; c++) {
      const plane = coeff + c * 131072;
      for (let y = 0; y < bh; y++) simd.captureSelect(plane + y * bw * 128, dcAt + (c * 32 * stride + y * stride + gx * 32) * 2, bw, 128, 1);
      simd.captureSelect(plane, counts + c * bw * bh, bw * bh, 128, 3);
      v.u8.set(scan, orders + c * 64);
    }
    v.u8.fill(0, buckets, buckets + 1024); v.u16.set(density, zd >> 1);
    if (ac && ac.K > 1) {
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) v.u8[buckets + y * bw + x] = ac.bucket(v.i16[(dcAt >> 1) + 32 * stride + y * stride + gx * 32 + x]);
      v.i32.set(ac.table, ctxAt >> 2);
    } else v.i32.set([1, 0, 2], ctxAt >> 2);
    v.i32.set([coeff, 131072, bw, bh, counts, buckets, ctxAt, ac ? ac.K : 1, ac ? ac.numCtxs : 3, orders, zd, nz, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, values, ids, 0], args >> 2);
    simd.acGroup(args);
    const n = v.i32[(args >> 2) + 28], bytes = n * 6 + 3 & ~3;
    if (at + bytes <= top) {
      engine.grow(at + bytes); v = view();
      v.u8.copyWithin(at, values, values + n * 4); v.u8.copyWithin(at + n * 4, ids, ids + n * 2);
      kept.push({n, values: at, ctxs: at + n * 4}); at += bytes;
    } else if (spilled + n * 6 <= pass.keep) {
      kept.push({n, out: {values: new Uint32Array(memory.buffer, values, n).slice(), ctxs: new Uint16Array(memory.buffer, ids, n).slice()}}); spilled += n * 6;
    } else {
      pass.drop(new Uint16Array(memory.buffer, ids, n), new Uint32Array(memory.buffer, values, n), n);
      kept.push({n, dropped: true});
    }
    void dcBand;
  };
  const tokens = g => {
    const k = kept[g];
    if (k.dropped) return null;
    return k.out ? {n: k.n, values: k.out.values, ctxs: k.out.ctxs} : {n: k.n, values: new Uint32Array(memory.buffer, k.values, k.n), ctxs: new Uint16Array(memory.buffer, k.ctxs, k.n)};
  };
  const pass = {
    keep: Infinity, drop: () => { throw new RangeError('A group past keep needs the writer\'s tally.'); },
    get spilled() { return spilled; },
    tokens,
    band(b) {
      const y = b * 256, count = Math.min(256, fh - y), padded = Math.ceil(count / 8) * 8;
      let band = rows(y, count);
      if (padded > count) {
        engine.grow(band.byteOffset + w8 * 4 * padded);
        const {u8} = view(), last = band.byteOffset + (count - 1) * w8 * 4;
        for (let r = count; r < padded; r++) u8.copyWithin(band.byteOffset + r * w8 * 4, last, last + w8 * 4);
      }
      band = new Uint8Array(memory.buffer, band.byteOffset, w8 * 4 * padded);
      const before = kernelHooks.rgbTiles;
      kernelHooks.rgbTiles = tiles;
      let image;
      refused = false;
      try { image = complete(rgbCoefficientSteps(band, w8, count, quality, colorSpace, areas && areas.map(a => ({...a, y: a.y - y})))); }
      finally { kernelHooks.rgbTiles = before; }
      ac?.fix(image.components[1].quant[0], image.quantScale);
      const bh = Math.ceil(count / 8), first = kept.length;
      if (refused) {
        const {i16} = view();
        for (let c = 0; c < 3; c++) {
          const levels = image.components[c].coeffs;
          for (let by = 0; by < bh; by++) for (let bx = 0; bx < stride; bx++) {
            const gx = bx >> 5, gw = Math.min(32, stride - gx * 32), to = planes + gx * GROUP_PLANES + c * 131072 + ((by & 31) * gw + (bx & 31)) * 128;
            i16.set(levels.subarray((by * stride + bx) * 64, (by * stride + bx) * 64 + 64), to >> 1);
          }
        }
      }
      for (let gx = 0; gx < groupsX; gx++) close(gx, bh);
      const {i16} = view(), dc = [0, 1, 2].map(c => {
        const out = new Int16Array(bh * stride);
        for (let r = 0; r < bh; r++) out.set(i16.subarray((dcAt >> 1) + c * 32 * stride + r * stride, (dcAt >> 1) + c * 32 * stride + r * stride + stride), r * stride);
        return out;
      });
      return {image, dc, groups: Array.from({length: groupsX}, (_, g) => tokens(first + g))};
    },
  };
  return pass;
}
