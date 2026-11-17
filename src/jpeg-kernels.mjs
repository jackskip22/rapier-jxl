import {fault} from './fault.mjs';
import {wasmModule, compileWasm} from './wasm-modules.mjs';
import {wasmBytes} from './wasm-text.mjs';
// SPDX-License-Identifier: MIT
import {JPEG_KERNELS} from './jpeg-kernels-bytes.mjs';
import {JPEG_GENERAL_ROWS} from './jpeg-general-rows-bytes.mjs';
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
const GROUP_VALUES = 3 * 1024 * 64, WCOEFFS = DYNAMIC, WCTXS = WCOEFFS + GROUP_VALUES * 4, WVALUES = WCTXS + GROUP_VALUES * 2;
const DECODE_CAP = 64 * 1048576;
let engine, limit = Infinity;

let tokenFlush = null;
export function jpegKernels(flushTokens) {
  if (flushTokens) tokenFlush = flushTokens;
  if (engine) return engine;
  engine = null;
  try {
    const {exports} = new WebAssembly.Instance(wasmModule('jpeg', () => wasmBytes(JPEG_KERNELS)));
    const memory = exports.memory;
    let f64, u32, u8, i16, i32, u16;
    const views = () => {
      f64 = new Float64Array(memory.buffer); u32 = new Uint32Array(memory.buffer); u8 = new Uint8Array(memory.buffer);
      i16 = new Int16Array(memory.buffer); i32 = new Int32Array(memory.buffer); u16 = new Uint16Array(memory.buffer);
    };
    views();
    const grow = end => {
      if (end > limit) throw fault('JXL_MEMORY', 'arena: too large');
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    };
    const reserve = end => {
      if (end > memory.buffer.byteLength) { grow(end); views(); }
    };
    let loaded = null, priceStamp = null, priceMore = null, lastFillWide = false;
    const append = (w, bytes) => {
      if (w.at + bytes + 8 >= w.bytes.length) w.grow(bytes + 8);
      w.bytes.set(u8.subarray(OUT, OUT + bytes), w.at); w.at += bytes;
      w.acc = u32[SCRATCH >> 2]; w.pending = u32[(SCRATCH >> 2) + 1];
    };
    exports.initTable();
    engine = {
      memoryBytes: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : () => memory.buffer.byteLength,
      ...!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && {fitCfl(y, c, qy, qc, width, rows, stride, map, known) {
        priceStamp = null; priceMore = null;
        const quant = DYNAMIC, scales = quant + 512, multiples = scales + 256, costs = multiples + 256;
        const yp = costs + 32769 * 8, cp = yp + y.length * 2, mp = cp + c.length * 2;
        reserve(mp + map.length);
        u32.set(qy, quant >> 2); u32.set(qc, (quant >> 2) + 64);
        i16.set(y, yp >> 1); i16.set(c, cp >> 1); u8.set(new Uint8Array(map.buffer, map.byteOffset, map.length), mp);
        exports.fitCfl(yp, cp, quant, scales, multiples, costs, mp, width, rows, stride, known);
        c.set(i16.subarray(cp >> 1, (cp >> 1) + c.length));
        map.set(new Int8Array(memory.buffer, mp, map.length));
      }},
      clusters: 256, flatten: flattenSparse,
      row(i, freqs, bits) { u32.set(freqs, (ROWS >> 2) + i * 64); f64[(BITS >> 3) + i] = bits; exports.terms(i); },
      own(freqs) { u32.set(freqs, OWN >> 2); },
      alive(i, live) { u8[ALIVE + i] = live ? 1 : 0; },
      priceConfigs(values, weights, candidates, {symbolBits, logLengths}) {
        const n = values.length, c = candidates.length, bits = DYNAMIC, logs = bits + symbolBits.length * 8, cands = logs + 16;
        const scratch = cands + c * 16, best = scratch + 768, out = best + 512, vals = out + 16, wts = vals + n * 4, end = wts + n * 4;
        if (end > memory.buffer.byteLength) { grow(end); views(); priceStamp = null; }
        priceMore = null;
        if (priceStamp !== candidates) {
          f64.set(symbolBits, bits >> 3); u8.set(logLengths, logs);
          candidates.forEach((k, i) => u32.set([k.split, k.msb, k.lsb, k.splitToken], (cands >> 2) + i * 4));
          priceStamp = candidates;
        }
        u32.set(values, vals >> 2); u32.set(weights, wts >> 2);
        const index = exports.priceConfigs(vals, wts, n, cands, c, bits, logs, scratch, best, out);
        return index < 0 ? null : {index, tokens: u32.slice(best >> 2, (best >> 2) + 128), raw: f64[out >> 3], cost: f64[(out >> 3) + 1]};
      },
      ...!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && {priceEvery(values, weights, candidates, more, largest, {symbolBits, logLengths}) {
        const n = values.length, c = candidates.length, mc = more.length, bits = DYNAMIC, logs = bits + symbolBits.length * 8, cands = logs + 16;
        const extra = cands + c * 16, vals = extra + mc * 16, wts = vals + n * 4, work = wts + n * 4 + 7 & ~7;
        const out = work + (c * 528 + (c + mc) * 8 + 512 + mc * 1048 + (c + 6) * 12 + c + 6 + mc) + 7 & ~7, end = out + 5 * 24;
        if (end > memory.buffer.byteLength) { grow(end); views(); priceStamp = null; }
        if (priceStamp !== candidates || priceMore !== more) {
          f64.set(symbolBits, bits >> 3); u8.set(logLengths, logs);
          [...candidates, ...more].forEach((k, i) => u32.set([k.split, k.msb, k.lsb, k.splitToken], (cands >> 2) + i * 4));
          priceStamp = candidates; priceMore = more;
        }
        u32.set(values, vals >> 2); u32.set(weights, wts >> 2);
        const f = exports.priceEvery(vals, wts, n, cands, c, extra, mc, largest, bits, logs, work, out), list = [];
        for (let k = 0; k < f; k++) {
          const at = (out >> 2) + k * 6, from = u32[at] >> 2, i = u32[at + 2];
          list.push({candidate: i < c ? candidates[i] : more[i - c], tokens: u32.slice(from, from + u32[at + 1]), raw: f64[(out >> 3) + k * 3 + 2]});
        }
        return list;
      }},
      seedBest(k, ownBits) { const best = exports.seedBest(k, ownBits); return [best, f64[SCRATCH >> 3]]; },
      seedAll(used, counts, tokenOf, seeds, threshold, prior = []) {
        priceStamp = null;
        const n = used.length, small = DYNAMIC, tok = small + n * 256, loff = tok + 256, runs = loff + ((n + 1) * 4 + 7 & ~7);
        const offs = runs + n * 512, assign = offs + ((n + 1) * 4 + 7 & ~7), larges = [];
        let pairs = 0;
        for (const ctx of used) if (counts.large[ctx]) for (const v of counts.large[ctx].keys()) pairs++;
        const lpairs = assign + n * 4, end = lpairs + pairs * 8;
        if (end > memory.buffer.byteLength) { grow(end); views(); }
        for (let v = 0; v < 64; v++) u32[(tok >> 2) + v] = tokenOf(v);
        let at = 0;
        for (let t = 0; t < n; t++) {
          const ctx = used[t];
          u32.set(counts.small.subarray(ctx * 64, ctx * 64 + 64), (small >> 2) + t * 64);
          u32[(loff >> 2) + t] = at;
          if (counts.large[ctx]) for (const [v, count] of counts.large[ctx]) { u32[(lpairs >> 2) + 2 * at] = tokenOf(v); u32[(lpairs >> 2) + 2 * at + 1] = count; at++; }
        }
        u32[(loff >> 2) + n] = at;
        const k = exports.seedAll(n, small, loff, lpairs, tok, seeds, threshold, runs, offs, assign, prior.length);
        const clusters = prior.slice();
        for (let t = 0; t < n; t++) {
          const i = u32[(assign >> 2) + t];
          if (i === clusters.length) clusters.push({contexts: [used[t]], freqs: null, bits: 0, last: 0, cost: -1});
          else clusters[i].contexts.push(used[t]);
        }
        for (let i = 0; i < k; i++) { clusters[i].freqs = u32.slice((ROWS >> 2) + i * 64, (ROWS >> 2) + i * 64 + 64); clusters[i].bits = f64[(BITS >> 3) + i]; }
        const offsets = u32.slice(offs >> 2, (offs >> 2) + n + 1);
        return {clusters, offsets, runs: u32.slice(runs >> 2, (runs >> 2) + 2 * offsets[n])};
      },
      pairsInit: length => { u8.fill(1, ALIVE, ALIVE + length); exports.pairsInit(length); },
      pairsUpdate: (length, left) => exports.pairsUpdate(length, left),
      pairMin(length) { const left = exports.pairMin(length); return [left, u32[SCRATCH >> 2], f64[(SCRATCH >> 3) + 1]]; },
      assign(sparse, costs, switchCost) {
        priceStamp = null;
        const n = sparse.offsets.length - 1, k = costs.length;
        const tables = DYNAMIC, best = tables + k * 512, next = best + k * 8, offsets = next + k * 8;
        const pairs = offsets + (n + 1) * 4, back = pairs + sparse.pairs.length * 4, end = back + ((n * k * 2 + 7) & ~7);
        if (end > memory.buffer.byteLength) { grow(end); views(); }
        for (let i = 0; i < k; i++) f64.set(costs[i], (tables >> 3) + i * 64);
        f64.fill(0, best >> 3, (best >> 3) + 2 * k);
        u32.set(sparse.offsets, offsets >> 2); u32.set(sparse.pairs, pairs >> 2);
        const at = exports.assign(n, k, switchCost, offsets, pairs, tables, back, best, next);
        return [at, i16.subarray(back >> 1, (back >> 1) + n * k)];
      },
      fill: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function fill(state, g, pass, density) {
        const {authoredOrderPasses, groupsX, progression, contexts, lumaBuckets, lumaW, xsizeBlocks, ysizeBlocks, comps, grey,
          orders, counted, blockCounts, nonZero, hshifts, vshifts} = state;
        if (progression || nonZero || contexts.map.length > 2560) return null;
        const wide = comps.some((comp, c) => !(grey && c !== 1) && comp.coeffs instanceof Int32Array) ? 1 : 0;
        const coeffBase = wide ? WCOEFFS : FCOEFFS, ctxBase = wide ? WCTXS : FCTXS, valueBase = wide ? WVALUES : FVALUES;
        reserve(wide ? WVALUES + GROUP_VALUES * 4 : CTAB);
        const plane = wide ? i32 : i16;
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
          const x = bx0 >> hshifts[c], y = by0 >> vshifts[c], base = (coeffBase >> (1 + wide)) + c * 65536;
          const first = comps[c].row0 > 0 ? comps[c].row0 * stride : 0;
          for (let r = 0; r < rows; r++) {
            const at = (y + r) * stride + x;
            plane.set(coeffs.subarray((at - first) * 64, (at - first + width) * 64), base + r * width * 64);
            if (counted) u8.set(blockCounts[c].subarray(at, at + width), FCOUNTS + c * 1024 + r * width);
          }
        }
        if (contexts.thresholds.length > 0) {
          const rows = Math.ceil(bh / (1 << vshifts[1])), x = bx0 >> hshifts[1], y = by0 >> vshifts[1];
          for (let r = 0; r < rows; r++) u8.set(lumaBuckets.subarray((y + r) * lumaW + x, (y + r) * lumaW + x + bucketW), FBUCKETS + r * bucketW);
        }
        const n = exports.fill(coeffBase, ctxBase, valueBase, wide);
        if (!counted) for (let c = 0; c < 3; c++) {
          if (grey && c !== 1) continue;
          const {stride} = comps[c], width = widths[c], rows = Math.ceil(bh / (1 << vshifts[c])), x = bx0 >> hshifts[c], y = by0 >> vshifts[c];
          for (let r = 0; r < rows; r++) blockCounts[c].set(u8.subarray(FCOUNTS + c * 1024 + r * width, FCOUNTS + c * 1024 + (r + 1) * width), (y + r) * stride + x);
        }
        lastFillWide = wide === 1;
        const filled = [n, u16.subarray(ctxBase >> 1, (ctxBase >> 1) + n), wide ? u32.subarray(valueBase >> 2, (valueBase >> 2) + n) : u16.subarray(valueBase >> 1, (valueBase >> 1) + n)];
        if (wide) filled.wide = true;
        return filled;
      },
      ...((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? {} : {
      sequentialScan(out, entries, nx, ny, restart, zeros, pad, zigzag) {
        const rowBlocks = entries.reduce((n, e) => n + e.v * e.stride, 0);
        if (entries.length > 4 || rowBlocks > BAND_BLOCKS || zeros.size > 65536 || (pad && pad.bits.length > 65536) || out.pending) return false;
        reserve(CTAB);
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
          try { grow(end); } catch { return null; }
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
      ...((typeof __RAPIER_JXL_JPEG__ === 'undefined' || __RAPIER_JXL_JPEG__ === true) && {
      scaledDecode(bytes, start, frame, scan, restartInterval, zigzag, plan, onBand, orient = 1) {
        const single = scan.length === 1, first = scan[0].component, length = bytes.length - start;
        const tables = [], slot = table => { let i = tables.indexOf(table); if (i < 0) { i = tables.length; tables.push(table); } return i; };
        const entries = scan.map(s => ({c: s.component, h: single ? 1 : s.component.h, v: single ? 1 : s.component.v, dc: s.dc, ac: s.ac}));
        if (scan.length > 4 || entries.some(e => !e.dc || !e.ac)) return null;
        const slots = entries.map(e => [slot(e.dc), slot(e.ac)]);
        if (tables.length > 8) return null;
        const {mxY, myY, mxC, myC, outW, outH, mode, clampW, clampH, yBias, cBias} = plan;
        const mcusX = frame.mcusX, mcusY = frame.mcusY;
        const rowBlocks = entries.reduce((n, e) => n + e.v * e.c.stride, 0);
        const bandMcus = Math.max(2, Math.min(mcusY, Math.min(16, Math.max(2, Math.floor(16384 / Math.max(1, rowBlocks))))));
        const coeffBandBytes = bandMcus * rowBlocks * 128;
        const yStride = (mcusX * entries[0].h * mxY + 15) & ~3;
        const cStride = entries.length > 1 ? ((mcusX * entries[1].h * mxC + 15) & ~3) : 16;
        const maxYRows = bandMcus * entries[0].v * myY + 4;
        const maxCRows = entries.length > 1 ? (bandMcus * entries[1].v * myC + 4) : 4;
        const huffAt = (DIN + length + 63) & ~63;
        const bandAt = (huffAt + tables.length * 131072 + 63) & ~63;
        const quantAt = (bandAt + coeffBandBytes + 63) & ~63;
        const yPlane = quantAt + 1024;
        const cbPlane = yPlane + maxYRows * yStride * 4;
        const crPlane = cbPlane + (entries.length > 1 ? maxCRows * cStride * 4 : 64);
        const vScratch = crPlane + (entries.length > 1 ? maxCRows * cStride * 4 : 64);
        const rgbaAt = (vScratch + (clampW + 32) * 8 + 63) & ~63;
        const rgbaBytes = maxYRows * outW * 4;
        const useOrientWasm = orient > 1 && (rgbaAt + rgbaBytes + outW * outH * 4 <= DECODE_CAP);
        const orientDst = useOrientWasm ? ((rgbaAt + rgbaBytes + 63) & ~63) : 0;
        const end = useOrientWasm ? (orientDst + outW * outH * 4) : (rgbaAt + rgbaBytes);
        if (end > memory.buffer.byteLength) {
          if (end > DECODE_CAP) return null;
          try { grow(end); } catch { return null; }
          views();
        }
        loaded = null;
        const f32 = new Float32Array(memory.buffer);
        try {
          tables.forEach((table, i) => u16.set(table, (huffAt >> 1) + i * 65536));
          u8.set(bytes.subarray(start), DIN);
          i32.set(zigzag, (DPARAMS + 256) >> 2);
          entries.forEach((e, i) => {
            const qBase = (quantAt + i * 256) >> 2;
            for (let k = 0; k < 64; k++) f32[qBase + k] = e.c.quant[k];
          });
          const total = single ? first.blocksW * first.blocksH : mcusX * mcusY;
          const perRow = single ? first.blocksW : mcusX;
          const totalRows = single ? first.blocksH : mcusY;
          i32.set([entries.length, mcusX, total, restartInterval, single ? 1 : 0, length, first.blocksW, 0, 0], DPARAMS >> 2);
          exports.decodeStart();
          const needOverlap = mode === 2 || mode === 4;
          let heldY = 0, heldC = 0, emittedY = 0;
          for (let row0 = 0; row0 < totalRows; row0 += bandMcus) {
            const mcuRows = Math.min(bandMcus, totalRows - row0);
            i32[(DPARAMS >> 2) + 7] = row0;
            let at = bandAt;
            const entryBases = [];
            entries.forEach((e, i) => {
              entryBases.push(at);
              i32.set([e.h, e.v, e.c.stride, huffAt + slots[i][0] * 131072, huffAt + slots[i][1] * 131072, i, at], (DPARAMS >> 2) + 16 + i * 8);
              at += mcuRows * e.v * e.c.stride * 128;
            });
            if (!exports.decodeBand(Math.min(total, (row0 + mcuRows) * perRow), at - bandAt)) return null;
            exports.idctPlane(entryBases[0], quantAt, entries[0].c.blocksW, mcuRows * entries[0].v, entries[0].c.stride,
              mxY, myY, yPlane + heldY * yStride * 4, yStride, yBias);
            if (entries.length === 3) {
              exports.idctPlane(entryBases[1], quantAt + 256, entries[1].c.blocksW, mcuRows * entries[1].v, entries[1].c.stride,
                mxC, myC, cbPlane + heldC * cStride * 4, cStride, cBias);
              exports.idctPlane(entryBases[2], quantAt + 512, entries[2].c.blocksW, mcuRows * entries[2].v, entries[2].c.stride,
                mxC, myC, crPlane + heldC * cStride * 4, cStride, cBias);
            }
            const cRowBase = row0 * (entries[1]?.v ?? 1) * myC - heldC;
            const decodedY = mcuRows * entries[0].v * myY;
            const availY = Math.min(heldY + decodedY, outH - emittedY);
            if (availY <= 0) break;
            const holdOne = needOverlap && (row0 + mcuRows < totalRows) && (emittedY + availY < outH);
            const emitRows = holdOne ? availY - 1 : availY;
            if (emitRows > 0) {
              exports.jpegRgbaRows(yPlane, cbPlane, crPlane, yStride, cStride, outW, emitRows, mode,
                clampW, 0, emittedY, cRowBase, clampH, vScratch, rgbaAt);
              if (useOrientWasm) {
                exports.orientBandRgba(rgbaAt, orientDst, outW, outH, emittedY, emitRows, orient);
              } else {
                onBand(emittedY, emitRows, u8.subarray(rgbaAt, rgbaAt + emitRows * outW * 4));
              }
              emittedY += emitRows;
            }
            if (holdOne) {
              u8.copyWithin(yPlane, yPlane + emitRows * yStride * 4, yPlane + (emitRows + 1) * yStride * 4);
              const lastC = heldC + mcuRows * entries[1].v * myC - 1;
              u8.copyWithin(cbPlane, cbPlane + lastC * cStride * 4, cbPlane + (lastC + 1) * cStride * 4);
              u8.copyWithin(crPlane, crPlane + lastC * cStride * 4, crPlane + (lastC + 1) * cStride * 4);
              heldY = 1; heldC = 1;
            } else {
              heldY = 0; heldC = 0;
            }
          }
          const oriented = useOrientWasm ? u8.slice(orientDst, orientDst + outW * outH * 4) : null;
          return {pos: start + u32[(DPARAMS >> 2) + 10], oriented};
        } finally {
          if (end > CTAB) u8.fill(0, CTAB, Math.min(CTAB_END, end));
        }
      },
      async renderGeneralBands(parsed, onBand) {
        const comps = parsed.components, count = comps.length;
        const hmax = Math.max(...comps.map(c => c.h)), vmax = Math.max(...comps.map(c => c.v));
        const {width, height} = parsed;
        const mcusY = Math.ceil(height / (8 * vmax));
        const bandMcus = Math.max(1, Math.min(8, Math.floor(131072 / Math.max(1, width * vmax * 8))));
        let render;
        try {
          const binary = () => Uint8Array.from(atob(JPEG_GENERAL_ROWS), c => c.charCodeAt(0));
          if (!await compileWasm('general', binary)) throw 0;
          render = new WebAssembly.Instance(wasmModule('general', binary), {env: {memory}}).exports.jpegGeneralRows;
        } catch {
          throw fault('JXL_WASM', 'JPEG layout: ' + comps.map(c => c.h + 'x' + c.v).join('/')
            + (count === 4 ? ' CMYK/YCCK' : '') + ': kernel unavailable');
        }
        const mode = count === 1 ? 0 : count === 3 ? (parsed.ycbcr ? 1 : 2)
          : parsed.adobeTransform === 2 ? 5 : parsed.adobeTransform === 0 ? 3 : 4;
        loaded = null;
        priceStamp = null;
        for (let row0 = 0; row0 < mcusY; row0 += bandMcus) {
          const rows = Math.min(bandMcus, mcusY - row0), first = Math.max(0, row0 - 1);
          const last = Math.min(mcusY, row0 + rows + 1), decodedMcus = last - first;
          const y0 = row0 * vmax * 8, emittedRows = Math.min(height - y0, rows * vmax * 8);
          let at = DPARAMS;
          const coff = [];
          for (const c of comps) { coff.push(at); at += decodedMcus * c.v * c.stride * 128; }
          const quantAt = (at + 63) & ~63;
          at = quantAt + 256 * count;
          const plane = [];
          for (const c of comps) {
            const stride = (c.stride * 8 + 15) & ~3;
            plane.push({base: at, stride});
            at += decodedMcus * c.v * 8 * stride * 4;
          }
          const descAt = (at + 63) & ~63;
          const rgbaAt = (descAt + 28 * count + 63) & ~63;
          const end = rgbaAt + emittedRows * width * 4;
          reserve(end);
          const f32 = new Float32Array(memory.buffer);
          for (let i = 0; i < count; i++) {
            const c = comps[i], base = coff[i], n = decodedMcus * c.v * c.stride * 64;
            const from = first * c.v * c.stride * 64, to = Math.min(c.coeffs.length, from + n);
            u8.fill(0, base, base + n * 2);
            if (to > from) i16.set(c.coeffs.subarray(from, to), base >> 1);
            for (let k = 0; k < 64; k++) f32[((quantAt + i * 256) >> 2) + k] = c.quant[k];
            exports.idctPlane(base, quantAt + i * 256, c.blocksW, decodedMcus * c.v, c.stride,
              8, 8, plane[i].base, plane[i].stride, 128);
            i32.set([plane[i].base, plane[i].stride, c.h, c.v, Math.ceil(width * c.h / hmax),
              Math.ceil(height * c.v / vmax), first * c.v * 8], (descAt >> 2) + i * 7);
          }
          render(descAt, width, height, y0, emittedRows, hmax, vmax, count, mode, rgbaAt);
          onBand(y0, emittedRows, u8.subarray(rgbaAt, rgbaAt + emittedRows * width * 4));
        }
      },
      renderParsedBands(parsed, plan, onBand) {
        const comps = parsed.components, count = comps.length;
        const {mxY, myY, mxC, myC, outW, outH, mode, clampW, clampH, yBias, cBias, mcusX, mcusY} = plan;
        const rowBlocks = comps.reduce((n, c) => n + c.v * c.stride, 0);
        const bandMcus = Math.max(2, Math.min(mcusY, Math.min(16, Math.max(2, Math.floor(16384 / Math.max(1, rowBlocks))))));
        const coeffBandBytes = bandMcus * rowBlocks * 128;
        const yStride = (mcusX * comps[0].h * mxY + 15) & ~3;
        const cStride = count > 1 ? ((mcusX * comps[1].h * mxC + 15) & ~3) : 16;
        const maxYRows = bandMcus * comps[0].v * myY + 4;
        const maxCRows = count > 1 ? (bandMcus * comps[1].v * myC + 4) : 4;
        const bandAt = DPARAMS;
        const quantAt = (bandAt + coeffBandBytes + 63) & ~63;
        const yPlane = quantAt + 1024;
        const cbPlane = yPlane + maxYRows * yStride * 4;
        const crPlane = cbPlane + (count > 1 ? maxCRows * cStride * 4 : 64);
        const vScratch = crPlane + (count > 1 ? maxCRows * cStride * 4 : 64);
        const rgbaAt = (vScratch + (clampW + 32) * 8 + 63) & ~63;
        const end = rgbaAt + maxYRows * outW * 4;
        reserve(end);
        const f32 = new Float32Array(memory.buffer);
        loaded = null;
        try {
          comps.forEach((c, i) => {
            const qBase = (quantAt + i * 256) >> 2;
            for (let k = 0; k < 64; k++) f32[qBase + k] = c.quant[k];
          });
          const needOverlap = mode === 2 || mode === 4;
          let heldY = 0, heldC = 0, emittedY = 0;
          for (let row0 = 0; row0 < mcusY; row0 += bandMcus) {
            const mcuRows = Math.min(bandMcus, mcusY - row0);
            let at = bandAt;
            const bases = [];
            for (const c of comps) {
              bases.push(at);
              const rFrom = row0 * c.v * c.stride * 64;
              const rTo = Math.min(c.coeffs.length, (row0 + mcuRows) * c.v * c.stride * 64);
              u8.fill(0, at, at + mcuRows * c.v * c.stride * 128);
              if (rTo > rFrom) i16.set(c.coeffs.subarray(rFrom, rTo), at >> 1);
              at += mcuRows * c.v * c.stride * 128;
            }
            exports.idctPlane(bases[0], quantAt, comps[0].blocksW, mcuRows * comps[0].v, comps[0].stride,
              mxY, myY, yPlane + heldY * yStride * 4, yStride, yBias);
            if (count === 3) {
              exports.idctPlane(bases[1], quantAt + 256, comps[1].blocksW, mcuRows * comps[1].v, comps[1].stride,
                mxC, myC, cbPlane + heldC * cStride * 4, cStride, cBias);
              exports.idctPlane(bases[2], quantAt + 512, comps[2].blocksW, mcuRows * comps[2].v, comps[2].stride,
                mxC, myC, crPlane + heldC * cStride * 4, cStride, cBias);
            }
            const cRowBase = row0 * (comps[1]?.v ?? 1) * myC - heldC;
            const decodedY = mcuRows * comps[0].v * myY;
            const availY = Math.min(heldY + decodedY, outH - emittedY);
            if (availY <= 0) break;
            const holdOne = needOverlap && (row0 + mcuRows < mcusY) && (emittedY + availY < outH);
            const emitRows = holdOne ? availY - 1 : availY;
            if (emitRows > 0) {
              exports.jpegRgbaRows(yPlane, cbPlane, crPlane, yStride, cStride, outW, emitRows, mode,
                clampW, 0, emittedY, cRowBase, clampH, vScratch, rgbaAt);
              onBand(emittedY, emitRows, u8.subarray(rgbaAt, rgbaAt + emitRows * outW * 4));
              emittedY += emitRows;
            }
            if (holdOne) {
              u8.copyWithin(yPlane, yPlane + emitRows * yStride * 4, yPlane + (emitRows + 1) * yStride * 4);
              const lastC = heldC + mcuRows * comps[1].v * myC - 1;
              u8.copyWithin(cbPlane, cbPlane + lastC * cStride * 4, cbPlane + (lastC + 1) * cStride * 4);
              u8.copyWithin(crPlane, crPlane + lastC * cStride * 4, crPlane + (lastC + 1) * cStride * 4);
              heldY = 1; heldC = 1;
            } else {
              heldY = 0; heldC = 0;
            }
          }
        } finally {
          if (end > CTAB) u8.fill(0, CTAB, Math.min(CTAB_END, end));
        }
      },
      }),
      }),
      prefixFilled: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function prefixFilled(model) {
        const {contextMap, histograms} = model;
        if (histograms.length > 255 || contextMap.length > 8192 || histograms.some(h => h.code.lengths.length > 256)) return null;
        const load = () => {
          if (loaded === model) return;
          reserve(CTAB);
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
      ...((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? {} : {
      literalClusters(clusters) {
        const n = clusters.length;
        reserve(OUT + 131072);
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
      }),
      countFilled: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function countFilled(into, n) {
        if (into.contexts > 8192 || lastFillWide) return false;
        reserve(DYNAMIC);
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
        let n = 0, lastPlans = null, lastBits = 0;
        const load = plans => {
          if (loaded !== histograms) {
            reserve(HISTOGRAMS + histograms.length * TABLE_SIZE);
            histograms.forEach((h, id) => {
              const base = HISTOGRAMS + id * TABLE_SIZE;
              u16.fill(0, base >> 1, (base >> 1) + 256);
              u16.set(h.counts, base >> 1); u16.set(h.starts, (base + 512) >> 1); u16.set(h.reverse, (base + 1040) >> 1);
            });
            exports.recips(histograms.length);
            loaded = histograms;
            lastPlans = null;
          }
          if (lastPlans === plans) return lastBits;
          priceStamp = null;
          n = 0;
          let maps = 0;
          for (const plan of plans) { n += plan.used; maps += plan.histogramMap?.length ?? 0; }
          const end = DYNAMIC + n * 10 + maps * 2;
          if (end > memory.buffer.byteLength) { grow(end); views(); }
          let at = DYNAMIC, map = DYNAMIC + n * 10, offset = histograms.length;
          for (let c = plans.length - 1; c >= 0; c--) offset -= plans[c].freqs.length;
          for (const plan of plans) {
            const {tags, extra, histogramMap, used} = plan;
            u32.set(tags.subarray(0, used), at >> 2); u32.set(extra.subarray(0, used), (at >> 2) + n);
            if (histogramMap) u16.set(histogramMap, map >> 1);
            exports.mtags(at, used, histogramMap ? map : 0, offset);
            at += used * 4; map += (histogramMap?.length ?? 0) * 2; offset += plan.freqs.length;
          }
          lastPlans = plans;
          return lastBits = exports.mbits(n, DYNAMIC, DYNAMIC + n * 8);
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
      ansWriter: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? () => ({write: true, flush: true}) : function ansWriter(model) {
        const {contextMap, histograms} = model;
        if (histograms.length > 255 || contextMap.length > 8192 || histograms.some(h => h.counts.length > 256)) return null;
        reserve(CTAB);
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
          flush(w) {
            if (!tokenFlush) throw fault('JXL_INTERNAL', 'jpeg-kernels:ans-writer');
            tokenFlush(w, model, u32.subarray(VALUES >> 2, (VALUES >> 2) + length), u8.subarray(IDS, IDS + length), length); length = 0;
          },
          reset() { length = 0; },
        };
      },
    };
  } catch { engine = null; }
  return engine;
}
export const compileJpegKernels = () => compileWasm('jpeg', () => wasmBytes(JPEG_KERNELS));
export function capJpegKernels(bytes, flushTokens) {
  if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) return null;
  const kernels = jpegKernels(flushTokens);
  if (!kernels || kernels.memoryBytes() > bytes) return null;
  limit = bytes;
  return kernels;
}
export function releaseJpegKernels() { if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) return; engine = undefined; limit = Infinity; }

function flattenSparse(ordered) {
  let total = 0;
  for (const {sparse} of ordered) total += sparse.length;
  const offsets = new Uint32Array(ordered.length + 1), pairs = new Uint32Array(total);
  let at = 0;
  ordered.forEach(({sparse}, t) => { offsets[t] = at; pairs.set(sparse, at); at += sparse.length; });
  offsets[ordered.length] = at;
  return {offsets, pairs};
}
