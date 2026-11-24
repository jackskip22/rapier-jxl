// SPDX-License-Identifier: MIT
import {TRANSFORMS, naturalOrder} from './vardct-strategies.mjs';
import {COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {seedLearnedOrderCounts} from './varblock-write.mjs';
import {offloading, offloadWorkers} from './offload.mjs';
import {journaling} from './step-journal.mjs';
import {scoreBandCapacity} from './photo-band-storage.mjs';

let scratch = /* @__PURE__ */ new Uint8Array(1 << 16), compactGrid = /* @__PURE__ */ new Int32Array(0), compactList = /* @__PURE__ */ new Int32Array(1024);
function packPlane(bytes, at, plane, off, size, put) {
  const mark = at++;
  let n = 0;
  for (let k = 0, last = 0; k < size; k++) {
    const v = plane[off + k];
    if (v === 0) continue;
    const gap = k - last; last = k + 1;
    const u = (v << 1 ^ v >> 31) >>> 0;
    if (gap < 0x80 && u < 0x80) { bytes[at] = gap; bytes[at + 1] = u; at += 2; }
    else { at = put(at, gap); at = put(at, u); }
    n++;
  }
  if (n < 0x80) bytes[mark] = n;
  else {
    let width = 1;
    for (let v = n; v >= 0x80; v >>>= 7) width++;
    bytes.copyWithin(mark + width, mark + 1, at); at += width - 1;
    for (let i = mark, v = n; i < mark + width; i++, v >>>= 7) bytes[i] = i < mark + width - 1 ? v & 0x7f | 0x80 : v;
  }
  return at;
}
const putVarint = bytes => (at, v) => {
  if (v < 0x80) { bytes[at++] = v; return at; }
  while (v >= 0x80) { bytes[at++] = v & 0x7f | 0x80; v >>>= 7; }
  bytes[at++] = v;
  return at;
};
function packGroup(blocks, rowOffset = 0) {
  let need = 8, total = 0;
  for (const {size} of blocks) { need += 18 + 3 * size * 10; total += 3 * size; }
  if (scratch.length < need) scratch = new Uint8Array(need);
  const bytes = scratch, put = putVarint(bytes);
  let at = 0;
  at = put(at, blocks.length); at = put(at, total);
  for (const {id, bx, by, size, coeffs} of blocks) {
    at = put(at, id); at = put(at, bx); at = put(at, by + rowOffset);
    for (let c = 0; c < 3; c++) at = packPlane(bytes, at, coeffs[c], 0, size, put);
  }
  return bytes.slice(0, at);
}

function packCompactRow(band, gy, rowOffset = 0) {
  const comps = band.components, stride = comps[0].stride, rows = comps[0].rows, groupsX = Math.ceil(stride / 32), sd = band.strategyData;
  const {meta, levels, by0, packed = null} = sd.compact, y0 = gy * 32, y1 = Math.min(rows, y0 + 32), span = y1 - y0;
  if (compactGrid.length < span * stride) compactGrid = new Int32Array(span * stride);
  compactGrid.fill(-1, 0, span * stride);
  for (let p = 0; p < meta.length; p += 6) {
    const by = by0 + meta[p + 2];
    if (by >= y0 && by < y1) compactGrid[(by - y0) * stride + meta[p + 1]] = p;
  }
  const groups = new Array(groupsX);
  for (let gx = 0; gx < groupsX; gx++) {
    const x0 = gx * 32, x1 = Math.min(stride, x0 + 32);
    let count = 0, total = 0;
    for (let r = 0; r < span; r++) {
      const rOff = r * stride;
      for (let bx = x0; bx < x1; bx++) {
        const p = compactGrid[rOff + bx];
        if (p < 0) continue;
        if (count >= compactList.length) { const next = new Int32Array(compactList.length * 2); next.set(compactList); compactList = next; }
        compactList[count++] = p;
        total += 3 * meta[p + 3] * meta[p + 4] * 64;
      }
    }
    const need = 8 + count * 18 + total * 10;
    if (scratch.length < need) scratch = new Uint8Array(need);
    const bytes = scratch, put = putVarint(bytes);
    let at = 0;
    at = put(at, count); at = put(at, total);
    for (let i = 0; i < count; i++) {
      const p = compactList[i], id = meta[p], bx = meta[p + 1], by = rowOffset + by0 + meta[p + 2], size = meta[p + 3] * meta[p + 4] * 64, lOff = meta[p + 5];
      at = put(at, id); at = put(at, bx); at = put(at, by);
      const from = packed ? packed.start[p / 6] : -1;
      if (from >= 0) { const len = packed.len[p / 6]; bytes.set(packed.bytes.subarray(from, from + len), at); at += len; continue; }
      at = packPlane(bytes, at, levels, lOff, size, put);
      at = packPlane(bytes, at, levels, lOff + size, size, put);
      at = packPlane(bytes, at, levels, lOff + 2 * size, size, put);
    }
    groups[gx] = bytes.slice(0, at);
  }
  const dcRow0 = comps[0].dcRow0 ?? 0, dcFrom = (y0 - dcRow0) * stride, dcTo = (y1 - dcRow0) * stride;
  const {strategyData: _s, components: _c, ...fields} = band;
  return {groups, dc: comps.map(c => c.dc.slice(dcFrom, dcTo)), tables: sd.tables, wide: !!band.wideCoefficients, fields, components: comps.map(({dc: _d, dcRow0: _r, ...c}) => c)};
}

const NATURAL_ORDERS = /* @__PURE__ */ TRANSFORMS.map(t => naturalOrder(t.width >> 3, t.height >> 3));
const makeBlock = () => ({id: -1, bx: 0, by: 0, bw: 0, bh: 0, area: 0, size: 0, order: null, levels: null, _buf: null, _from: -1, _coeffs: null,
  get coeffs() {
    return this._coeffs ??= [this._buf.subarray(this._from, this._from + this.size),
      this._buf.subarray(this._from + this.size, this._from + 2 * this.size),
      this._buf.subarray(this._from + 2 * this.size, this._from + 3 * this.size)];
  }});
function unpackGroup(bytes, slot = null) {
  let at = 0;
  const get = () => {
    const b0 = bytes[at++];
    if (b0 < 0x80) return b0;
    const b1 = bytes[at++];
    if (b1 < 0x80) return (b0 & 0x7f) | (b1 << 7);
    let v = (b0 & 0x7f) | ((b1 & 0x7f) << 7), shift = 14, b;
    do { b = bytes[at++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  const count = get(), total = get();
  let levels, blocks;
  if (slot) {
    if (slot.levels.length < total) slot.levels = new Int32Array(Math.max(total, 3 * 65536));
    else slot.levels.fill(0, 0, total);
    levels = slot.levels;
    blocks = slot.arrays.get(count);
    if (!blocks) slot.arrays.set(count, blocks = new Array(count));
  } else {
    levels = new Int32Array(total);
    blocks = new Array(count);
  }
  const pool = slot?.pool;
  let meta = slot?.meta;
  if (!meta || meta.length < count * 7) { meta = new Int32Array(Math.max(count * 7, 7 * 1024)); if (slot) slot.meta = meta; }
  for (let i = 0, from = 0; i < count; i++) {
    const id = get(), bx = get(), by = get(), t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3, area = bw * bh, size = area * 64;
    const m = i * 7;
    meta[m] = id; meta[m + 1] = bx; meta[m + 2] = by; meta[m + 3] = bw; meta[m + 4] = bh; meta[m + 5] = area; meta[m + 6] = size;
    for (let c = 0; c < 3; c++) {
      let k = from + c * size;
      for (let n = get(); n > 0; n--) {
        const g0 = bytes[at++];
        k += g0 < 0x80 ? g0 : (at--, get());
        const u0 = bytes[at++], u = u0 < 0x80 ? u0 : (at--, get());
        levels[k++] = u >>> 1 ^ -(u & 1);
      }
    }
    if (pool) {
      let b = pool[i];
      if (!b) b = pool[i] = makeBlock();
      if (b._buf !== levels || b._from !== from || b.size !== size) {
        b.levels = levels.subarray(from, from + 3 * size);
        b._buf = levels; b._from = from; b._coeffs = null;
      }
      b.id = id; b.bx = bx; b.by = by; b.bw = bw; b.bh = bh; b.area = area; b.size = size; b.order = NATURAL_ORDERS[id];
      blocks[i] = b;
    } else {
      blocks[i] = {id, bx, by, bw, bh, area, size, order: NATURAL_ORDERS[id], levels: levels.subarray(from, from + 3 * size),
        coeffs: [levels.subarray(from, from + size), levels.subarray(from + size, from + 2 * size), levels.subarray(from + 2 * size, from + 3 * size)]};
    }
    from += 3 * size;
  }
  blocks._meta = meta.subarray(0, count * 7); blocks._slab = levels.subarray(0, total); blocks._orders = NATURAL_ORDERS;
  return blocks;
}

export function packRow(band, gy, rowOffset = 0) {
  const sd = band.strategyData;
  if (sd.compact) return packCompactRow(band, gy, rowOffset);
  const comps = band.components, stride = comps[0].stride, rows = comps[0].rows, groupsX = Math.ceil(stride / 32);
  const dcRow0 = comps[0].dcRow0 ?? 0, from = (gy * 32 - dcRow0) * stride, to = (Math.min(rows, gy * 32 + 32) - dcRow0) * stride, groups = [];
  for (let gx = 0; gx < groupsX; gx++) groups.push(packGroup(sd.groups[gy * groupsX + gx], rowOffset));
  const {strategyData: _s, components: _c, ...fields} = band;
  return {groups, dc: comps.map(c => c.dc.slice(from, to)), tables: sd.tables, wide: !!band.wideCoefficients, fields, components: comps.map(({dc: _d, dcRow0: _r, ...c}) => c)};
}
export function packRows(band, by0, by1, packed) {
  const rows = band.components[0].rows;
  for (let gy = Math.ceil(by0 / 32); gy * 32 < Math.min(rows, by1); gy++)
    if (!packed[gy] && Math.min(rows, gy * 32 + 32) <= by1) packed[gy] = packRow(band, gy);
}

const BUCKET = /* @__PURE__ */ TRANSFORMS.map(t => COEFFICIENT_ORDER_BUCKETS.find(b => b.strategies.includes(t.name)));
const RANKS = /* @__PURE__ */ TRANSFORMS.map(t => { const order = naturalOrder(t.width >> 3, t.height >> 3), out = new Int32Array(order.length); for (let k = 0; k < order.length; k++) out[order[k]] = k; return out; });
const PACKED_OF = new WeakMap();
export function* packedPictureSteps(image, bandRecipe) {
  const lazyKey = image?.lazyStrategy;
  if (lazyKey && PACKED_OF.has(lazyKey)) return PACKED_OF.get(lazyKey);
  const comps = image.components, rows = comps[0].rows, groupsY = Math.ceil(rows / 32);
  const srcRgba = image.recipe?.base?.sourceRgba, shared = typeof SharedArrayBuffer === 'function' && image.recipe?.base?.planes?.[0]?.buffer instanceof SharedArrayBuffer;
  if (!journaling() && offloading('score-band') && offloadWorkers() >= 2 && groupsY >= 2 && image.recipe && !image.recipe.base?.alpha && !image.recipe.gaborish?.transform && (srcRgba || shared)) {
    const held = image.lazyStrategy.packed ?? (image.lazyStrategy.packed = []);
    const missing = [];
    for (let gy = 0; gy < groupsY; gy++) if (!held[gy]) missing.push(gy);
    if (missing.length >= 2) {
      const {width, height} = image, {sourceBytes, inputBytes} = scoreBandCapacity(width, height, false);
      const ahead = Math.min(missing.length, offloadWorkers()), free = Array.from({length: ahead}, () => new ArrayBuffer(inputBytes));
      const tasks = new Map(), look = {};
      const makeTask = idx => {
        const gy = missing[idx], y0 = gy * 256, y1 = Math.min(height, y0 + 256), input = free.pop();
        let at = shared ? 0 : sourceBytes;
        const alloc = (Type, len) => {
          const sz = Type.BYTES_PER_ELEMENT;
          at = Math.ceil(at / sz) * sz;
          const out = new Type(input, at, len); at += len * sz;
          return out;
        };
        const built = bandRecipe(image.recipe, y0, y1, alloc, 0);
        const top = Math.max(0, y0 - 96), end = Math.min(height, y0 + 384);
        const needRows = !built.sharedPlanes;
        const rowsBuf = new Uint8Array(input, 0, needRows ? (end - top) * width * 4 : 0);
        if (needRows) rowsBuf.set(srcRgba.subarray(top * width * 4, end * width * 4));
        const task = {kind: 'pack-band', look, input, inputBytes, rows: rowsBuf, recipe: built, top, width, height, gy};
        tasks.set(idx, task);
        return task;
      };
      const {planeRows: _r, devicePlanes: _d, planes: _p, dctPack: _dp, ...baseFields} = image;
      const baseComps = comps.map(({dc: _dc, dcRow0: _dr, ...c}) => ({...c, rows}));
      try {
        yield {offload: 'prefetch', tasks: Array.from({length: ahead}, (_, i) => makeTask(i))};
        for (let i = 0; i < missing.length; i++) {
          const task = tasks.get(i) ?? makeTask(i);
          tasks.delete(i);
          const reply = yield {offload: 'run', task};
          if (reply?.packed?.groups && reply.input instanceof ArrayBuffer && reply.input.byteLength === inputBytes) {
            free.push(reply.input);
            held[task.gy] = {...reply.packed, fields: {...baseFields, ...(reply.packed.perceptual && {perceptual: true})}, components: baseComps};
          } else {
            free.push(task.input.byteLength === inputBytes ? task.input : new ArrayBuffer(inputBytes));
          }
          if (reply && i + ahead < missing.length) yield {offload: 'prefetch', tasks: [makeTask(i + ahead)]};
        }
      } finally { free.length = 0; tasks.clear(); }
    }
  }
  return packedPicture(image);
}
export function packedPicture(image) {
  const lazyKey = image?.lazyStrategy;
  if (lazyKey && PACKED_OF.has(lazyKey)) return PACKED_OF.get(lazyKey);
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, groupsY = Math.ceil(rows / 32);
  const dc = comps.map(() => new Int32Array(stride * rows)), at = new Int32Array(stride * rows).fill(-1), held = image.lazyStrategy.packed;
  const packed = [], records = [], tables = new Array(17).fill(null), counts = new Array(COEFFICIENT_ORDER_BUCKETS.length);
  let top = null, wide = false;
  for (let gy = 0; gy < groupsY; gy++) {
    let row = held?.[gy];
    if (!row) { const band = image.lazyStrategy.rows(gy * 32, gy * 32 + 32, true); row = held?.[gy] ?? packRow(band, gy); }
    top ??= row;
    wide ||= row.wide;
    for (let c = 0; c < dc.length; c++) dc[c].set(row.dc[c], gy * 32 * stride);
    row.tables.forEach((table, family) => { if (table && !tables[family]) tables[family] = table; });
    for (const bytes of row.groups) {
      packed.push(bytes);
      let k = 0;
      const get = () => { let b = bytes[k++]; if (b < 0x80) return b; let v = b & 0x7f, shift = 7; do { b = bytes[k++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; };
      const count = get();
      get();
      for (let n = count; n > 0; n--) {
        const id = get(), bx = get(), by = get(), t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3, area = bw * bh, size = area * 64;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) at[(by + y) * stride + bx + x] = -2;
        at[by * stride + bx] = records.length;
        const record = {id, bx, by, bw, bh, area, size, lumaAC: false};
        records.push(record);
        const bucket = BUCKET[id], ranks = RANKS[id], counted = bucket && bucket.id !== 1;
        let c3 = counted ? counts[bucket.id] : null;
        if (counted && !c3) counts[bucket.id] = c3 = [new Uint32Array(size), new Uint32Array(size), new Uint32Array(size)];
        for (let c = 0; c < 3; c++) for (let m = get(), place = 0; m > 0; m--) {
          if (c === 1) record.lumaAC = true;
          const g0 = bytes[k++];
          place += g0 < 0x80 ? g0 : (k--, get());
          const u0 = bytes[k++];
          if (u0 >= 0x80) { k--; get(); }
          if (c3) { const rank = ranks[place]; if (rank >= area) c3[c][rank]++; }
          place++;
        }
      }
    }
  }
  const slots = Array.from({length: 4}, () => ({levels: new Int32Array(0), pool: [], arrays: new Map()}));
  const kept = new Map(), group = g => {
    let entry = kept.get(g);
    if (!entry) {
      let slot;
      if (kept.size >= 4) { const first = kept.keys().next().value; slot = kept.get(first).slot; kept.delete(first); }
      else slot = slots[kept.size];
      entry = {blocks: unpackGroup(packed[g], slot), slot};
      kept.set(g, entry);
    }
    return entry.blocks;
  };
  const groups = new Array(packed.length);
  for (let g = 0; g < packed.length; g++) Object.defineProperty(groups, g, {get: () => group(g), enumerable: true});
  const picture = {...top.fields, components: top.components.map((c, i) => ({...c, dc: dc[i]})), wideCoefficients: wide,
    strategyData: {groups, blocks: records, at, tables, stride, packed: true}};
  seedLearnedOrderCounts(picture, counts);
  if (lazyKey) PACKED_OF.set(lazyKey, picture);
  return picture;
}
