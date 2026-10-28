// SPDX-License-Identifier: MIT
import {JPEG_KERNELS} from './jpeg-kernels-bytes.mjs';
import {hybridToken} from './prefix.mjs';

const ROWS = 524288, BITS = 589824, OWN = 591872, ALIVE = 592128, SCRATCH = 592384;
const VALUES = 1261568, IDS = 2048000, CMAP = 2637824, HISTOGRAMS = 2646016, TABLE_SIZE = 12576, OUT = 5853184;
const FILL = 5853184, FMAP = 5853440, FORDER = 5863680, FDENSITY = 5864448, FBUCKETS = 5880832, FCOUNTS = 5881856;
const FCOEFFS = 5897216, FCTXS = 6290432, FVALUES = 6683648;
const JSCAN = 2637824, JCODES = 2638080, JZIGZAG = 2646304, JZEROS = 2646560, JPADS = 3170848, JBAND = 3236384, BAND_BLOCKS = 3072;
const LHIST = 5853184, LBITS = 5951488, LALIVE = 5952000, LOWNER = 5952064;
const DPARAMS = 1048576, DBAND = 1049600, DIN = 1261568, BAND_BYTES = DIN - DBAND;
const CTAB = 7426048, CTAB_END = 9523200, CUNIQUE = 9523200, CLARGE = 10309632;
const DYNAMIC = 11882496;
const DECODE_CAP = 64 * 1048576;
let engine;

export function jpegKernels() {
  if (engine !== undefined) return engine;
  engine = null;
  try {
    const text = atob(JPEG_KERNELS), bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    const {exports} = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    const memory = exports.memory;
    let f64, u32, u8, i16, i32, u16;
    const views = () => {
      f64 = new Float64Array(memory.buffer); u32 = new Uint32Array(memory.buffer); u8 = new Uint8Array(memory.buffer);
      i16 = new Int16Array(memory.buffer); i32 = new Int32Array(memory.buffer); u16 = new Uint16Array(memory.buffer);
    };
    if (memory.buffer.byteLength < DYNAMIC) memory.grow(Math.ceil((DYNAMIC - memory.buffer.byteLength) / 65536));
    views();
    let loaded = null;
    const append = (w, bytes) => {
      if (w.at + bytes + 8 >= w.bytes.length) w.grow(bytes + 8);
      w.bytes.set(u8.subarray(OUT, OUT + bytes), w.at); w.at += bytes;
      w.acc = u32[SCRATCH >> 2]; w.pending = u32[(SCRATCH >> 2) + 1];
    };
    exports.initTable();
    engine = {
      clusters: 256, flatten: flattenSparse,
      row(i, freqs, bits) { u32.set(freqs, (ROWS >> 2) + i * 64); f64[(BITS >> 3) + i] = bits; exports.terms(i); },
      own(freqs) { u32.set(freqs, OWN >> 2); },
      alive(i, live) { u8[ALIVE + i] = live ? 1 : 0; },
      priceConfigs(values, weights, candidates, {symbolBits, logLengths}) {
        const n = values.length, c = candidates.length, vals = DYNAMIC, wts = vals + n * 4, cands = wts + n * 4, bits = cands + c * 16;
        const logs = bits + symbolBits.length * 8, scratch = logs + 16, best = scratch + 768, out = best + 512, end = out + 16;
        if (end > memory.buffer.byteLength) { memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536)); views(); }
        u32.set(values, vals >> 2); u32.set(weights, wts >> 2);
        candidates.forEach((k, i) => u32.set([k.split, k.msb, k.lsb, k.splitToken], (cands >> 2) + i * 4));
        f64.set(symbolBits, bits >> 3); u8.set(logLengths, logs);
        const index = exports.priceConfigs(vals, wts, n, cands, c, bits, logs, scratch, best, out);
        return index < 0 ? null : {index, tokens: u32.slice(best >> 2, (best >> 2) + 128), raw: f64[out >> 3], cost: f64[(out >> 3) + 1]};
      },
      seedBest(k, ownBits) { const best = exports.seedBest(k, ownBits); return [best, f64[SCRATCH >> 3]]; },
      seedAll(used, counts, tokenOf, seeds, threshold) {
        const n = used.length, small = DYNAMIC, tok = small + n * 256, loff = tok + 256, owns = loff + ((n + 1) * 4 + 7 & ~7);
        const assign = owns + n * 256, larges = [];
        let pairs = 0;
        for (const ctx of used) if (counts.large[ctx]) for (const v of counts.large[ctx].keys()) pairs++;
        const lpairs = assign + n * 4, end = lpairs + pairs * 8;
        if (end > memory.buffer.byteLength) { memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536)); views(); }
        for (let v = 0; v < 64; v++) u32[(tok >> 2) + v] = tokenOf(v);
        let at = 0;
        for (let t = 0; t < n; t++) {
          const ctx = used[t];
          u32.set(counts.small.subarray(ctx * 64, ctx * 64 + 64), (small >> 2) + t * 64);
          u32[(loff >> 2) + t] = at;
          if (counts.large[ctx]) for (const [v, count] of counts.large[ctx]) { u32[(lpairs >> 2) + 2 * at] = tokenOf(v); u32[(lpairs >> 2) + 2 * at + 1] = count; at++; }
        }
        u32[(loff >> 2) + n] = at;
        const k = exports.seedAll(n, small, loff, lpairs, tok, seeds, threshold, owns, assign);
        const clusters = [];
        for (let t = 0; t < n; t++) {
          const i = u32[(assign >> 2) + t];
          if (i === clusters.length) clusters.push({contexts: [used[t]], freqs: null, bits: 0, last: 0});
          else clusters[i].contexts.push(used[t]);
        }
        for (let i = 0; i < k; i++) { clusters[i].freqs = u32.slice((ROWS >> 2) + i * 64, (ROWS >> 2) + i * 64 + 64); clusters[i].bits = f64[(BITS >> 3) + i]; }
        return {clusters, owns: u32.slice(owns >> 2, (owns >> 2) + n * 64)};
      },
      pairsInit: length => { u8.fill(1, ALIVE, ALIVE + length); exports.pairsInit(length); },
      pairsUpdate: (length, left) => exports.pairsUpdate(length, left),
      pairMin(length) { const left = exports.pairMin(length); return [left, u32[SCRATCH >> 2], f64[(SCRATCH >> 3) + 1]]; },
      assign(sparse, costs, switchCost) {
        const n = sparse.offsets.length - 1, k = costs.length;
        const tables = DYNAMIC, best = tables + k * 512, next = best + k * 8, offsets = next + k * 8;
        const pairs = offsets + (n + 1) * 4, back = pairs + sparse.pairs.length * 4, end = back + ((n * k * 2 + 7) & ~7);
        if (end > memory.buffer.byteLength) { memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536)); views(); }
        for (let i = 0; i < k; i++) f64.set(costs[i], (tables >> 3) + i * 64);
        f64.fill(0, best >> 3, (best >> 3) + 2 * k);
        u32.set(sparse.offsets, offsets >> 2); u32.set(sparse.pairs, pairs >> 2);
        const at = exports.assign(n, k, switchCost, offsets, pairs, tables, back, best, next);
        return [at, i16.subarray(back >> 1, (back >> 1) + n * k)];
      },
      fill(state, g, pass, density) {
        const {authoredOrderPasses, groupsX, progression, contexts, lumaBuckets, lumaW, xsizeBlocks, ysizeBlocks, comps, grey,
          orders, counted, blockCounts, nonZero, hshifts, vshifts} = state;
        if (progression || nonZero || contexts.map.length > 2560 ||
            comps.some((comp, c) => !(grey && c !== 1) && !(comp.coeffs instanceof Int16Array))) return null;
        i32.set(density, FDENSITY >> 2); i32.set(contexts.map, FMAP >> 2);
        const authored = authoredOrderPasses?.[pass];
        const bx0 = g % groupsX * 32, by0 = ((g / groupsX) | 0) * 32;
        const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
        const widths = [0, 1, 2].map(c => Math.ceil(bw / (1 << hshifts[c]))), bucketW = Math.ceil(bw / (1 << hshifts[1]));
        i32.set([bw, bh, contexts.numCtxs, contexts.numDc, contexts.thresholds.length > 0 ? 1 : 0, counted ? 1 : 0, grey ? 1 : 0,
          ...hshifts, ...vshifts, bucketW, ...widths], FILL >> 2);
        for (let c = 0; c < 3; c++) {
          i32.set(authored?.ordinary?.[c] || orders[c], (FORDER >> 2) + c * 64);
          if (grey && c !== 1) continue;
          const {coeffs, stride} = comps[c], width = widths[c], rows = Math.ceil(bh / (1 << vshifts[c]));
          const x = bx0 >> hshifts[c], y = by0 >> vshifts[c], base = (FCOEFFS >> 1) + c * 65536;
          for (let r = 0; r < rows; r++) {
            const at = (y + r) * stride + x;
            i16.set(coeffs.subarray(at * 64, (at + width) * 64), base + r * width * 64);
            if (counted) u8.set(blockCounts[c].subarray(at, at + width), FCOUNTS + c * 1024 + r * width);
          }
        }
        if (contexts.thresholds.length > 0) {
          const rows = Math.ceil(bh / (1 << vshifts[1])), x = bx0 >> hshifts[1], y = by0 >> vshifts[1];
          for (let r = 0; r < rows; r++) u8.set(lumaBuckets.subarray((y + r) * lumaW + x, (y + r) * lumaW + x + bucketW), FBUCKETS + r * bucketW);
        }
        const n = exports.fill();
        if (!counted) for (let c = 0; c < 3; c++) {
          if (grey && c !== 1) continue;
          const {stride} = comps[c], width = widths[c], rows = Math.ceil(bh / (1 << vshifts[c])), x = bx0 >> hshifts[c], y = by0 >> vshifts[c];
          for (let r = 0; r < rows; r++) blockCounts[c].set(u8.subarray(FCOUNTS + c * 1024 + r * width, FCOUNTS + c * 1024 + (r + 1) * width), (y + r) * stride + x);
        }
        return [n, u16.subarray(FCTXS >> 1, (FCTXS >> 1) + n), u16.subarray(FVALUES >> 1, (FVALUES >> 1) + n)];
      },
      sequentialScan(out, entries, nx, ny, restart, zeros, pad, zigzag) {
        const rowBlocks = entries.reduce((n, e) => n + e.v * e.stride, 0);
        if (entries.length > 4 || rowBlocks > BAND_BLOCKS || zeros.size > 65536 || (pad && pad.bits.length > 65536) || out.pending) return false;
        const runs = [...zeros].sort((a, b) => a[0] - b[0]);
        runs.forEach(([block, count], i) => { u32[(JZEROS >> 2) + 2 * i] = block; u32[(JZEROS >> 2) + 2 * i + 1] = count; });
        if (pad) pad.bits.forEach((bit, i) => { u8[JPADS + i] = bit === 0 || bit === 1 ? bit : 255; });
        i32.set(zigzag, JZIGZAG >> 2);
        entries.forEach((e, i) => { i32.set(e.dc, (JCODES >> 2) + i * 514); i32.set(e.ac, (JCODES >> 2) + i * 514 + 257); });
        loaded = null;
        exports.scanStart(pad ? pad.at : 0);
        const band = Math.floor(BAND_BLOCKS / rowBlocks);
        for (let y0 = 0; y0 < ny; y0 += band) {
          const rows = Math.min(band, ny - y0);
          i32.set([entries.length, nx, rows, restart, pad ? pad.bits.length : -1, 0, runs.length], JSCAN >> 2);
          let at = JBAND;
          entries.forEach((e, i) => {
            const from = y0 * e.v * e.stride * 64, to = Math.min(e.co.length, (y0 + rows) * e.v * e.stride * 64);
            i16.set(e.co.subarray(from, to), at >> 1);
            i32.set([e.h, e.v, e.stride, at, e.index], (JSCAN >> 2) + 8 + i * 8);
            at += rows * e.v * e.stride * 128;
          });
          const bytes = exports.scanBand();
          if (bytes < 0) return null;
          out.chunk(u8.subarray(OUT, OUT + bytes));
        }
        out.acc = u32[(JSCAN >> 2) + 56]; out.pending = u32[(JSCAN >> 2) + 57];
        if (pad) pad.at = u32[(JSCAN >> 2) + 7];
        return true;
      },
      sequentialDecode(bytes, start, frame, scan, restartInterval, zigzag) {
        const single = scan.length === 1, first = scan[0].component, length = bytes.length - start;
        const tables = [], slot = table => { let i = tables.indexOf(table); if (i < 0) { i = tables.length; tables.push(table); } return i; };
        const entries = scan.map(s => ({c: s.component, h: single ? 1 : s.component.h, v: single ? 1 : s.component.v, dc: s.dc, ac: s.ac}));
        if (scan.length > 4 || entries.some(e => !e.dc || !e.ac)) return null;
        const slots = entries.map(e => [slot(e.dc), slot(e.ac)]);
        const rowBlocks = entries.reduce((n, e) => n + e.v * e.c.stride, 0), rows = Math.floor(BAND_BYTES / 128 / rowBlocks);
        if (tables.length > 8 || !rows) return null;
        const zerosAt = (DIN + length + 15) & ~15, end = zerosAt + 65536 * 8;
        if (end > memory.buffer.byteLength) {
          if (end > DECODE_CAP) return null;
          try { memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536)); } catch { return null; }
          views();
        }
        loaded = null;
        try {
          tables.forEach((table, i) => u16.set(table, i * 65536));
          u8.set(bytes.subarray(start), DIN);
          i32.set(zigzag, (DPARAMS + 256) >> 2);
          const total = single ? first.blocksW * first.blocksH : frame.mcusX * frame.mcusY, perRow = single ? first.blocksW : frame.mcusX;
          i32.set([entries.length, frame.mcusX, total, restartInterval, single ? 1 : 0, length, first.blocksW, 0, zerosAt], DPARAMS >> 2);
          exports.decodeStart();
          for (let row0 = 0; row0 * perRow < total; row0 += rows) {
            i32[(DPARAMS >> 2) + 7] = row0;
            let at = DBAND;
            entries.forEach((e, i) => {
              i32.set([e.h, e.v, e.c.stride, slots[i][0] * 131072, slots[i][1] * 131072, i, at], (DPARAMS >> 2) + 16 + i * 8);
              at += rows * e.v * e.c.stride * 128;
            });
            if (!exports.decodeBand(Math.min(total, (row0 + rows) * perRow), at - DBAND)) return null;
            at = DBAND;
            for (const e of entries) {
              const from = row0 * e.v * e.c.stride * 64, to = Math.min(e.c.coeffs.length, (row0 + rows) * e.v * e.c.stride * 64);
              e.c.coeffs.set(i16.subarray(at >> 1, (at >> 1) + to - from), from);
              at += rows * e.v * e.c.stride * 128;
            }
          }
          entries.forEach((e, i) => { e.c.pred = i32[((DPARAMS + 224) >> 2) + i]; });
          const zeros = [];
          for (let i = 0, n = u32[(DPARAMS >> 2) + 11]; i < n; i++) zeros.push([u32[(zerosAt >> 2) + 2 * i], u32[(zerosAt >> 2) + 2 * i + 1]]);
          return {pos: start + u32[(DPARAMS >> 2) + 10], zeros};
        } finally {
          exports.initTable();
          if (end > CTAB) u8.fill(0, CTAB, Math.min(CTAB_END, end));
        }
      },
      prefixFilled(model) {
        const {contextMap, histograms} = model;
        if (histograms.length > 255 || contextMap.length > 8192 || histograms.some(h => h.code.lengths.length > 256)) return null;
        const load = () => {
          if (loaded === model) return;
          const slots = [0, 0, 0];
          u8.set(contextMap, CMAP);
          histograms.forEach(({code, config}, id) => {
            const base = HISTOGRAMS + id * TABLE_SIZE;
            u8.fill(0, base, base + TABLE_SIZE);
            for (let v = 0; v < 64; v++) {
              hybridToken(config, v, slots);
              const n = code.lengths[slots[0]], total = n + slots[1], general = n === undefined || total > 24;
              i32[(base >> 2) + v] = general ? -1 : total;
              i32[((base + 256) >> 2) + v] = general ? 0 : code.codes[slots[0]] | slots[2] << n;
            }
            u8.set(code.lengths, base + 512); u16.set(code.codes, (base + 768) >> 1);
            i32.set([config.split, config.msb, config.lsb], (base + 10000) >> 2);
          });
          loaded = model;
        };
        return (w, n) => { load(); exports.tokensIn(0, n); append(w, exports.prefixWrite(n, w.acc, w.pending)); };
      },
      literalClusters(clusters) {
        const n = clusters.length;
        clusters.forEach((c, i) => u32.set(c.freqs, (LHIST >> 2) + i * 256));
        exports.literalClusters(n);
        const kept = [], rank = new Int32Array(n);
        for (let i = 0; i < n; i++) if (u8[LALIVE + i]) {
          rank[i] = kept.length;
          kept.push({freqs: u32.slice((LHIST >> 2) + i * 256, (LHIST >> 2) + (i + 1) * 256), contexts: [], bits: f64[(LBITS >> 3) + i]});
        }
        for (let i = 0; i < n; i++) kept[rank[u32[(LOWNER >> 2) + i]]].contexts.push(...clusters[i].contexts);
        return kept;
      },
      countFilled(into, n) {
        if (into.contexts > 8192) return false;
        const m = exports.countFilled(n), large = u32[SCRATCH >> 2], small = into.small, totals = into.totals;
        for (let i = 0; i < m; i++) {
          const at = u32[(CUNIQUE >> 2) + i], count = u32[(CTAB >> 2) + at];
          small[at] += count; totals[at >> 6] += count;
        }
        exports.countClear(m);
        for (let i = 0; i < large; i++) into.add(u32[(CLARGE >> 2) + 2 * i], u32[(CLARGE >> 2) + 2 * i + 1]);
        return true;
      },
      modularAns(histograms) {
        if (histograms.length > 255 || histograms.some(h => h.counts.length > 256)) return null;
        let n = 0;
        const load = plans => {
          if (loaded !== histograms) {
            histograms.forEach((h, id) => {
              const base = HISTOGRAMS + id * TABLE_SIZE;
              u16.fill(0, base >> 1, (base >> 1) + 256);
              u16.set(h.counts, base >> 1); u16.set(h.starts, (base + 512) >> 1); u16.set(h.reverse, (base + 1040) >> 1);
            });
            exports.recips(histograms.length);
            loaded = histograms;
          }
          n = 0;
          let maps = 0;
          for (const plan of plans) { n += plan.used; maps += plan.histogramMap?.length ?? 0; }
          const end = DYNAMIC + n * 10 + maps * 2;
          if (end > memory.buffer.byteLength) { memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536)); views(); }
          let at = DYNAMIC, map = DYNAMIC + n * 10, offset = histograms.length;
          for (let c = plans.length - 1; c >= 0; c--) offset -= plans[c].freqs.length;
          for (const plan of plans) {
            const {tags, extra, histogramMap, used} = plan;
            u32.set(tags.subarray(0, used), at >> 2); u32.set(extra.subarray(0, used), (at >> 2) + n);
            if (histogramMap) u16.set(histogramMap, map >> 1);
            exports.mtags(at, used, histogramMap ? map : 0, offset);
            at += used * 4; map += (histogramMap?.length ?? 0) * 2; offset += plan.freqs.length;
          }
          return exports.mbits(n, DYNAMIC, DYNAMIC + n * 8);
        };
        return {
          bits: load,
          write(w, plans) {
            const bits = load(plans);
            if (bits + w.pending + 64 > (CTAB - OUT) * 8) return false;
            append(w, exports.mwrite(n, DYNAMIC, DYNAMIC + n * 4, DYNAMIC + n * 8, w.acc, w.pending));
            return bits;
          },
        };
      },
      ansWriter(model) {
        const {contextMap, histograms} = model;
        if (histograms.length > 255 || contextMap.length > 8192 || histograms.some(h => h.counts.length > 256)) return null;
        const load = () => {
          if (loaded === model) return;
          const slots = [0, 0, 0];
          u8.set(contextMap, CMAP);
          histograms.forEach((h, id) => {
            const base = HISTOGRAMS + id * TABLE_SIZE;
            u8.fill(0, base, base + TABLE_SIZE);
            u16.set(h.counts, base >> 1); u16.set(h.starts, (base + 512) >> 1); u16.set(h.reverse, (base + 1040) >> 1);
            for (let v = 0; v < 64; v++) {
              hybridToken(h.config, v, slots);
              i32[((base + 9232) >> 2) + v] = slots[1] << 6 | slots[2];
              i32[((base + 9488) >> 2) + v] = h.counts[slots[0]] || 0; i32[((base + 9744) >> 2) + v] = h.starts[slots[0]] || 0;
            }
            i32.set([h.config.split, h.config.msb, h.config.lsb], (base + 10000) >> 2);
          });
          exports.recips(histograms.length);
          loaded = model;
        };
        let length = 0;
        return {
          write(_w, ctx, value) { u32[(VALUES >> 2) + length] = value; u8[IDS + length++] = contextMap[ctx]; },
          writeTokens(_w, ctxs, tokens, n) {
            const at = VALUES >> 2;
            for (let i = 0; i < n; i++) { u32[at + length] = tokens[i]; u8[IDS + length++] = contextMap[ctxs[i]]; }
          },
          writeFilled(_w, n) { load(); exports.tokensIn(length, n); length += n; },
          flush(w) { load(); append(w, exports.ansFlush(length, w.acc, w.pending)); length = 0; },
          reset() { length = 0; },
        };
      },
    };
  } catch { engine = null; }
  return engine;
}

function flattenSparse(ordered) {
  let total = 0;
  for (const {sparse} of ordered) total += sparse.length;
  const offsets = new Uint32Array(ordered.length + 1), pairs = new Uint32Array(total);
  let at = 0;
  ordered.forEach(({sparse}, t) => { offsets[t] = at; pairs.set(sparse, at); at += sparse.length; });
  offsets[ordered.length] = at;
  return {offsets, pairs};
}
