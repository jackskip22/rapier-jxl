// SPDX-License-Identifier: MIT
import {TRANSFORMS, naturalOrder} from './vardct-strategies.mjs';
import {COEFFICIENT_ORDER_BUCKETS} from './coefficient-orders.mjs';
import {seedLearnedOrderCounts} from './varblock-write.mjs';

let scratch = new Uint8Array(1 << 16);
function packGroup(blocks) {
  let need = 8;
  for (const {size} of blocks) need += 18 + 3 * size * 10;
  if (scratch.length < need) scratch = new Uint8Array(need);
  const bytes = scratch;
  let at = 0, total = 0;
  const put = v => { if (v < 0x80) { bytes[at++] = v; return; } while (v >= 0x80) { bytes[at++] = v & 0x7f | 0x80; v >>>= 7; } bytes[at++] = v; };
  for (const {size} of blocks) total += 3 * size;
  put(blocks.length); put(total);
  for (const {id, bx, by, size, coeffs} of blocks) {
    put(id); put(bx); put(by);
    for (let c = 0; c < 3; c++) {
      const plane = coeffs[c];
      const mark = at++;
      let n = 0;
      for (let k = 0, last = 0; k < size; k++) {
        const v = plane[k];
        if (v === 0) continue;
        put(k - last); last = k + 1;
        put((v << 1 ^ v >> 31) >>> 0);
        n++;
      }
      if (n < 0x80) bytes[mark] = n;
      else {
        let width = 1;
        for (let v = n; v >= 0x80; v >>>= 7) width++;
        bytes.copyWithin(mark + width, mark + 1, at); at += width - 1;
        for (let i = mark, v = n; i < mark + width; i++, v >>>= 7) bytes[i] = i < mark + width - 1 ? v & 0x7f | 0x80 : v;
      }
    }
  }
  return bytes.slice(0, at);
}

function unpackGroup(bytes) {
  let at = 0;
  const get = () => { let b = bytes[at++]; if (b < 0x80) return b; let v = b & 0x7f, shift = 7; do { b = bytes[at++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; };
  const count = get(), total = get(), blocks = new Array(count), levels = new Int32Array(total);
  for (let i = 0, from = 0; i < count; i++) {
    const id = get(), bx = get(), by = get(), t = TRANSFORMS[id], bw = t.width >> 3, bh = t.height >> 3, area = bw * bh, size = area * 64;
    const coeffs = [levels.subarray(from, from + size), levels.subarray(from + size, from + 2 * size), levels.subarray(from + 2 * size, from + 3 * size)];
    for (let c = 0; c < 3; c++) {
      let k = from + c * size;
      for (let n = get(); n > 0; n--) { k += get(); const u = get(); levels[k++] = u >>> 1 ^ -(u & 1); }
    }
    from += 3 * size;
    blocks[i] = {id, bx, by, bw, bh, area, size, order: naturalOrder(bw, bh), coeffs};
  }
  return blocks;
}

function packRow(band, gy) {
  const comps = band.components, stride = comps[0].stride, rows = comps[0].rows, groupsX = Math.ceil(stride / 32), sd = band.strategyData;
  const from = gy * 32 * stride, to = Math.min(rows, gy * 32 + 32) * stride, groups = [];
  for (let gx = 0; gx < groupsX; gx++) groups.push(packGroup(sd.groups[gy * groupsX + gx]));
  const {strategyData: _s, components: _c, ...fields} = band;
  return {groups, dc: comps.map(c => c.dc.slice(from, to)), tables: sd.tables, wide: !!band.wideCoefficients, fields, components: comps.map(({dc: _d, ...c}) => c)};
}
export function packRows(band, by0, by1, packed) {
  const rows = band.components[0].rows;
  for (let gy = Math.ceil(by0 / 32); gy * 32 < Math.min(rows, by1); gy++)
    if (!packed[gy] && Math.min(rows, gy * 32 + 32) <= by1) packed[gy] = packRow(band, gy);
}

const BUCKET = TRANSFORMS.map(t => COEFFICIENT_ORDER_BUCKETS.find(b => b.strategies.includes(t.name)));
const RANKS = TRANSFORMS.map(t => { const order = naturalOrder(t.width >> 3, t.height >> 3), out = new Int32Array(order.length); for (let k = 0; k < order.length; k++) out[order[k]] = k; return out; });
export function packedPicture(image) {
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, groupsY = Math.ceil(rows / 32);
  const dc = comps.map(() => new Int32Array(stride * rows)), at = new Int32Array(stride * rows).fill(-1), held = image.lazyStrategy.packed;
  const packed = [], records = [], tables = new Array(17).fill(null), counts = new Array(COEFFICIENT_ORDER_BUCKETS.length);
  let top = null, wide = false;
  for (let gy = 0; gy < groupsY; gy++) {
    const row = held?.[gy] ?? packRow(image.lazyStrategy.rows(gy * 32, gy * 32 + 32), gy);
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
        records.push({id, bx, by, bw, bh, area, size});
        const bucket = BUCKET[id], ranks = RANKS[id], counted = bucket && bucket.id !== 1;
        let c3 = counted ? counts[bucket.id] : null;
        if (counted && !c3) counts[bucket.id] = c3 = [new Uint32Array(size), new Uint32Array(size), new Uint32Array(size)];
        for (let c = 0; c < 3; c++) for (let m = get(), place = 0; m > 0; m--) {
          place += get(); get();
          if (c3) { const rank = ranks[place]; if (rank >= area) c3[c][rank]++; }
          place++;
        }
      }
    }
  }
  const kept = new Map(), group = g => {
    let blocks = kept.get(g);
    if (!blocks) { blocks = unpackGroup(packed[g]); if (kept.size >= 2) kept.delete(kept.keys().next().value); kept.set(g, blocks); }
    return blocks;
  };
  const groups = new Proxy(new Array(packed.length), {get: (list, key) => typeof key === 'string' && /^\d+$/.test(key) ? group(+key) : list[key]});
  const picture = {...top.fields, components: top.components.map((c, i) => ({...c, dc: dc[i]})), wideCoefficients: wide,
    strategyData: {groups, blocks: records, at, tables, stride, packed: true}};
  seedLearnedOrderCounts(picture, counts);
  return picture;
}
