// Rapier's JPEG XL encoder: a JPEG carried into a VarDCT frame. MIT (images/jxl/LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, float16Bits, packSigned, ceilLog2, complete} from './bits.mjs';
import {writeFrameHeaderEnd, finishSections, assembleCodestream, GROUP_DIM, GROUP_TOKENS} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, MIN_RUN_SYMBOL, MIN_RUN_LENGTH, RUN_CONFIG, RESIDUAL_CONFIG, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {writeContextMap, writeHistograms, buildCode, uintConfig, countToken, writeHybrid, hybridToken} from './prefix.mjs';
import {TokenCounts, buildTokenCoding} from './entropy.mjs';
import {jpegError, ZIGZAG} from './jpeg-tables.mjs';
import {admitOutputSize} from './admit.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {offloading} from './offload.mjs';

const NONZERO_BUCKETS = 37, ZERO_DENSITY_CONTEXTS = 458, ORDERS = 13;
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'length').get;
const TYPED_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer').get;
const BUFFER_LENGTH = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
export const COEFF_FREQ_CONTEXT = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22,
  23, 23, 23, 23, 24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30];
export const COEFF_NUM_NONZERO_CONTEXT = [0, 0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180,
  180, 180, 180, 180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
  206, 206, 206, 206, 206, 206, 206, 206];

export const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));

export const zeroDensityContext = (left, k, prev) => (COEFF_NUM_NONZERO_CONTEXT[left] + COEFF_FREQ_CONTEXT[k]) * 2 + prev;
export const DCT8_DENSITY = Int32Array.from({length: 64 * 64}, (_, i) => (COEFF_NUM_NONZERO_CONTEXT[i >> 6] + COEFF_FREQ_CONTEXT[i & 63]) * 2);

const VD_LF_SECTIONS = new WeakMap();
const lfEntryOf = (jpeg, plan) => {
  const key = {coder: plan.lfCoder, modularAns: plan.modularAns, epf: jpeg.epf, strategyData: jpeg.strategyData, quantFields: jpeg.quantFields, cfl: jpeg.cfl,
    auxiliary: jpeg.auxiliary, useDCFrame: jpeg.useDCFrame, sharpness: jpeg.sharpness, field: jpeg.quantFieldBase, alpha: jpeg.alpha, xyb: jpeg.xyb, ycbcr: jpeg.ycbcr,
    reconstruction: jpeg.jpegReconstruction};
  const hit = VD_LF_SECTIONS.get(jpeg.components);
  if (hit && Object.keys(key).every(k => hit[k] === key[k])) return hit;
  const entry = {...key, sections: [], wide: false};
  VD_LF_SECTIONS.set(jpeg.components, entry);
  return entry;
};
export function vdLfGroupCount({width, height, components}) {
  const hs = components.map(c => c.h), vs = components.map(c => c.v), log2 = v => v === 1 ? 0 : 1;
  const maxhs = log2(Math.max(...hs) / Math.min(...hs)), maxvs = log2(Math.max(...vs) / Math.min(...vs));
  return Math.ceil((Math.ceil(width / (8 << maxhs)) << maxhs) / 256) * Math.ceil((Math.ceil(height / (8 << maxvs)) << maxvs) / 256);
}
export function seedLfSections(jpeg, plan, groups) {
  const entry = lfEntryOf(jpeg, plan);
  groups.forEach((group, g) => { entry.sections[g] ||= Object.assign(new BitWriter(0), {bytes: group.bytes, at: group.at, pending: group.pending, acc: group.acc}); entry.wide ||= group.wide; });
}
const ORDER_OF = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
const ORDER_CLASS = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 7, 7, 7];
const DESIGNS = {
  dcBuckets: grey => (row, ord, i, n) => row === 0 ? i : grey ? n : row === 1 ? n + (i >> 1) : n + ((n - 1) >> 1) + 1 + (i >> 1),
  sizes: grey => (row, ord) => (grey && row ? 1 : row) * 2 + (ord ? 1 : 0),
  sizesShared: () => (row, ord) => (row ? 2 : 0) + (ord ? 1 : 0),
  sizes3: grey => (row, ord) => (grey && row ? 1 : row) * 3 + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizes3Shared: () => (row, ord) => (row ? 3 : 0) + (ORDER_CLASS[ord] === 0 ? 0 : ORDER_CLASS[ord] === 2 ? 1 : 2),
  sizesDc: grey => (row, ord, i, n) => {
    const b = n <= 2 ? i : (i * 2 / n) | 0;
    if (row === 0) return (ORDER_CLASS[ord] ? 2 : 0) + b;
    if (grey) return 4 + (ORDER_CLASS[ord] ? 1 : 0);
    return 4 + (row - 1) * 2 + (ORDER_CLASS[ord] ? 1 : 0);
  },
  fine: () => (row, ord, i, n) => (row * 8 + ORDER_CLASS[ord]) * n + i,
};
export function blockContexts(luma, thresholdsWanted, grey, design = DESIGNS.dcBuckets(grey)) {
  const thresholds = [];
  if (thresholdsWanted > 0) {
    let low = -1024, high = 1023, total = 0;
    for (const value of luma) { if (value < low) low = value; else if (value > high) high = value; }
    const counts = new Uint32Array(high - low + 1);
    for (const value of luma) { counts[value - low]++; total++; }
    let cumulative = 0, cut = total / (thresholdsWanted + 1);
    for (let j = 0; j < counts.length && thresholds.length < thresholdsWanted; j++) {
      cumulative += counts[j];
      if (cumulative > cut) { thresholds.push(j + low - 1); cut = total * (thresholds.length + 1) / (thresholdsWanted + 1); }
    }
  }
  const numDc = thresholds.length + 1, map = new Uint8Array(3 * ORDERS * numDc);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let i = 0; i < numDc; i++) map[(row * ORDERS + ord) * numDc + i] = design(row, ord, i, numDc);
  let numCtxs = 0;
  for (const v of map) numCtxs = Math.max(numCtxs, v + 1);
  const bucketOf = value => { let b = 0; for (const t of thresholds) if (value > t) b++; return b; };
  return {thresholds, numDc, map, numCtxs, bucketOf, ...acContexts(map, numDc, numCtxs)};
}

export function acContexts(map, numDc, numCtxs) {
  return {contextOf: (c, bucket, ord = 0) => map[((c < 2 ? c ^ 1 : 2) * ORDERS + ord) * numDc + bucket],
    nonZero: (predicted, blockCtx) => (Math.min(predicted, 64) < 8 ? Math.min(predicted, 64) : 4 + (Math.min(predicted, 64) >> 1)) * numCtxs + blockCtx,
    zeroDensityOffset: blockCtx => numCtxs * NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS * blockCtx,
    contexts: numCtxs * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS)};
}

function writeBlockContexts(w, contexts) {
  w.write(4, contexts.thresholds.length);
  for (const t of contexts.thresholds) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  w.write(4, 0); w.write(4, 0);
  writeContextMap(w, contexts.map);
}

const FAST_CONTEXTS_RGB = blockContexts(new Int32Array(0), 0, false);
const FAST_CONTEXTS_GREY = blockContexts(new Int32Array(0), 0, true);
const FAST_HEADER_RGB = (() => { const w = new BitWriter(64); writeBlockContexts(w, FAST_CONTEXTS_RGB); return w; })();
const FAST_HEADER_GREY = (() => { const w = new BitWriter(64); writeBlockContexts(w, FAST_CONTEXTS_GREY); return w; })();

function tokenStore() {
  const chunks = [];
  let index = 0, at = 0;
  return {
    reset() { index = 0; at = 0; },
    keep({ctxs, values}, n) {
      let widest = 0;
      for (let i = 0; i < n; i++) widest |= ctxs[i] | values[i];
      if (widest >>> 0 > 65535) return null;
      let size = GROUP_TOKENS << Math.min(index, 3);
      if (at + n > size) { index++; at = 0; size = GROUP_TOKENS << Math.min(index, 3); }
      const chunk = chunks[index] ||= {ctxs: new Uint16Array(size), values: new Uint16Array(size)};
      const kept = {ctxs: chunk.ctxs.subarray(at, at + n), values: chunk.values.subarray(at, at + n)};
      kept.ctxs.set(ctxs.subarray(0, n)); kept.values.set(values.subarray(0, n)); at += n;
      return kept;
    }
  };
}

function contextRenaming(source, target) {
  const into = new Int16Array(source.numCtxs).fill(-1);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let i = 0; i < source.numDc; i++) {
    const from = source.map[(row * ORDERS + ord) * source.numDc + i], to = target.map[(row * ORDERS + ord) * target.numDc + (target.numDc === 1 ? 0 : i)];
    if (into[from] >= 0 && into[from] !== to) return false;
    into[from] = to;
  }
  const renaming = new Int32Array(source.contexts).fill(-1);
  for (let from = 0; from < source.numCtxs; from++) {
    const to = into[from];
    if (to < 0) continue;
    for (let i = 0; i < NONZERO_BUCKETS; i++) renaming[i * source.numCtxs + from] = i * target.numCtxs + to;
    for (let i = 0; i < ZERO_DENSITY_CONTEXTS; i++) renaming[source.numCtxs * NONZERO_BUCKETS + from * ZERO_DENSITY_CONTEXTS + i] = target.numCtxs * NONZERO_BUCKETS + to * ZERO_DENSITY_CONTEXTS + i;
  }
  return renaming;
}

function mergedCounts(source, counts, target) {
  const into = new Int16Array(source.numCtxs).fill(-1);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < ORDERS; ord++) for (let i = 0; i < source.numDc; i++)
    into[source.map[(row * ORDERS + ord) * source.numDc + i]] = target.map[(row * ORDERS + ord) * target.numDc + (target.numDc === 1 ? 0 : i)];
  const result = new TokenCounts(target.contexts);
  const add = (from, to) => {
    if (!counts.totals[from]) return;
    result.totals[to] += counts.totals[from];
    for (let v = 0; v < 64; v++) result.small[to * 64 + v] += counts.small[from * 64 + v];
    if (counts.large[from]) {
      const map = result.large[to] || (result.large[to] = new Map());
      for (const [value, count] of counts.large[from]) map.set(value, (map.get(value) || 0) + count);
    }
  };
  for (let from = 0; from < source.numCtxs; from++) {
    const to = into[from];
    if (to < 0) continue;
    for (let i = 0; i < NONZERO_BUCKETS; i++) add(i * source.numCtxs + from, i * target.numCtxs + to);
    for (let i = 0; i < ZERO_DENSITY_CONTEXTS; i++) add(source.numCtxs * NONZERO_BUCKETS + from * ZERO_DENSITY_CONTEXTS + i,
      target.numCtxs * NONZERO_BUCKETS + to * ZERO_DENSITY_CONTEXTS + i);
  }
  return result;
}

const PLAN_LIT_COUNTS = new Uint32Array(4096);
const PLAN_LIT_TOUCHED = new Uint16Array(4096);
const PLAN_SLOTS = [0, 0, 0];

function planModularChannel(plane, width, height, predictor, freq) {
  const n = width * height, tags = new Uint32Array(n), extra = new Uint32Array(n), lengths = new Uint32Array(33);
  const litCounts = PLAN_LIT_COUNTS, litTouched = PLAN_LIT_TOUCHED, slots = PLAN_SLOTS;
  let used = 0, run = 0, touchedLen = 0, overflow = null;
  const emitLiteral = value => {
    if (value === 0) {
      freq[0]++;
      tags[used] = 0; extra[used++] = 0;
    } else {
      const e = 31 - Math.clz32(value), s = e + 1;
      freq[s]++;
      tags[used] = s | (e << 9); extra[used++] = value - (1 << e);
    }
    if (value < 4096) {
      if (litCounts[value] === 0) litTouched[touchedLen++] = value;
      litCounts[value]++;
    } else {
      overflow ||= new Map();
      overflow.set(value, (overflow.get(value) || 0) + 1);
    }
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) {
      emitLiteral(0);
      hybridToken(RUN_CONFIG, run - MIN_RUN_LENGTH - 1, slots);
      const symbol = MIN_RUN_SYMBOL + slots[0];
      freq[symbol]++;
      tags[used] = symbol | (slots[1] << 9); extra[used++] = slots[2];
      lengths[slots[0]]++;
    } else {
      for (let i = 0; i < run; i++) emitLiteral(0);
    }
    run = 0;
  };
  if (predictor === GRADIENT_PREDICTOR) {
    for (let y = 0, index = 0; y < height; y++) {
      for (let x = 0; x < width; x++, index++) {
        let pred = 0;
        if (x | y) {
          const left = x ? plane[index - 1] : plane[index - width];
          const top = y ? plane[index - width] : left;
          const nw = x && y ? plane[index - width - 1] : left, grad = left + top - nw;
          const lo = left < top ? left : top, hi = left < top ? top : left;
          pred = grad < lo ? lo : grad > hi ? hi : grad;
        }
        const r = (plane[index] - pred) | 0;
        if (!r) run++;
        else { flush(); emitLiteral(r >= 0 ? r + r : -r - r - 1); }
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const r = plane[i] | 0;
      if (!r) run++;
      else { flush(); emitLiteral(r >= 0 ? r + r : -r - r - 1); }
    }
  }
  flush();
  const literalPairs = new Uint32Array((touchedLen + (overflow ? overflow.size : 0)) * 2);
  let p = 0;
  for (let i = 0; i < touchedLen; i++) {
    const v = litTouched[i], c = litCounts[v];
    litCounts[v] = 0;
    literalPairs[p++] = v; literalPairs[p++] = c;
  }
  if (overflow) for (const [v, c] of overflow) { literalPairs[p++] = v; literalPairs[p++] = c; }
  return {tags, extra, used, literalPairs, literalPairsLen: p, lengths};
}

function codeUniformRows(w, target, width, height, rowValues, leafNode) {
  const predictor = leafNode.predictor, config = leafNode.config || RESIDUAL_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (w) writeHybrid(w, target, tokenConfig, value, base);
    else countToken(tokenConfig, value, target, base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) { emit(0); emit(run - MIN_RUN_LENGTH - 1, RUN_CONFIG, MIN_RUN_SYMBOL); }
    else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  if (width > 0 && height > 0) {
    if (predictor === GRADIENT_PREDICTOR) {
      for (let y = 0; y < height; y++) {
        const v = rowValues[y], pred = y ? rowValues[y - 1] : 0, r = (v - pred) | 0;
        if (r === 0) run += width;
        else {
          flush();
          emit(r >= 0 ? r + r : -r - r - 1);
          run += width - 1;
        }
      }
    } else {
      for (let y = 0; y < height; y++) {
        const r = rowValues[y] | 0;
        if (r === 0) run += width;
        else {
          flush();
          const packed = r >= 0 ? r + r : -r - r - 1;
          for (let x = 0; x < width; x++) emit(packed);
        }
      }
    }
  }
  flush();
}

const codeMetadataPlane = (w, target, p, leafNode) => p.rowValues
  ? codeUniformRows(w, target, p.w, p.h, p.rowValues, leafNode)
  : codeChannel(w, target, p.data, p.w, p.h, leafNode);

function writeModularStream(w, planes, predictor, ans, kernels) {
  const leaves = planes.map(() => leaf(predictor));
  const freqs = leaves.map(() => new Uint32Array(ALPHABET));
  const plans = ans && planes.map((p, i) => planModularChannel(p.data, p.w, p.h, predictor, freqs[i]));
  if (!ans) planes.forEach((p, i) => codeMetadataPlane(null, freqs[i], p, leaves[i]));
  writeModularHeader(w, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(w, channelTree(leaves));
  const header = ans ? new BitWriter(256) : w;
  const histograms = writeChannelHistograms(header, ordered, freqs, l => leaves.indexOf(l));
  if (ans) {
    let prefixBits = header.bitLength;
    const models = plans.map((plan, c) => {
      const f = freqs[c], lengths = histograms[c + 1].code.lengths;
      for (let s = 0; s < lengths.length; s++) if (f[s]) prefixBits += f[s] * (lengths[s] + (s < 224 ? (s > 1 ? s - 1 : 0) : Math.max(0, s - 236)));
      const model = losslessCoding(plan)[1], cfg = model.config, slots = PLAN_SLOTS;
      if (cfg.split !== 0 || cfg.msb !== 0 || cfg.lsb !== 0) {
        const tags = plan.tags, extra = plan.extra, used = plan.used;
        for (let i = 0; i < used; i++) {
          const symbol = tags[i] & 511;
          if (symbol >= 224) continue;
          hybridToken(cfg, symbol ? ((1 << (symbol - 1)) >>> 0) + extra[i] : 0, slots);
          tags[i] = slots[0] | (slots[1] << 9); extra[i] = slots[2];
        }
      }
      plan.freqs = [model.freqs];
      return model;
    });
    const candidate = new BitWriter(256);
    const write = ans(candidate, ordered, models.map(model => model.freqs), l => leaves.indexOf(l), i => models[i].config, kernels);
    if (candidate.bitLength + write.measure(plans) < prefixBits) { write(plans); w.append(candidate); return; }
    w.append(header);
  }
  planes.forEach((p, i) => codeMetadataPlane(w, histograms[i + 1].code, p, leaves[i]));
}

function writeSmallerModularStream(w, planes, predictor) {
  const apart = new BitWriter(256), together = new BitWriter(256), one = leaf(predictor), freqs = [new Uint32Array(ALPHABET)];
  writeModularStream(apart, planes, predictor);
  for (const p of planes) codeMetadataPlane(null, freqs[0], p, one);
  writeModularHeader(together, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(together, one), histograms = writeChannelHistograms(together, ordered, freqs, () => 0);
  for (const p of planes) codeMetadataPlane(together, histograms[1].code, p, one);
  w.append(together.bitLength < apart.bitLength ? together : apart);
}

const QUANT_STREAM_CACHE = new WeakMap();
function writeCachedQuantMatrices(ac, comps) {
  const q0 = comps[0].quant, q1 = comps[1].quant, q2 = comps[2].quant;
  let m0 = QUANT_STREAM_CACHE.get(q0), m1 = m0?.get(q1), entry = m1?.get(q2);
  if (!entry) {
    const writer = new BitWriter(256);
    let wide = false;
    const planes = [0, 1, 2].map(c => {
      const data = new Int32Array(64), quant = comps[c].quant;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const value = quant[8 * y + x]; data[8 * x + y] = value;
        if (value < -32768 || value > 32767) wide = true;
      }
      return {w: 8, h: 8, data: wide ? data : Int16Array.from(data)};
    });
    writeSmallerModularStream(writer, planes, GRADIENT_PREDICTOR);
    entry = {writer, wide};
    if (!m0) QUANT_STREAM_CACHE.set(q0, m0 = new WeakMap());
    if (!m1) m0.set(q1, m1 = new WeakMap());
    m1.set(q2, entry);
  }
  ac.append(entry.writer);
  return entry.wide;
}


export function encodeVarDCT(jpeg, plan) { return complete(varDCTSteps(jpeg, plan)); }

export function walkACGroup(state, g, emit, pass = 0) {
  const {authoredOrderPasses, groupsX, strategyData, map, progression, contexts, lumaBuckets, lumaW, nzeros} = state;
  const authored = authoredOrderPasses?.[pass];
  const gx = g % groupsX, gy = (g / groupsX) | 0, bx0 = gx * 32, by0 = gy * 32;
  if (strategyData) {
    for (const block of strategyData.groups[g]) for (const c of [1, 0, 2]) {
      const {area, size, bw, bh} = block, order = authored?.byStrategy[block.id]?.[c] || block.order;
      const coeffs = block.coeffs[map[c]], bx = block.bx - bx0, by = block.by - by0;
      const coefficient = pos => progression ? progression.value(coeffs[pos], pos, Math.max(bw, bh) * 8, Math.min(bw, bh) * 8, pass) : coeffs[pos];
      let count = 0;
      for (let k = area; k < size; k++) if (coefficient(order[k])) count++;
      const row = nzeros[c], predicted = bx === 0 ? (by === 0 ? 32 : row[(by - 1) * 32]) : by === 0 ? row[bx - 1] :
        (row[(by - 1) * 32 + bx] + row[by * 32 + bx - 1] + 1) >> 1;
      const average = Math.ceil(count / area);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) row[(by + y) * 32 + bx + x] = average;
      const bucket = contexts.thresholds.length ? lumaBuckets[block.by * lumaW + block.bx] : 0;
      const blockCtx = contexts.contextOf(c, bucket, ORDER_OF[block.id]), offset = contexts.zeroDensityOffset(blockCtx);
      emit(contexts.nonZero(predicted, blockCtx), count);
      let prev = count > size / 16 ? 0 : 1, left = count;
      for (let k = area; k < size && left; k++) {
        const coeff = coefficient(order[k]);
        emit(offset + zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev), packSigned(coeff));
        prev = coeff ? 1 : 0; left -= prev;
      }
    }
    return;
  }
  const {ctxs, values} = state.tokenBuffer || tokenBuffer(), n = fillACGroup(state, g, pass, ctxs, values);
  for (let i = 0; i < n; i++) emit(ctxs[i], values[i]);
}

function fillStrategyGroup(state, g, pass, ctxs, values) {
  const {authoredOrderPasses, groupsX, strategyData, map, contexts, lumaBuckets, lumaW, nzeros} = state;
  const authored = authoredOrderPasses?.[pass], bucketed = contexts.thresholds.length > 0;
  const bx0 = g % groupsX * 32, by0 = ((g / groupsX) | 0) * 32;
  let n = 0;
  for (const block of strategyData.groups[g]) for (let i = 0; i < 3; i++) {
    const c = i === 0 ? 1 : i === 1 ? 0 : 2, {area, size, bw, bh} = block, order = authored?.byStrategy[block.id]?.[c] || block.order;
    const coeffs = block.coeffs[map[c]], bx = block.bx - bx0, by = block.by - by0;
    let count = 0;
    for (let k = area; k < size; k++) if (coeffs[order[k]]) count++;
    const row = nzeros[c], predicted = bx === 0 ? (by === 0 ? 32 : row[(by - 1) * 32]) : by === 0 ? row[bx - 1] :
      (row[(by - 1) * 32 + bx] + row[by * 32 + bx - 1] + 1) >> 1;
    const average = Math.ceil(count / area);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) row[(by + y) * 32 + bx + x] = average;
    const bucket = bucketed ? lumaBuckets[block.by * lumaW + block.bx] : 0;
    const blockCtx = contexts.contextOf(c, bucket, ORDER_OF[block.id]), offset = contexts.zeroDensityOffset(blockCtx);
    ctxs[n] = contexts.nonZero(predicted, blockCtx); values[n++] = count;
    let prev = count > size / 16 ? 0 : 1, left = count;
    for (let k = area; k < size && left; k++) {
      const coeff = coeffs[order[k]];
      ctxs[n] = offset + zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev); values[n++] = coeff >= 0 ? coeff * 2 : -coeff * 2 - 1;
      prev = coeff ? 1 : 0; left -= prev;
    }
  }
  return n;
}

let sharedTokens = null;
const tokenBuffer = () => sharedTokens ||= {ctxs: new Int32Array(GROUP_TOKENS), values: new Int32Array(GROUP_TOKENS)};
export function fillACGroup(state, g, pass, ctxs, values) {
  const {authoredOrderPasses, groupsX, progression, contexts, lumaBuckets, lumaW,
    nzeros, xsizeBlocks, ysizeBlocks, comps, grey, orders, counted, blockCounts, nonZero, hshifts, vshifts} = state;
  const authored = authoredOrderPasses?.[pass];
  const bx0 = g % groupsX * 32, by0 = ((g / groupsX) | 0) * 32;
  let n = 0;
  const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
  const {map: blockMap, numDc, numCtxs} = contexts, bucketed = contexts.thresholds.length > 0, zeroBase = numCtxs * NONZERO_BUCKETS;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (let i = 0; i < 3; i++) {
    const c = i === 0 ? 1 : i === 1 ? 0 : 2, hs = hshifts[c], vs = vshifts[c], sbx = bx >> hs, sby = by >> vs;
    if ((sbx << hs) !== bx || (sby << vs) !== by) continue;
    const comp = comps[c], coeffs = comp.coeffs, at = grey && c !== 1 ? -1 : (((by0 >> vs) + sby) * comp.stride + (bx0 >> hs) + sbx) * 64;
    let count = 0;
    if (at >= 0) {
      if (counted) count = blockCounts[c][at >> 6];
      else if (nonZero && !progression) { count = nonZero[c][at >> 6]; blockCounts[c][at >> 6] = count; }
      else {
        if (progression) {
          for (let k = 1; k < 64; k++) if (progression.value(coeffs[at + k], ((k & 7) << 3) | (k >> 3), 8, 8, pass)) count++;
        } else for (let k = 1; k < 64; k++) { const v = coeffs[at + k]; count += (v | -v) >>> 31; }
        blockCounts[c][at >> 6] = count;
      }
    }
    const row = nzeros[c], predicted = sbx === 0 ? (sby === 0 ? 32 : row[(sby - 1) * 32]) : sby === 0 ? row[sby * 32 + sbx - 1] : (row[(sby - 1) * 32 + sbx] + row[sby * 32 + sbx - 1] + 1) >> 1;
    row[sby * 32 + sbx] = count;
    const bucket = bucketed ? lumaBuckets[((by0 + by) >> vshifts[1]) * lumaW + ((bx0 + bx) >> hshifts[1])] : 0;
    const blockCtx = blockMap[(c < 2 ? c ^ 1 : 2) * ORDERS * numDc + bucket], capped = predicted < 64 ? predicted : 64;
    ctxs[n] = (capped < 8 ? capped : 4 + (capped >> 1)) * numCtxs + blockCtx; values[n++] = count;
    const offset = zeroBase + ZERO_DENSITY_CONTEXTS * blockCtx;
    const coefficientOrder = authored?.ordinary?.[c] || orders[c];
    let prev = count > 4 ? 0 : 1, left = count;
    for (let k = 1; k < 64 && left; k++) {
      const pos = coefficientOrder[k], coeff = progression ? progression.value(coeffs[at + pos], ((pos & 7) << 3) | (pos >> 3), 8, 8, pass) : coeffs[at + pos];
      ctxs[n] = offset + DCT8_DENSITY[left << 6 | k] + prev; values[n++] = coeff >= 0 ? coeff * 2 : -coeff * 2 - 1;
      prev = coeff ? 1 : 0; left -= prev;
    }
  }
  return n;
}

export function* varDCTSteps(jpeg, plan = {}, shared) {
  if (shared && shared.jpeg !== jpeg) Object.assign(shared, {jpeg, blockCounts: null, countedByOrder: null, tokensByOrder: null, tokenStore: null, dcSections: null, ansDcSections: null, lfSections: null, acSections: null, modularAns: null, lfCoder: null, modular16bit: true});
  let modular16bit = (shared?.modular16bit ?? true) && jpeg.modular16bit !== false;
  const {width, height, components, alpha, auxiliary, xyb, strategyData, progression, noiseLut, splineBits, useDCFrame, authoredOrderPasses} = jpeg, grey = components.length === 1;
  const numPasses = progression?.count || 1;
  const epf = xyb ? jpeg.epf || 0 : 0;
  const quantScale = jpeg.quantScale || 1;
  let field = jpeg.quantFieldBase || 1, shift = 1;
  while (field / (8 * 255 * quantScale) < 1 / 16384) { field *= 2; shift *= 2; }
  const ycbcr = !xyb && (jpeg.ycbcr || grey);
  const map = grey ? [0, 0, 0] : ycbcr ? [1, 0, 2] : [0, 1, 2];
  const comps = map.map(i => components[i]);
  const hasOrders = Boolean(plan.orders && !authoredOrderPasses && map.some(i => plan.orders[i].some((k, r) => k !== r)));
  const orders = hasOrders ? map.map(i => plan.orders[i].map(k => SCAN[k])) : [SCAN, SCAN, SCAN];
  const log2 = v => v === 1 ? 0 : v === 2 ? 1 : -1;
  const minH = Math.min(...comps.map(c => c.h)), minV = Math.min(...comps.map(c => c.v));
  const rawH = comps.map(c => c.h % minH ? -1 : log2(c.h / minH)), rawV = comps.map(c => c.v % minV ? -1 : log2(c.v / minV));
  if (rawH.includes(-1) || rawV.includes(-1)) throw jpegError('sampling factors other than one or two');
  const maxhs = Math.max(...rawH), maxvs = Math.max(...rawV);
  const hshift = c => maxhs - rawH[c], vshift = c => maxvs - rawV[c];
  if (!ycbcr && (maxhs || maxvs)) throw jpegError('an RGB JPEG with subsampling');
  const xsizeBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, ysizeBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1 && numPasses === 1;
  const blockAt = (c, bx, by) => { const comp = comps[c]; if (grey && c !== 1) return -1; return ((by * comp.stride) + bx) * 64; };
  const sharpnessOf = (x0, y0, rw, rh) => {
    const out = new Int16Array(rw * rh).fill(7), own = jpeg.sharpness;
    if (own) for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) out[y * rw + x] = own[(y0 + y) * xsizeBlocks + x0 + x];
    return out;
  };
  const dcAt = (c, bx, by) => strategyData || comps[c].dc ? comps[c].dc[by * comps[c].stride + bx] :
    blockAt(c, bx, by) < 0 ? 0 : comps[c].coeffs[blockAt(c, bx, by)];
  if (strategyData && (maxhs || maxvs || plan.orders && !authoredOrderPasses)) throw jpegError('variable transforms with subsampling or DCT8-only learned orders');

  const jpegReconstruction = jpeg.jpegReconstruction === true;
  const gcd1024 = q => { let d = 1024; while (q % d) d >>= 1; return d; };
  const dcScale = comps.map(c => ycbcr || xyb || jpegReconstruction ? 1 : c.quant[0] / gcd1024(c.quant[0]));
  const dcLift = comps.map(c => ycbcr || xyb ? 0 : jpegReconstruction ? Math.floor(1024 / c.quant[0]) : 1024 / gcd1024(c.quant[0]));
  const kernels = kernelHooks.entropy?.();
  const dcGroup = g => {
    const lfCoder = plan.lfCoder;
    const w = new BitWriter(4096), gx = g % dcGroupsX, gy = (g / dcGroupsX) | 0;
    const x0 = gx * 256, y0 = gy * 256, rw = Math.min(256, xsizeBlocks - x0), rh = Math.min(256, ysizeBlocks - y0);
    if (!useDCFrame) {
    w.write(2, 0);
    const planes = [1, 0, 2].map(c => {
      const pw = rw >> hshift(c), ph = rh >> vshift(c), scale = dcScale[c], lift = dcLift[c];
      let data = new Int16Array(pw * ph);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        const value = dcAt(c, (x0 >> hshift(c)) + x, (y0 >> vshift(c)) + y) * scale + lift;
        if (value < -32768 || value > 32767) {
          modular16bit = false;
          if (data instanceof Int16Array) data = Int32Array.from(data);
        }
        data[y * pw + x] = value;
      }
      return {w: pw, h: ph, data};
    });
    const plainDc = target => writeModularStream(target, planes, GRADIENT_PREDICTOR, plan.modularAns, kernels);
    if (lfCoder) lfCoder.dc(w, planes, plainDc, kernels); else plainDc(w);
    }
    auxiliary?.group(w, gx * 2048, gy * 2048, 2048, 3, Infinity);
    const regionBlocks = strategyData && strategyData.blocks.filter(block => block.bx >= x0 && block.bx < x0 + rw && block.by >= y0 && block.by < y0 + rh)
      .sort((a, b) => a.by - b.by || a.bx - b.bx);
    const count = regionBlocks ? regionBlocks.length : rw * rh, bits = ceilLog2(rw * rh);
    if (bits) w.write(bits, count - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    const uniformBlocks = !lfCoder && !regionBlocks && !jpeg.quantFields;
    const uniformSharpness = !lfCoder && !jpeg.sharpness;
    let blocks = null;
    if (!uniformBlocks) {
      blocks = new Int32Array(count * 2).fill(field - 1, count);
      if (regionBlocks) for (let i = 0; i < count; i++) blocks[i] = regionBlocks[i].id;
      if (jpeg.quantFields && regionBlocks) for (let i = 0; i < count; i++) {
        const block = regionBlocks[i], value = jpeg.quantFields[block.by * xsizeBlocks + block.bx] * shift - 1;
        blocks[count + i] = value;
        if (value < -32768 || value > 32767) modular16bit = false;
      }
      else if (jpeg.quantFields) for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const value = jpeg.quantFields[(y0 + y) * xsizeBlocks + x0 + x] * shift - 1;
        blocks[count + y * rw + x] = value;
        if (value < -32768 || value > 32767) modular16bit = false;
      }
      else if (field - 1 < -32768 || field - 1 > 32767) modular16bit = false;
    } else if (field - 1 < -32768 || field - 1 > 32767) modular16bit = false;
    const colors = [new Int16Array(cw * ch), new Int16Array(cw * ch)];
    if (xyb && jpeg.cfl) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const at = ((y0 >> 3) + y) * jpeg.cfl.width + (x0 >> 3) + x;
      colors[0][y * cw + x] = jpeg.cfl.x[at]; colors[1][y * cw + x] = jpeg.cfl.b[at];
    }
    const sharpVal = epf ? 7 : 0;
    const metadata = [
      {w: cw, h: ch, data: colors[0]}, {w: cw, h: ch, data: colors[1]},
      uniformBlocks ? {w: count, h: 2, rowValues: [0, field - 1]} : {w: count, h: 2, data: blocks},
      uniformSharpness ? {w: rw, h: rh, rowValues: new Int16Array(rh).fill(sharpVal)} : {w: rw, h: rh, data: epf ? sharpnessOf(x0, y0, rw, rh) : new Int16Array(rw * rh)},
    ];
    const plainMetadata = target => writeSmallerModularStream(target, metadata, field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
    if (lfCoder) lfCoder.metadata(w, metadata, plainMetadata, kernels); else plainMetadata(w);
    return w;
  };
  if (plan.lfGroup !== undefined) {
    const narrow = modular16bit, w = dcGroup(plan.lfGroup);
    return {bytes: w.bytes.slice(0, w.at), at: w.at, pending: w.pending, acc: w.acc, wide: narrow && !modular16bit};
  }
  const lumaW = xsizeBlocks >> hshift(1), lumaH = ysizeBlocks >> vshift(1);
  const fast = !!plan.fast;
  const lumaDc = new Int32Array(fast ? 0 : lumaW * lumaH);
  if (!fast) for (let by = 0; by < lumaH; by++) for (let bx = 0; bx < lumaW; bx++) lumaDc[by * lumaW + bx] = dcAt(1, bx, by) * dcScale[1] + dcLift[1];
  const lumaQuant = comps[1].quant, quantSum = (lumaQuant[8] + lumaQuant[16] + lumaQuant[24] + lumaQuant[32] + lumaQuant[40]) / quantScale;
  const blocksTotal = xsizeBlocks * ysizeBlocks;
  const wanted = fast || useDCFrame || blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - (xyb ? 6 : 7)));
  const designs = strategyData ? (plan.richContexts ? ['dcBuckets', 'sizes', 'sizesShared', 'sizes3', 'sizes3Shared', 'sizesDc'] : ['dcBuckets', 'sizes', 'sizesShared']) : ['dcBuckets'];
  let contexts = !strategyData && wanted === 0 ? (grey ? FAST_CONTEXTS_GREY : FAST_CONTEXTS_RGB) : blockContexts(lumaDc, wanted, grey, strategyData ? DESIGNS.fine(grey) : undefined);
  const lumaBuckets = new Uint8Array(lumaDc.length), bucketOf = contexts.bucketOf;
  for (let i = 0; i < lumaDc.length; i++) lumaBuckets[i] = bucketOf(lumaDc[i]);
  let contextHeader = null;

  const nzeros = [0, 1, 2].map(() => new Int32Array(32 * 32));
  const fastBlockCounts = !progression && !grey && jpeg.nonZero ? map.map(i => jpeg.nonZero[i]) : null;
  let counted = !progression && !!(shared?.blockCounts || fastBlockCounts);
  const blockCounts = shared?.blockCounts || fastBlockCounts || comps.map((comp, c) => grey && c !== 1 ? null : new Uint8Array(comp.coeffs.length / 64));
  const buffer = strategyData && progression ? null : tokenBuffer();
  const tokenState = () => ({authoredOrderPasses, groupsX, strategyData, map, progression, contexts, lumaBuckets, lumaW,
    nzeros, xsizeBlocks, ysizeBlocks, comps, grey, orders, counted, blockCounts, nonZero: jpeg.nonZero, tokenBuffer: buffer,
    hshifts: [0, 1, 2].map(hshift), vshifts: [0, 1, 2].map(vshift)});
  const tokens = (g, emit, pass = 0) => walkACGroup(tokenState(), g, emit, pass);
  let kept = null, renaming = null;
  const fill = (g, pass) => {
    const state = tokenState();
    if (strategyData) {
      const n = kernelHooks.strategyFill?.(state, g, pass, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF, buffer.ctxs, buffer.values);
      return [n ?? fillStrategyGroup(state, g, pass, buffer.ctxs, buffer.values), buffer.ctxs, buffer.values];
    }
    const filled = kernels?.fill(state, g, pass, DCT8_DENSITY);
    return filled || [fillACGroup(state, g, pass, buffer.ctxs, buffer.values), buffer.ctxs, buffer.values];
  };
  const countTokens = (g, into, pass) => {
    if (kernelHooks.acGroup?.(tokenState(), g, pass, {counts: into, coding: null, w: null}, DCT8_DENSITY)) return;
    if (!buffer) { tokens(g, (ctx, value) => into.add(ctx, value), pass); return; }
    const [n, ctxs, values] = fill(g, pass);
    if (!(ctxs.buffer !== buffer.ctxs.buffer && kernels.countFilled(into, n))) into.addTokens(ctxs, values, n);
    if (kept && !kernels && !strategyData) kept[g] = shared.tokenStore.keep({ctxs, values}, n);
  };
  const writeTokens = (g, coding, w, pass) => {
    const written = kernelHooks.acGroup?.(tokenState(), g, pass, {counts: null, coding, w}, DCT8_DENSITY);
    if (written) return written;
    if (strategyData && !progression) {
      const flushed = kernelHooks.strategyWrite?.(tokenState(), g, pass, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF, coding, w);
      if (flushed) return flushed;
    }
    if (!buffer || !coding.writeTokens) { tokens(g, (ctx, value) => coding.write(w, ctx, value), pass); return; }
    if (coding.writeFilled && !strategyData) {
      const filled = kernels.fill(tokenState(), g, pass, DCT8_DENSITY);
      if (filled) { coding.writeFilled(w, filled[0]); return; }
    }
    const group = kept?.[g];
    if (!group || renaming === false) {
      const [n, ctxs, values] = fill(g, pass);
      if (kept && !kernels && !strategyData && !renaming && !progression) kept[g] = shared.tokenStore.keep({ctxs, values}, n);
      coding.writeTokens(w, ctxs, values, n);
      return;
    }
    if (!renaming) { coding.writeTokens(w, group.ctxs, group.values, group.ctxs.length); return; }
    const ctxs = buffer.ctxs, n = group.ctxs.length;
    for (let i = 0; i < n; i++) ctxs[i] = renaming[group.ctxs[i]];
    coding.writeTokens(w, ctxs, group.values, n);
  };
  const total = 2 * numGroups * numPasses + numDcGroups;
  let done = 0;
  const countedByOrder = shared && !progression ? (shared.countedByOrder ||= new Map()) : null;
  const orderKey = authoredOrderPasses || (hasOrders ? plan.orders : null);
  const buildCoding = plan.coding || buildTokenCoding, reuse = countedByOrder?.get(orderKey);
  const counts = reuse || Array.from({length: numPasses}, () => new TokenCounts(contexts.contexts));
  const tokensByOrder = buffer && countedByOrder ? (shared.tokensByOrder ||= new Map()) : null;
  kept = tokensByOrder?.get(orderKey) || null;
  if ((!reuse || !kept) && tokensByOrder) { tokensByOrder.clear(); (shared.tokenStore ||= tokenStore()).reset(); kept = []; tokensByOrder.set(orderKey, kept); }
  if (plan.countGroups) {
    for (let g = plan.countGroups[0]; g < plan.countGroups[1]; g++) countTokens(g, counts[0], 0);
    return {counts: counts[0], blockCounts};
  }
  const parts = offloading() && !reuse && !progression && !plan.pooled && numGroups > 1 && (yield {offload: 'run', task: {kind: 'count', image: jpeg, plan, groups: numGroups}, at: () => done / total});
  if (reuse) { done += numGroups * numPasses; yield done / total; }
  else if (parts) {
    for (const part of parts) {
      counts[0].merge(part.counts);
      part.blockCounts.forEach((from, c) => { const into = blockCounts[c]; if (from) for (let i = 0; i < from.length; i++) if (from[i] > into[i]) into[i] = from[i]; });
    }
    done += numGroups; yield done / total;
  }
  else for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g++) {
    countTokens(g, counts[p], p); yield ++done / total;
  }
  if (countedByOrder) countedByOrder.set(orderKey, counts);
  counted = !progression;
  if (shared && !progression) shared.blockCounts = blockCounts;
  let codings = null;
  const countedMap = contexts;
  for (const name of designs) for (const buckets of plan.fast ? [wanted] : wanted > 0 && name === 'dcBuckets' ? [0, wanted] : wanted > 0 && name === 'sizesDc' ? [wanted] : [0]) {
    const fastDefault = name === 'dcBuckets' && buckets === 0;
    const candidate = fastDefault ? (grey ? FAST_CONTEXTS_GREY : FAST_CONTEXTS_RGB) : blockContexts(lumaDc, buckets, grey, DESIGNS[name](grey));
    if (candidate.numCtxs > 16) continue;
    const same = candidate === countedMap || (candidate.numCtxs === countedMap.numCtxs && candidate.numDc === countedMap.numDc && candidate.map.every((v, i) => v === countedMap.map[i]));
    const candidateCodings = counts.map(count => buildCoding(same ? count : mergedCounts(countedMap, count, candidate), {...plan.clusters, smallestMap: true, kernels}));
    let header;
    if (fastDefault) header = grey ? FAST_HEADER_GREY : FAST_HEADER_RGB;
    else { header = new BitWriter(128); writeBlockContexts(header, candidate); }
    if (!codings || candidateCodings.reduce((n, coding) => n + coding.bits, header.bitLength) < codings.reduce((n, coding) => n + coding.bits, contextHeader.bitLength)) {
      codings = candidateCodings; contexts = candidate; contextHeader = header;
    }
  }
  const sameMap = contexts === countedMap || (contexts.numDc === countedMap.numDc && contexts.numCtxs === countedMap.numCtxs && contexts.map.every((v, i) => v === countedMap.map[i]));
  if (kept) renaming = sameMap ? null : contextRenaming(countedMap, contexts);
  if (plan.writeGroups) {
    const coding = codings[0], written = [];
    for (let g = plan.writeGroups[0]; g < plan.writeGroups[1]; g++) {
      const w = new BitWriter(4096);
      writeTokens(g, coding, w, 0);
      if (coding.flush) coding.flush(w);
      written.push({bytes: w.bytes.slice(0, w.at + 1), at: w.at, pending: w.pending, acc: w.acc});
    }
    return written;
  }

  const writers = Array.from({length: single ? 1 : 2 + numDcGroups + numGroups * numPasses}, () => null);
  const section = index => writers[single ? 0 : index] || (writers[single ? 0 : index] = new BitWriter(4096));
  const sectionSizes = new Uint32Array(writers.length);
  let sectionBytes = 0;
  const checkSection = index => {
    index = single ? 0 : index;
    const size = Math.ceil(writers[index].bitLength / 8);
    sectionBytes += size - sectionSizes[index]; sectionSizes[index] = size;
    admitOutputSize(sectionBytes);
  };

  const dc = section(0);
  if (splineBits) dc.append(splineBits);
  if (noiseLut) for (const value of noiseLut) dc.write(10, Math.round(value * 1024));
  dc.write(1, 0);

  const alphaPlane = (gx, gy) => {
    const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0), data = new Int16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = alpha[((y0 + y) * width + x0 + x) * 4 + 3];
    return {w, h, data};
  };
  for (let c = 0; c < 3; c++) dc.write(16, float16Bits(comps[c].quant[0] / dcScale[c] / (255 * 8 * quantScale) * 128));
  dc.write(2, 3); dc.write(16, 65536 - 8193);
  dc.write(2, 1); dc.write(5, 0);
  dc.write(1, 0); dc.write(4, 0);
  dc.append(contextHeader);
  if (xyb) dc.write(1, 1);
  else { dc.write(1, 0); dc.write(2, 0); dc.write(16, 0); dc.write(16, 0); dc.write(8, 128); dc.write(8, 128); }
  dc.write(1, 0);
  if (auxiliary) auxiliary.global(dc);
  else if (alpha) writeModularStream(dc, [numGroups === 1 ? alphaPlane(0, 0) : {w: 0, h: 0, data: new Int32Array(0)}], GRADIENT_PREDICTOR);
  checkSection(0);

  if (shared && plan.modularAns && shared.modularAns !== plan.modularAns) { shared.ansDcSections = null; shared.modularAns = plan.modularAns; }
  const lfCoder = plan.lfCoder;
  if (shared && lfCoder && shared.lfCoder !== lfCoder) { shared.lfSections = null; shared.lfCoder = lfCoder; }
  const sectionKey = lfCoder ? 'lfSections' : plan.modularAns ? 'ansDcSections' : 'dcSections';
  let dcSections = shared && (shared[sectionKey] || (shared[sectionKey] = []));
  let lfEntry = null;
  if (lfCoder && plan.modularAns) {
    lfEntry = lfEntryOf(jpeg, plan);
    dcSections = lfEntry.sections;
    if (shared) shared[sectionKey] = dcSections;
    if (lfEntry.wide) modular16bit = false;
  }
  const narrowBefore = modular16bit;
  const dcTask = g => ({kind: 'lf', image: jpeg, plan, g}), missing = offloading() ? Array.from({length: numDcGroups}, (_, g) => g).filter(g => !dcSections?.[g]) : [];
  if (missing.length) yield {offload: 'prefetch', tasks: missing.map(dcTask), at: () => done / total};
  for (let g = 0; g < numDcGroups; g++) {
    if (dcSections?.[g]) {
      section(1 + g).append(dcSections[g]); checkSection(1 + g); yield ++done / total; continue;
    }
    const remote = missing.length && (yield {offload: 'run', task: dcTask(g), at: () => done / total});
    if (remote?.wide) modular16bit = false;
    const w = remote ? Object.assign(new BitWriter(0), {bytes: remote.bytes, at: remote.at, pending: remote.pending, acc: remote.acc}) : dcGroup(g);
    section(1 + g).append(w); checkSection(1 + g);
    if (dcSections) { w.bytes = w.bytes.slice(0, w.at); dcSections[g] = w; }
    if (shared) shared.modular16bit = modular16bit;
    if (lfEntry && narrowBefore && !modular16bit) lfEntry.wide = true;
    yield ++done / total;
  }

  const ac = section(1 + numDcGroups);
  ac.write(1, 0);
  for (let i = 0; i < 17; i++) {
    const table = strategyData?.tables.get(i);
    if (strategyData ? !table : i !== 0) { ac.write(3, 0); continue; }
    if (table?.parameters) { table.parameters.write(ac, map); continue; }
    ac.write(3, 7); ac.write(16, float16Bits(field / (8 * 255 * quantScale)));
    if (!table) {
      if (writeCachedQuantMatrices(ac, comps)) modular16bit = false;
      continue;
    }
    writeSmallerModularStream(ac, [0, 1, 2].map(c => {
      const data = table.planes[map[c]];
      for (const value of data) if (value < -32768 || value > 32767) modular16bit = false;
      return {w: table.h, h: table.w, data};
    }), table.w !== table.h ? ZERO_PREDICTOR : GRADIENT_PREDICTOR);
  }
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  for (let pass = 0; pass < codings.length; pass++) {
  const coding = codings[pass];
  if (authoredOrderPasses) ac.append(authoredOrderPasses[pass].header);
  else if (hasOrders) {
    ac.writeU32([[0, 95], [0, 19], [0, 0], [13, 0]], 1);
    const values = [];
    for (const c of map) {
      const available = Array.from({length: 64}, (_, k) => k), lehmer = plan.orders[c].map(k => {
        const at = available.indexOf(k); available.splice(at, 1); return at;
      });
      let end = 64;
      while (end > 1 && !lehmer[end - 1]) end--;
      values.push(end - 1, ...lehmer.slice(1, end));
    }
    const config = uintConfig(0), freqs = new Uint32Array(64);
    for (const value of values) countToken(config, value, freqs);
    const code = buildCode(freqs);
    writeHistograms(ac, {contextMap: new Uint8Array(8), histograms: [{config, code}]});
    for (const value of values) writeHybrid(ac, code, config, value);
  } else ac.write(2, 2);
  if (coding.writeHistograms) coding.writeHistograms(ac);
  else writeHistograms(ac, {contextMap: coding.contextMap, histograms: coding.histograms});
  }
  checkSection(1 + numDcGroups);
  if (shared) shared.modular16bit = modular16bit;
  if (plan.estimate && codings.every(coding => coding.payloadBits !== undefined))
    return Math.ceil(sectionBytes + codings.reduce((n, coding) => n + coding.payloadBits, 0) / 8 + 4 * numGroups * numPasses);

  const reuseAC = shared?.acCoding === buildCoding && !single && !progression && !auxiliary && !plan.pooled && !plan.estimate;
  const acKey = reuseAC ? {global: ac.finish(), globalBits: ac.bitLength, contexts: contextHeader.finish(), contextBits: contextHeader.bitLength,
    coder: buildCoding, entropy: kernelHooks.entropy, group: kernelHooks.acGroup} : null;
  let cachedAC = acKey && shared.acSections;
  if (cachedAC && (cachedAC.coder !== acKey.coder || cachedAC.entropy !== acKey.entropy || cachedAC.group !== acKey.group ||
      cachedAC.globalBits !== acKey.globalBits || cachedAC.contextBits !== acKey.contextBits ||
      !acKey.global.every((v, i) => v === cachedAC.global[i]) || !acKey.contexts.every((v, i) => v === cachedAC.contexts[i]))) cachedAC = null;
  if (shared) shared.acSections = null;

  const groupSamples = values => values != null && (Object.getPrototypeOf(values) === Int16Array.prototype || Object.getPrototypeOf(values) === Int32Array.prototype);
  const boundedGroups = (plan.pooled || offloading()) && (strategyData ? strategyData.blocks.every(block => block.coeffs.every(groupSamples)) : comps.every(comp => groupSamples(comp.coeffs)));
  let reply;
  if (!cachedAC && boundedGroups && numGroups > 1 && !progression && !auxiliary && codings[0].model) {
    const coding = codings[0], hshifts = [0, 1, 2].map(hshift), vshifts = [0, 1, 2].map(vshift);
    const model = {coding: coding.model, grey, orders, hshifts, vshifts,
      authoredOrderPasses: authoredOrderPasses?.map(({byStrategy, ordinary}) => ({byStrategy, ordinary})),
      contexts: {thresholds: contexts.thresholds, map: contexts.map, numDc: contexts.numDc, numCtxs: contexts.numCtxs}};
    const job = (g, maxInputBytes = Infinity) => {
      const bx0 = g % groupsX * 32, by0 = Math.floor(g / groupsX) * 32;
      const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
      const lw = bw >> hshift(1), lh = bh >> vshift(1);
      let inputBytes = lw * lh;
      if (strategyData) {
        const orders = new Set();
        for (const block of strategyData.groups[g]) {
          for (const c of map) inputBytes += TYPED_LENGTH.call(block.coeffs[c]) * (block.coeffs[c] instanceof Int16Array ? 2 : 4);
          if (ArrayBuffer.isView(block.order)) {
            const buffer = TYPED_BUFFER.call(block.order);
            if (!orders.has(buffer)) { orders.add(buffer); inputBytes += BUFFER_LENGTH.call(buffer); }
          }
        }
      } else for (let c = 0; c < comps.length; c++) {
        if (grey && c !== 1) continue;
        inputBytes += (bw >> hshift(c)) * (bh >> vshift(c)) * (64 * (comps[c].coeffs instanceof Int16Array ? 2 : 4) + 1);
      }
      if (maxInputBytes !== Infinity && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) ||
          !Number.isSafeInteger(inputBytes) || inputBytes > maxInputBytes)
        throw Object.assign(new RangeError('AC group exceeds its input reservation.'), {code: 'JXL_MEMORY'});
      const buckets = new Uint8Array(lw * lh);
      for (let y = 0; y < lh; y++) {
        const from = ((by0 >> vshift(1)) + y) * lumaW + (bx0 >> hshift(1));
        buckets.set(lumaBuckets.subarray(from, from + lw), y * lw);
      }
      const transfer = [buckets.buffer], data = {xsizeBlocks: bw, ysizeBlocks: bh, lumaW: lw, lumaBuckets: buckets};
      if (strategyData) {
        data.strategyData = {groups: [strategyData.groups[g].map(block => {
          const coeffs = map.map(c => {
            const values = block.coeffs[c], copy = values instanceof Int16Array ? new Int16Array(values) : new Int32Array(values);
            transfer.push(copy.buffer); return copy;
          });
          const {id, area, size, bw, bh, order} = block;
          return {id, area, size, bw, bh, order, bx: block.bx - bx0, by: block.by - by0, coeffs};
        })]};
      } else {
        data.blockCounts = [];
        data.comps = comps.map((comp, c) => {
          const rw = bw >> hshift(c), rh = bh >> vshift(c);
          if (grey && c !== 1) { data.blockCounts.push(null); return {stride: rw, coeffs: new Int16Array(0)}; }
          const coeffs = comp.coeffs instanceof Int16Array ? new Int16Array(rw * rh * 64) : new Int32Array(rw * rh * 64), counts = new Uint8Array(rw * rh);
          for (let y = 0; y < rh; y++) {
            const from = ((by0 >> vshift(c)) + y) * comp.stride + (bx0 >> hshift(c));
            coeffs.set(comp.coeffs.subarray(from * 64, (from + rw) * 64), y * rw * 64);
            counts.set(blockCounts[c].subarray(from, from + rw), y * rw);
          }
          data.blockCounts.push(counts); transfer.push(coeffs.buffer, counts.buffer);
          return {stride: rw, coeffs};
        });
      }
      return {data, transfer};
    };
    reply = yield {kind: 'ac-group', offload: plan.pooled ? undefined : 'groups', image: jpeg, plan, groups: numGroups, model, job,
      local(g) {
        try {
          const w = new BitWriter(4096);
          if (writeTokens(g, coding, w, 0) !== 2) coding.flush?.(w); return w;
        } finally { coding.reset?.(); }
      },
      at: g => (done + g + 1) / total, stop: g => plan.abortable && g + 1 < numGroups};
    if (reply instanceof Error) throw reply;
    if (!reply && plan.pooled) return null;
    if (reply) for (let g = 0; g < numGroups; g++) {
      if (Object.hasOwn(reply.errors, g)) throw reply.errors[g];
      const index = 2 + numDcGroups + g, w = Object.assign(new BitWriter(0), reply.results[g]);
      reply.results[g] = null;
      writers[index] = w;
      if (alpha) writeModularStream(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))], GRADIENT_PREDICTOR);
      checkSection(index);
    }
    if (reply) done += numGroups;
  }
  if (cachedAC) for (let g = 0; g < numGroups; g++) {
    const index = 2 + numDcGroups + g, bytes = cachedAC.groups[g];
    writers[index] = Object.assign(new BitWriter(0), {bytes, at: bytes.length});
    checkSection(index); yield ++done / total;
  }
  if (!cachedAC && !reply) {
  for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g++) {
    const index = 2 + numDcGroups + p * numGroups + g, w = section(index), coding = codings[p];
    if (writeTokens(g, coding, w, p) !== 2 && coding.flush) coding.flush(w);
    if (auxiliary) {
      const bracket = progression?.brackets[p] ?? {minimum: 0, maximum: 2};
      auxiliary.group(w, g % groupsX * GROUP_DIM, Math.floor(g / groupsX) * GROUP_DIM, GROUP_DIM, bracket.minimum, bracket.maximum);
    }
    else if (alpha && numGroups > 1 && p === (progression?.alphaPass ?? 0)) writeModularStream(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))], GRADIENT_PREDICTOR);
    checkSection(index);
    yield ++done / total;
  }
  }
  const header = new BitWriter(256);
  if (jpeg.frameHeader) jpeg.frameHeader(header);
  else {
  writeImageHeader(header, jpeg.canvasWidth ?? width, jpeg.canvasHeight ?? height, grey ? 1 : 3, !!alpha, {xyb, orientation: jpeg.orientation, colorSpace: jpeg.colorSpace, modular16bit, ...jpeg.profile});
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, 128 + (noiseLut ? 1 : 0) + (splineBits ? 16 : 0) + (useDCFrame ? 32 : 0) - 17);
  if (!xyb) header.write(1, ycbcr ? 1 : 0);
  if (!useDCFrame) {
  if (ycbcr) for (let c = 0; c < 3; c++) header.write(2, rawH[c] === 0 && rawV[c] === 0 ? 0 : rawH[c] === 1 && rawV[c] === 1 ? 1 : rawH[c] === 1 ? 2 : 3);
  header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  if (auxiliary) for (const factor of auxiliary.factors) header.write(2, [1, 2, 4, 8].indexOf(factor));
  else if (alpha) header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  }
  if (xyb) { header.write(3, 2); header.write(3, 2); }
  writeFrameHeaderEnd(header, auxiliary?.count ?? alpha, epf, progression?.header, jpeg.epfIterations, xyb ? jpeg.gab : null);
  }
  const sections = finishSections(writers), bytes = assembleCodestream(header, sections, jpeg.level ?? 5);
  if (acKey && bytes.length + acKey.global.length + acKey.contexts.length <= components.reduce((n, c) => n + (c.coeffs?.byteLength ?? 0), 0)) {
    const groups = [], first = 2 + numDcGroups;
    let at = bytes.length - sections.slice(first).reduce((n, section) => n + section.length, 0);
    for (let g = first; g < sections.length; g++) { groups.push(bytes.subarray(at, at + sections[g].length)); at += sections[g].length; }
    shared.acSections = {...acKey, groups};
  }
  return bytes;
}
