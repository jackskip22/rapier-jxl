// Rapier's JPEG XL encoder: a JPEG carried into a VarDCT frame. MIT (images/jxl/LICENSE).
import {shown} from './photo-shown.mjs';
import {varDCTField, varDCTDCSpec, copyVarDCTDCRows, copyVarDCTSharpness, copyVarDCTStrategies, copyVarDCTStrategyFields, copyVarDCTFieldRows, copyVarDCTCorrelation, copyVarDCTAlphaRows, copyVarDCTQuantRows, rawStepShift, varDCTLFGeometry, varDCTLFMetadataShape} from './vardct-planes.mjs';
import {varDCTLayout, writeVarDCTHeader, writeVarDCTDCFields, writeVarDCTOrders, varDCTContextBuckets} from './vardct-header.mjs';
import {writeQuantParams, photoDCT8Table} from './quantization-params.mjs';
import {ORDER_STRATEGY_BUCKETS as ORDER_OF} from './coefficient-orders.mjs';
import {countACRanks, emitACRanks, predictDCT8NonZero} from './vardct-ranks.mjs';
import {blockContexts, contextsFromThresholds, acContexts, writeBlockContexts, write3DBlockContexts, learn3DBlockContexts, DESIGNS} from './vardct-contexts.mjs';
export {blockContexts, acContexts} from './vardct-contexts.mjs';
import {kernelHooks, ensured, missing, declined} from './kernel-hooks.mjs';
import {BitWriter, float16Bits, ceilLog2, complete} from './bits.mjs';
import {finishSections, assembleCodestream, writeTOC, codestreamFromParts, GROUP_DIM, GROUP_TOKENS, varDCTSectionCount} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, MIN_RUN_SYMBOL, MIN_RUN_LENGTH, RUN_CONFIG, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeMetadataPlane, writeModularStream as plainModularStream, writeSmallerModularStream} from './modular-channel.mjs';
import {writeHistograms} from './prefix.mjs';
import {TokenCounts, buildTokenCoding, tokenCountsData, tokenCountsFrom} from './entropy.mjs';
import {NONZERO_BUCKETS, ZERO_DENSITY_CONTEXTS, ORDERS, COEFF_FREQ_CONTEXT, COEFF_NUM_NONZERO_CONTEXT, SCAN, zeroDensityContext, DCT8_DENSITY} from './dct8-contexts.mjs';
export {COEFF_FREQ_CONTEXT, COEFF_NUM_NONZERO_CONTEXT, SCAN, zeroDensityContext, DCT8_DENSITY} from './dct8-contexts.mjs';
import {admitOutputSize, fault} from './admit.mjs';
import {unit, carried, stage, PASSED, journaling, journalTool, journalJoin, sliceBytes} from './step-journal.mjs';
import {losslessCoding} from './lossless-coding.mjs';
import {offloading} from './offload.mjs';
import {writeCapturePatches} from './capture-patches.mjs';


const CAPTURE_PHOTO = typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true;

const TYPED_ARRAY = /* @__PURE__ */ (() => Object.getPrototypeOf(Uint8Array.prototype))();
const TYPED_LENGTH = /* @__PURE__ */ (() => Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'length').get)();
const TYPED_BUFFER = /* @__PURE__ */ (() => Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer').get)();
const BUFFER_LENGTH = /* @__PURE__ */ (() => Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get)();
const VD_LF_SECTIONS = new WeakMap();
const lfEntryOf = (jpeg, plan) => {
  const key = {modularAns: plan.modularAns, epf: jpeg.epf, strategyData: jpeg.strategyData, quantFields: jpeg.quantFields, cfl: jpeg.cfl,
    cflMaps: plan.cflMaps ?? null, cflGroups: plan.cflGroups > 64 ? plan.cflGroups : 64,
    auxiliary: jpeg.auxiliary, useDCFrame: jpeg.useDCFrame, sharpness: jpeg.sharpness, field: jpeg.quantFieldBase, alpha: jpeg.alpha, xyb: jpeg.xyb, ycbcr: jpeg.ycbcr,
    reconstruction: jpeg.jpegReconstruction, cflBase: jpeg.cflBase};
  let byCoder = VD_LF_SECTIONS.get(jpeg.components);
  if (!byCoder) VD_LF_SECTIONS.set(jpeg.components, byCoder = new Map());
  const coderKey = plan.lfCoder ?? null, hit = byCoder.get(coderKey);
  if (hit && Object.keys(key).every(k => hit[k] === key[k])) return hit;
  const entry = {...key, sections: [], wide: false};
  byCoder.set(coderKey, entry);
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
export {ORDER_STRATEGY_BUCKETS as ORDER_OF} from './coefficient-orders.mjs';
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

function targetDcIndex(source, target, i) {
  if (target.numDc === 1) return 0;
  if (target.numDc === source.numDc && (!target.thresholds?.length || target.thresholds.every((t, k) => t === source.thresholds[k]))) return i;
  return target.bucketOf(i ? source.thresholds[i - 1] + 1 : source.thresholds[0]);
}
function contextRenaming(source, target, orders = ORDERS) {
  const into = new Int16Array(source.numCtxs).fill(-1);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < orders; ord++) for (let i = 0; i < source.numDc; i++) {
    const from = source.map[(row * ORDERS + ord) * source.numDc + i], to = target.map[(row * ORDERS + ord) * target.numDc + targetDcIndex(source, target, i)];
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

function subsetThresholds(all, count) {
  if (!count || !all?.length) return [];
  if (count >= all.length) return all;
  const aligned = all.filter((_, idx) => idx % 2 === 1);
  if (count === 1 && aligned.length) return [aligned[aligned.length >> 1]];
  if (count <= aligned.length) return aligned.slice(0, count);
  return aligned;
}
function designShape(name, buckets, grey, lumaDc, thresholds = null) {
  const fastDefault = name === 'dcBuckets' && buckets === 0;
  const chosenThresholds = Array.isArray(buckets) ? buckets : thresholds ? subsetThresholds(thresholds, buckets) : null;
  const candidate = fastDefault ? (grey ? FAST_CONTEXTS_GREY : FAST_CONTEXTS_RGB)
    : chosenThresholds ? contextsFromThresholds(chosenThresholds, grey, DESIGNS[name](grey)) : blockContexts(lumaDc, buckets, grey, DESIGNS[name](grey));
  if (candidate.numCtxs > 16) return null;
  let header;
  if (fastDefault) header = grey ? FAST_HEADER_GREY : FAST_HEADER_RGB;
  else { header = new BitWriter(128); writeBlockContexts(header, candidate); }
  return {candidate, header};
}
const designWith = ({candidate, header}, codings) => ({candidate, codings, header, total: codings.reduce((n, coding) => n + coding.bits, header.bitLength)});
const writerData = w => ({bytes: w.bytes, at: w.at, pending: w.pending, acc: w.acc});
const UNIT_GROUPS = 2;
const savedWriter = w => ({...w, bytes: w.bytes.slice(0, w.at + 1)});
const joinedSection = w => !w ? new Uint8Array(0) : w.pending ? journalJoin([sliceBytes(w.bytes, 0, w.at), Uint8Array.of(w.acc)]) : sliceBytes(w.bytes, 0, w.at);
const MERGED_BY_COUNTS = new WeakMap();
function mergedCountsCached(name, buckets, grey, countedMap, srcCounts, candidate, orders) {
  let byDesign = MERGED_BY_COUNTS.get(srcCounts);
  if (!byDesign) MERGED_BY_COUNTS.set(srcCounts, byDesign = new Map());
  const key = `${name}:${(candidate.thresholds ?? []).join(',')}:${grey ? 1 : 0}:${orders}`;
  const hit = byDesign.get(key);
  if (hit && hit.countedMap === countedMap) return hit.merged;
  const merged = mergedCounts(countedMap, srcCounts, candidate, orders);
  byDesign.set(key, {countedMap, merged});
  return merged;
}
function* designPriceSteps(name, buckets, grey, lumaDc, countedMap, counts, buildCoding, options, thresholds = null, orders = ORDERS) {
  const shape = designShape(name, buckets, grey, lumaDc, thresholds);
  if (!shape) return null;
  const {candidate} = shape, same = candidate === countedMap || (candidate.numCtxs === countedMap.numCtxs && candidate.numDc === countedMap.numDc && candidate.map.every((v, i) => v === countedMap.map[i]));
  if (!same && (Array.isArray(buckets) || (thresholds && buckets > 0 && buckets < thresholds.length)) && !contextRenaming(countedMap, candidate, orders)) return null;
  const codings = [];
  for (let p = 0; p < counts.length; p++) {
    const input = () => same ? counts[p] : mergedCountsCached(name, buckets, grey, countedMap, counts[p], candidate, orders);
    codings.push(buildCoding.steps ? yield* buildCoding.steps(input, options) : buildCoding(input(), options));
  }
  return designWith(shape, codings);
}
const designPrice = (...args) => complete(designPriceSteps(...args));
export function designPriced(list, at, {counts, lumaDc, wanted, grey, clusters, fine = true}, buildCoding, kernels) {
  const countedMap = blockContexts(lumaDc, wanted, grey, fine ? DESIGNS.fine(grey) : undefined), options = {...clusters, smallestMap: true, kernels};
  return at.map(i => designPrice(list[i][0], list[i][1], grey, lumaDc, countedMap, [counts], buildCoding, options, null, fine ? ORDERS : 1) ?? null);
}
function mergedCounts(source, counts, target, orders) {
  const into = new Int16Array(source.numCtxs).fill(-1);
  for (let row = 0; row < 3; row++) for (let ord = 0; ord < orders; ord++) for (let i = 0; i < source.numDc; i++)
    into[source.map[(row * ORDERS + ord) * source.numDc + i]] = target.map[(row * ORDERS + ord) * target.numDc + targetDcIndex(source, target, i)];
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

function planModularChannel(plane, width, height, predictor, freq) {
  if (!width || !height) return {tags: new Uint32Array(0), extra: new Uint32Array(0), used: 0, literalPairs: new Uint32Array(0), literalPairsLen: 0, lengths: new Uint32Array(33)};
  if (predictor !== GRADIENT_PREDICTOR) throw fault('JXL_INTERNAL', 'vardct:modular-plan');
  const planned = (kernelHooks.dcPlan ?? ensured().dcPlan ?? missing())(plane, width, height, freq);
  if (!planned) throw declined('dcPlan');
  return planned;
}

export function writeModularStream(w, planes, predictor, ans, kernels) {
  if (!ans) return plainModularStream(w, planes, predictor);
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
      const model = losslessCoding(plan)[1], cfg = model.config;
      if ((cfg.split !== 0 || cfg.msb !== 0 || cfg.lsb !== 0) && !(kernelHooks.planTokens ?? ensured().planTokens ?? missing())(plan, cfg)) throw declined('planTokens');
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

const QUANT_STREAM_CACHE = new WeakMap();
function writeCachedQuantMatrices(ac, comps, shift = 0) {
  const q0 = comps[0].quant, q1 = comps[1].quant, q2 = comps[2].quant;
  let m0 = QUANT_STREAM_CACHE.get(q0), m1 = m0?.get(q1), entry = m1?.get(q2);
  if (!entry) {
    const writer = new BitWriter(256);
    let wide = false;
    const planes = [0, 1, 2].map(c => {
      const data = new Int32Array(64), quant = comps[c].quant;
      if (copyVarDCTQuantRows(quant, data) && !shift) wide = true;
      if (shift) for (let i = 0; i < 64; i++) data[i] /= 2 ** shift;
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


function fitCflRow(cs, bw, bh, gy, maps, row0) {
  const rows = Math.min(32, bh - gy * 32), tw = bw + 7 >> 3, start = (gy * 32 - row0) * cs[1].stride * 64;
  const n = rows * cs[1].stride * 64, from = gy * 4 * tw, tiles = (rows + 7 >> 3) * tw;
  const kernels = (kernelHooks.entropy ?? ensured().entropy ?? missing())() ?? missing(), known = maps[3] || maps[2][gy];
  for (let i = 0; i < 2; i++) {
    const c = i * 2;
    kernels.fitCfl(cs[1].coeffs.subarray(start, start + n), cs[c].coeffs.subarray(start, start + n),
      cs[1].quant, cs[c].quant, bw, rows, cs[1].stride, maps[i].subarray(from, from + tiles), known);
  }
  maps[2][gy] = 1;
}
function fitJpegCfl(raw, bw, bh, gyCount, givenMaps = null) {
  const tw = bw + 7 >> 3, th = bh + 7 >> 3;
  const maps = givenMaps ? [givenMaps[0], givenMaps[1], new Uint8Array(gyCount), 1] : [new Int8Array(tw * th), new Int8Array(tw * th), new Uint8Array(gyCount)];
  const comps = [{...raw[0], coeffs: Int16Array.from(raw[0].coeffs)}, raw[1], {...raw[2], coeffs: Int16Array.from(raw[2].coeffs)}];
  for (let gy = 0; gy < gyCount; gy++) fitCflRow(comps, bw, bh, gy, maps, 0);
  return {comps, maps, tw};
}
export function encodeVarDCT(jpeg, plan) { return complete(varDCTSteps(jpeg, plan)); }


export function coalescedColors(colors, cw, ch, x0, y0, rw, rh, blocks, luma, nonZero) {
  const active = new Uint8Array(cw * ch);
  if (blocks) {
    for (const block of blocks) {
      const plane = block.coeffs?.[1];
      let any;
      if (plane) {
        any = false;
        for (let k = 0; k < plane.length && !any; k++) any = plane[k] !== 0;
      } else {
        any = block.lumaAC;
        if (any === undefined) return null;
      }
      if (any) active[((block.by - y0) >> 3) * cw + ((block.bx - x0) >> 3)] = 1;
    }
  } else {
    const stride = luma?.stride, coeffs = luma?.row0 === undefined ? luma?.coeffs : null;
    if (!stride || !(nonZero || coeffs?.length)) return null;
    for (let by = 0; by < rh; by++) for (let bx = 0; bx < rw; bx++) {
      const b = (y0 + by) * stride + x0 + bx, t = (by >> 3) * cw + (bx >> 3);
      if (active[t]) continue;
      if (nonZero) { if (nonZero[b]) active[t] = 1; continue; }
      for (let k = 1; k < 64; k++) if (coeffs[b * 64 + k]) { active[t] = 1; break; }
    }
  }
  if (active.every(Boolean)) return null;
  const out = colors.map(c => c.slice());
  let changed = false;
  for (let t = 0; t < cw * ch; t++) if (!active[t]) {
    const from = t % cw ? t - 1 : t - cw;
    for (const c of out) { const v = from >= 0 ? c[from] : 0; changed ||= c[t] !== v; c[t] = v; }
  }
  return changed ? out : null;
}

export function strategyGroup(state, g, pass, coding, w) {
  if (!kernelHooks.strategyWrite) kernelHooks.ensure?.();
  const written = kernelHooks.strategyWrite?.(state, g, pass, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF, coding, w);
  if (!written) throw fault('JXL_INTERNAL', 'vardct:strategy-write');
  return written;
}

let sharedTokens = null;
const tokenBuffer = () => sharedTokens ||= {ctxs: new Int32Array(GROUP_TOKENS), values: new Int32Array(GROUP_TOKENS)};
export function* varDCTSteps(jpeg, plan = {}, shared) {
  const cflInput = plan.cflMaps ?? (plan.cflGroups > 64 ? plan.cflGroups : null);
  if (shared && (shared.jpeg !== jpeg || (shared.cflInput ?? null) !== cflInput)) Object.assign(shared, {jpeg, cflInput, cflFit: undefined, cflMaps: null, dc3dSigs: null, dc3dMaps: null, dc3dCounted: null, dc3dTokens: null, lastBucketTag: null, blockCounts: null, countedByOrder: null, fineCountedByOrder: null, tokensByOrder: null, fineTokensByOrder: null, chosenDesigns: null, tokenStore: null, dcSections: null, ansDcSections: null, lfSections: null, acSections: null, modularAns: null, lfCoder: null, modular16bit: true});
  let modular16bit = (shared?.modular16bit ?? true) && jpeg.modular16bit !== false;
  const {width, height, components, alpha, auxiliary, xyb, strategyData, splineBits, useDCFrame, authoredOrderPasses} = jpeg, grey = components.length === 1;
  const progression = (typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) ? jpeg.progression : null;
  const noiseLut = (typeof __RAPIER_JXL_FORMAT__ === 'undefined' || __RAPIER_JXL_FORMAT__ === true) ? jpeg.noiseLut : null;
  const {isFirstFrame = true, isLastFrame = true, crop = null, saveAsReference = 0, imageWidth, imageHeight,
    alphaChannel = Boolean(alpha), mask = false, patches = null} = jpeg.placement ?? {};
  if (mask && (!alphaChannel || !crop)) throw fault('JXL_INTERNAL', 'vardct:mask');
  const layout = varDCTLayout(jpeg, plan);
  const {directRGB, numPasses, epf, quantScale, field, shift, ycbcr, map, comps: rawComps, hasOrders, orders,
    rawH, rawV, maxhs, maxvs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, groupsX, groupsY, numGroups,
    dcGroupsX, dcGroupsY, numDcGroups, single, dcScale, dcLift} = layout;
  const givenCfl = !CAPTURE_PHOTO && (typeof __RAPIER_JXL_RECOMPRESS__ === "undefined" || __RAPIER_JXL_RECOMPRESS__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== "undefined" && __RAPIER_JXL_UPLOAD__ === true) ? plan.cflMaps ?? null : null;
  const cflGroups = !CAPTURE_PHOTO && (typeof __RAPIER_JXL_RECOMPRESS__ === "undefined" || __RAPIER_JXL_RECOMPRESS__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== "undefined" && __RAPIER_JXL_UPLOAD__ === true) && plan.cflGroups > 64 ? plan.cflGroups : 64;
  const canCfl = !CAPTURE_PHOTO && !!(jpeg.jpegReconstruction && !grey && !maxhs && !maxvs && (!ycbcr || numGroups <= cflGroups || givenCfl) && !strategyData && !progression && !jpeg.cfl && (jpeg.band || rawComps.every(c => c.coeffs)));
  let cflGy = -1;
  const cflFit = !canCfl ? null : jpeg.band ? (() => {
    const tw = xsizeBlocks + 7 >> 3, th = ysizeBlocks + 7 >> 3, maps = givenCfl ? [givenCfl[0], givenCfl[1], new Uint8Array(groupsY), 1] : shared?.cflMaps || [new Int8Array(tw * th), new Int8Array(tw * th), new Uint8Array(groupsY)];
    if (shared && !givenCfl) shared.cflMaps = maps;
    const b0 = new Int16Array(32 * rawComps[0].stride * 64), b2 = new Int16Array(32 * rawComps[2].stride * 64);
    return {comps: [{...rawComps[0], coeffs: b0}, rawComps[1], {...rawComps[2], coeffs: b2}], maps, tw, b0, b2};
  })() : (shared ? (shared.cflFit ||= fitJpegCfl(rawComps, xsizeBlocks, ysizeBlocks, groupsY, givenCfl)) : fitJpegCfl(rawComps, xsizeBlocks, ysizeBlocks, groupsY, givenCfl));
  const comps = cflFit ? cflFit.comps : rawComps;
  const bandOf = cflFit && jpeg.band ? gy => {
    if (gy === cflGy) return;
    jpeg.band(gy); cflFit.b0.set(rawComps[0].coeffs); cflFit.b2.set(rawComps[2].coeffs);
    comps[0].row0 = rawComps[0].row0; comps[2].row0 = rawComps[2].row0; cflGy = gy;
    fitCflRow(comps, xsizeBlocks, ysizeBlocks, gy, cflFit.maps, gy * 32);
  } : jpeg.band;
  const hshift = c => hshifts[c], vshift = c => vshifts[c];
  const sharpnessOf = (x0, y0, rw, rh) => {
    const out = new Int16Array(rw * rh).fill(7), own = jpeg.sharpness;
    if (own) copyVarDCTSharpness(own, xsizeBlocks, x0, y0, rw, out);
    return out;
  };
  const kernels = (kernelHooks.entropy ?? ensured().entropy)?.();
  const dcGroupSteps = function* (g, part) {
    const lfCoder = plan.lfCoder;
    const w = new BitWriter(4096), geometry = varDCTLFGeometry(layout, g);
    const {gx, gy, x0, y0, rw, rh, cw, ch, bits} = geometry;
    if (part !== 1) {
    if (!useDCFrame) {
    w.write(2, 0);
    const planes = [1, 0, 2].map(c => {
      const pw = rw >> hshift(c), ph = rh >> vshift(c);
      const spec = varDCTDCSpec(jpeg, layout, c, x0 >> hshift(c), y0 >> vshift(c), pw, ph);
      const data = copyVarDCTDCRows(spec, new Int16Array(pw * ph));
      if (data instanceof Int32Array) modular16bit = false;
      return {w: pw, h: ph, data};
    });
    const plainDc = target => writeModularStream(target, planes, GRADIENT_PREDICTOR, plan.modularAns, kernels);
    if (lfCoder?.dcSteps) yield* lfCoder.dcSteps(w, planes, plainDc, kernels);
    else if (lfCoder) lfCoder.dc(w, planes, plainDc, kernels); else plainDc(w);
    }
    auxiliary?.group(w, gx * 2048, gy * 2048, 2048, 3, Infinity);
    if (part === 0) return w;
    }
    const regionBlocks = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null).blocks.filter(block => block.bx >= x0 && block.bx < x0 + rw && block.by >= y0 && block.by < y0 + rh);
    if (regionBlocks) {
      let sorted = true;
      for (let i = 1; i < regionBlocks.length; i++) if (regionBlocks[i].by < regionBlocks[i - 1].by || (regionBlocks[i].by === regionBlocks[i - 1].by && regionBlocks[i].bx < regionBlocks[i - 1].bx)) { sorted = false; break; }
      if (!sorted) regionBlocks.sort((a, b) => a.by - b.by || a.bx - b.bx);
    }
    const metadataPlain = !lfCoder || lfCoder.plainMetadata === true;
    const {count, uniformBlocks, uniformSharpness, sharpVal} = varDCTLFMetadataShape(jpeg, layout, geometry, regionBlocks?.length, metadataPlain);
    if (bits) w.write(bits, count - 1);
    let blocks = null;
    varDCTField(field, 1);
    if (!uniformBlocks) {
      blocks = new Int32Array(count * 2).fill(field - 1, count);
      if (regionBlocks) copyVarDCTStrategies(regionBlocks, blocks);
      if (jpeg.quantFields && regionBlocks) copyVarDCTStrategyFields(jpeg.quantFields, xsizeBlocks, shift, regionBlocks, blocks);
      else if (jpeg.quantFields) copyVarDCTFieldRows(jpeg.quantFields, xsizeBlocks, shift, x0, y0, rw, rh, blocks);
    }
    const colors = [new Int16Array(cw * ch), new Int16Array(cw * ch)];
    if (cflFit) for (let ty = 0; ty < ch; ty++) {
      const r = (y0 >> 3) + ty;
      if (!cflFit.maps[2][r >> 2]) bandOf(r >> 2);
      for (let tx = 0; tx < cw; tx++) {
        const at = r * cflFit.tw + (x0 >> 3) + tx;
        colors[0][ty * cw + tx] = cflFit.maps[0][at]; colors[1][ty * cw + tx] = cflFit.maps[1][at];
      }
    } else if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && (xyb || directRGB || ycbcr) && jpeg.cfl) copyVarDCTCorrelation(jpeg.cfl, x0, y0, cw, ch, colors);
    const metadata = [
      {w: cw, h: ch, data: colors[0]}, {w: cw, h: ch, data: colors[1]},
      uniformBlocks ? {w: count, h: 2, rowValues: [0, field - 1]} : {w: count, h: 2, data: blocks},
      uniformSharpness ? {w: rw, h: rh, rowValues: new Int16Array(rh).fill(sharpVal)} : {w: rw, h: rh, data: !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && epf ? sharpnessOf(x0, y0, rw, rh) : new Int16Array(rw * rh)},
    ];
    const plainMetadataOf = planes => target => writeSmallerModularStream(target, planes, field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
    const plainMetadata = plainMetadataOf(metadata);
    const coalesced = lfCoder?.coalesceCfl && !cflFit && jpeg.cfl && xyb && (!strategyData || regionBlocks) ? coalescedColors(colors, cw, ch, x0, y0, rw, rh, regionBlocks, rawComps[1], jpeg.nonZero?.[map[1]]) : null;
    if (coalesced && lfCoder.metadataSteps) {
      const a = new BitWriter(256), b = new BitWriter(256), other = [{w: cw, h: ch, data: coalesced[0]}, {w: cw, h: ch, data: coalesced[1]}, metadata[2], metadata[3]];
      yield* lfCoder.metadataSteps(a, metadata, plainMetadata, kernels);
      yield* lfCoder.metadataSteps(b, other, plainMetadataOf(other), kernels);
      w.append(b.bitLength < a.bitLength ? b : a);
    } else if (lfCoder?.metadataSteps) yield* lfCoder.metadataSteps(w, metadata, plainMetadata, kernels);
    else if (lfCoder) lfCoder.metadata(w, metadata, plainMetadata, kernels); else plainMetadata(w);
    return w;
  };
  const dcGroup = (g, part) => complete(dcGroupSteps(g, part));
  if (!CAPTURE_PHOTO && plan.lfGroup !== undefined) {
    const narrow = modular16bit, w = dcGroup(plan.lfGroup);
    return {bytes: w.bytes.slice(0, w.at), at: w.at, pending: w.pending, acc: w.acc, wide: narrow && !modular16bit};
  }
  const lumaW = xsizeBlocks >> hshift(1), lumaH = ysizeBlocks >> vshift(1);
  const fast = !!plan.fast;
  let lumaDc = null;
  const lumaDcOf = () => {
    if (!lumaDc) { lumaDc = new Int32Array(fast ? 0 : lumaW * lumaH); if (!fast) copyVarDCTDCRows(varDCTDCSpec(jpeg, layout, 1, 0, 0, lumaW, lumaH), lumaDc); }
    return lumaDc;
  };
  const baseWanted = varDCTContextBuckets(jpeg, layout, fast);
  const fineDc = !!((typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && plan.fineDc && jpeg.jpegReconstruction && !fast && !strategyData && layout.xsizeBlocks * layout.ysizeBlocks >= 256);
  const wanted = fineDc ? Math.max(baseWanted, plan.fineDc === true ? 7 : plan.fineDc) : baseWanted;
  const standard = jpeg.jpegReconstruction ? [] : ['standard'];
  const designs = plan.countedMap ? ['dcBuckets'] : ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? (plan.richContexts ? ['dcBuckets', 'sizes', 'sizesShared', 'sizes3', 'sizes3Shared', 'sizesDc', ...standard] : ['dcBuckets', 'sizes', 'sizesShared', ...standard]) : (typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && fineDc && !grey ? ['dcBuckets', 'dcShared', ...(wanted > 7 ? ['dcChroma1', 'dcChroma2'] : []), ...standard] : ['dcBuckets', ...standard];
  const fixedContexts = !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && wanted === 0, design = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? DESIGNS.fine(grey) : undefined;
  const fixed = () => grey ? FAST_CONTEXTS_GREY : FAST_CONTEXTS_RGB;
  const dc3dSpec = !CAPTURE_PHOTO && (typeof __RAPIER_JXL_RECOMPRESS__ === "undefined" || __RAPIER_JXL_RECOMPRESS__ === true) && !(typeof __RAPIER_JXL_UPLOAD__ !== "undefined" && __RAPIER_JXL_UPLOAD__ === true) && Array.isArray(plan.dc3d) && jpeg.jpegReconstruction && !grey && !fast && !strategyData && !progression && hshifts[1] === 0 && vshifts[1] === 0 && (jpeg.band || comps.every(c => c.coeffs && c.row0 === undefined)) && layout.xsizeBlocks * layout.ysizeBlocks >= 256 ? plan.dc3d : null;
  const dc3dKey = dc3dSpec ? dc3dSpec.join("x") : null;
  const counting = yield* unit('block-contexts', () => {
    if (dc3dSpec) {
      const cached3d = !journaling() ? shared?.dc3dMaps?.get(dc3dKey) : null;
      if (cached3d) return cached3d;
      const allDcs = [0, 1, 2].map(c => c === 1 ? lumaDcOf() : copyVarDCTDCRows(varDCTDCSpec(jpeg, layout, c, 0, 0, xsizeBlocks >> hshift(c), ysizeBlocks >> vshift(c)), new Int32Array((xsizeBlocks >> hshift(c)) * (ysizeBlocks >> vshift(c)))));
      const loadBand = bandOf ? gy => { bandOf(gy); jpeg.unpackBand?.(); } : null;
      const learned3d = learn3DBlockContexts(comps, allDcs, hshifts, vshifts, xsizeBlocks, ysizeBlocks, dc3dSpec, shared?.dc3dSigs ?? null, loadBand);
      const saved3d = {thresholds: learned3d.thresholds, dcThresholds: learned3d.dcThresholds, numDc: learned3d.numDc, map: learned3d.map, numCtxs: learned3d.numCtxs, lumaBuckets: learned3d.lumaBuckets};
      if (shared && !journaling()) {
        shared.dc3dSigs ||= learned3d.sigs;
        (shared.dc3dMaps ||= new Map()).set(dc3dKey, saved3d);
      }
      return saved3d;
    }
    const luma = lumaDcOf(), contexts = fixedContexts ? fixed() : blockContexts(luma, wanted, grey, design);
    const lumaBuckets = new Uint8Array(luma.length), bucketOf = contexts.bucketOf;
    let low = 0, high = -1;
    if (luma.length) { low = high = luma[0]; for (const v of luma) { if (v < low) low = v; else if (v > high) high = v; } }
    if (high - low < luma.length) {
      const table = new Uint8Array(high - low + 1);
      for (let v = low; v <= high; v++) table[v - low] = bucketOf(v);
      for (let i = 0; i < luma.length; i++) lumaBuckets[i] = table[luma[i] - low];
    } else for (let i = 0; i < luma.length; i++) lumaBuckets[i] = bucketOf(luma[i]);
    return {thresholds: fixedContexts ? null : contexts.thresholds, lumaBuckets};
  });
  let contexts = counting.dcThresholds ? {thresholds: counting.thresholds, dcThresholds: counting.dcThresholds, numDc: counting.numDc, map: counting.map, numCtxs: counting.numCtxs, ...acContexts(counting.map, counting.numDc, counting.numCtxs)} : fixedContexts ? fixed() : contextsFromThresholds(counting.thresholds, grey, design);
  const {lumaBuckets} = counting;
  let activeBuckets = lumaBuckets, contextHeader = null;
  if (counting.dcThresholds) { contextHeader = new BitWriter(256); write3DBlockContexts(contextHeader, counting.dcThresholds, counting.map); }

  const nzeros = [0, 1, 2].map(() => new Int32Array(32 * 32));
  const fastBlockCounts = !progression && !grey && jpeg.nonZero ? map.map(i => jpeg.nonZero[i]) : null;
  let counted = !progression && !!(shared?.blockCounts || fastBlockCounts || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && !jpeg.band));
  const blockCounts = shared?.blockCounts || fastBlockCounts || comps.map((comp, c) => {
    if (grey && c !== 1) return null;
    const out = new Uint8Array(comp.row0 === undefined ? comp.coeffs.length / 64 : comp.stride * comp.rows);
    if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && comp.row0 === undefined) for (let b = 0; b < out.length; b++) { let n = 0; for (let k = 1; k < 64; k++) n += comp.coeffs[b * 64 + k] !== 0; out[b] = n; }
    return out;
  });
  const buffer = tokenBuffer();
  const tokenState = () => ({authoredOrderPasses, groupsX, strategyData: ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null), map, progression, contexts, lumaBuckets: activeBuckets, lumaW,
    nzeros, xsizeBlocks, ysizeBlocks, comps, grey, orders, counted, blockCounts, nonZero: jpeg.nonZero || ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && counted ? blockCounts : undefined), tokenBuffer: buffer,
    hshifts, vshifts});
  let passPicture = null;
  const passComps = (typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) ? (pass, row = -1) => {
    if (passPicture?.pass !== pass || passPicture.row !== row) passPicture = {pass, row, comps: comps.map(c => {
      if (!c.coeffs) return c;
      const coeffs = (kernelHooks.passLevels ?? ensured().passLevels ?? missing())(c.coeffs, progression.passes, pass);
      if (!coeffs) throw declined('passLevels');
      return {...c, coeffs};
    })};
    return passPicture.comps;
  } : null;
  const groupInput = (g, pass = 0) => {
    const row = jpeg.band ? Math.floor(g / groupsX) : -1;
    const state = (typeof __RAPIER_JXL_PROGRESSIVE__ === 'undefined' || __RAPIER_JXL_PROGRESSIVE__ === true) && progression && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? {...tokenState(), progression: null, nonZero: null, comps: passComps(pass, row)} : tokenState();
    if (!jpeg.band || ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) return {state, g};
    const by = row * 32, rows = Math.min(32, ysizeBlocks - by);
    return {g: g % groupsX, state: {...state, ysizeBlocks: rows,
      comps: state.comps.map(c => ({...c, row0: 0})),
      blockCounts: blockCounts.map((counts, c) => counts?.subarray((by >> vshift(c)) * comps[c].stride, ((by + rows) >> vshift(c)) * comps[c].stride)),
      nonZero: jpeg.nonZero?.map((counts, c) => counts?.subarray((by >> vshift(c)) * comps[c].stride, ((by + rows) >> vshift(c)) * comps[c].stride)),
      lumaBuckets: activeBuckets.subarray((by >> vshift(1)) * lumaW, ((by + rows) >> vshift(1)) * lumaW)}};
  };
  let kept = null, renaming = null;
  const fill = (g, pass) => {
    const {state, g: local} = groupInput(g, pass);
    if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) {
      if (!kernelHooks.strategyFill) kernelHooks.ensure?.();
      if (!kernelHooks.strategyFill) throw fault('JXL_WASM', 'WebAssembly SIMD required');
      const n = kernelHooks.strategyFill(state, local, pass, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF, buffer.ctxs, buffer.values);
      if (n == null) throw fault('JXL_INTERNAL', 'vardct:strategy-fill');
      return [n, buffer.ctxs, buffer.values];
    }
    if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) return null;
    const filled = kernels?.fill(state.nonZero && state.counted ? {...state, nonZero: null} : state, local, pass, DCT8_DENSITY);
    if (!filled) throw declined('fill');
    return filled;
  };
  const countTokens = (g, into, pass) => {
    bandOf?.((g / groupsX) | 0);
    const input = groupInput(g, pass);
    if ((kernelHooks.acGroup ?? ensured().acGroup)?.(input.state, input.g, pass, {counts: into, coding: null, w: null}, DCT8_DENSITY)) return;
    jpeg.unpackBand?.();
    if (!buffer) throw declined('acGroup');
    const [n, ctxs, values] = fill(g, pass);
    if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && ctxs.buffer !== buffer.ctxs.buffer && kernels.countFilled(into, n)) {} else into.addTokens(ctxs, values, n);
    if (kept && !kernels && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) kept[g] = shared.tokenStore.keep({ctxs, values}, n);
  };
  const writeTokens = (g, coding, w, pass) => {
    bandOf?.((g / groupsX) | 0);
    let input = groupInput(g, pass);
    const written = (kernelHooks.acGroup ?? ensured().acGroup)?.(input.state, input.g, pass, {counts: null, coding, w}, DCT8_DENSITY);
    if (written) return written;
    if (jpeg.unpackBand) { jpeg.unpackBand(); input = groupInput(g, pass); }
    if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) return strategyGroup(input.state, input.g, pass, coding, w);
    if ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) return;
    if (!buffer || !coding.writeTokens) throw declined('acGroup');
    if (coding.writeFilled && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) {
      const filled = kernels.fill(input.state, input.g, pass, DCT8_DENSITY);
      if (filled) { if (filled.wide) coding.writeTokens(w, filled[1], filled[2], filled[0]); else coding.writeFilled(w, filled[0]); return; }
    }
    const group = kept?.[g];
    if (!group || renaming === false) {
      const [n, ctxs, values] = fill(g, pass);
      if (kept && !kernels && !((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) && !renaming && !progression) kept[g] = shared.tokenStore.keep({ctxs, values}, n);
      coding.writeTokens(w, ctxs, values, n);
      return;
    }
    if (!renaming) { coding.writeTokens(w, group.ctxs, group.values, group.ctxs.length); return; }
    const ctxs = buffer.ctxs, n = group.ctxs.length;
    for (let i = 0; i < n; i++) ctxs[i] = renaming[group.ctxs[i]];
    coding.writeTokens(w, ctxs, group.values, n);
  };
  const writeGroupTokens = (g, coding, w, pass) => {
    if (writeTokens(g, coding, w, pass) !== 2 && coding.flush) coding.flush(w);
  };
  const total = 2 * numGroups * numPasses + numDcGroups;
  let done = 0;
  if ((typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && shared && fineDc) {
    const key = counting.thresholds.join(',');
    if (shared.fineDcKey !== key) { shared.fineCountedByOrder?.clear(); shared.fineTokensByOrder?.clear(); shared.fineDcKey = key; }
  }
  const bucketTag = dc3dKey || (fineDc ? "fine" : "plain");
  const countedByOrder = shared && !progression ? (dc3dKey ? ((shared.dc3dCounted ||= new Map()).get(dc3dKey) || (() => { const m = new Map(); shared.dc3dCounted.set(dc3dKey, m); return m; })()) : fineDc ? (shared.fineCountedByOrder ||= new Map()) : (shared.countedByOrder ||= new Map())) : null;
  const orderKey = authoredOrderPasses || (hasOrders ? plan.orders : null);
  const buildCoding = plan.coding || buildTokenCoding;
  const rawReuse = countedByOrder?.get(orderKey);
  const reuse = rawReuse && rawReuse.length === numPasses && rawReuse[0]?.contexts === contexts.contexts ? rawReuse : null;
  const counts = reuse || Array.from({length: numPasses}, () => new TokenCounts(contexts.contexts));
  const tokensByOrder = !CAPTURE_PHOTO && buffer && countedByOrder && !jpeg.band ? (dc3dKey ? ((shared.dc3dTokens ||= new Map()).get(dc3dKey) || (() => { const m = new Map(); shared.dc3dTokens.set(dc3dKey, m); return m; })()) : fineDc ? (shared.fineTokensByOrder ||= new Map()) : (shared.tokensByOrder ||= new Map())) : null;
  kept = shared?.lastBucketTag === bucketTag ? tokensByOrder?.get(orderKey) || null : null;
  if ((!reuse || !kept) && tokensByOrder) { shared.tokensByOrder?.clear(); shared.fineTokensByOrder?.clear(); shared.dc3dTokens?.forEach(cache => cache.clear()); shared.lastBucketTag = bucketTag; (shared.tokenStore ||= tokenStore()).reset(); kept = []; tokensByOrder.set(orderKey, kept); }
  if (!CAPTURE_PHOTO && plan.countGroups) {
    for (let g = plan.countGroups[0]; g < plan.countGroups[1]; g++) countTokens(g, counts[0], 0);
    return {counts: counts[0], blockCounts};
  }
  const parts = (!CAPTURE_PHOTO && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading())) && !reuse && !progression && !plan.pooled && numGroups > 1 && (yield {offload: 'run', task: {kind: 'count', image: jpeg, plan, groups: numGroups}, at: () => done / total});
  if (reuse && !journaling()) { done += numGroups * numPasses; yield done / total; }
  else if (parts) {
    for (const part of parts) {
      counts[0].merge(part.counts);
      part.blockCounts.forEach((from, c) => { const into = blockCounts[c]; if (from) for (let i = 0; i < from.length; i++) if (from[i] > into[i]) into[i] = from[i]; });
    }
    done += numGroups; yield done / total;
  }
  else {
    let answered = null;
    const state = () => ({counts: counts.map(tokenCountsData), blockCounts});
    const restore = () => {
      if (!answered) return;
      answered.counts.forEach((saved, p) => { counts[p] = tokenCountsFrom(saved); });
      answered.blockCounts.forEach((from, c) => from && blockCounts[c].set(from));
      answered = null;
    };
    answered = yield* stage('counts', function* () {
      if (reuse) { done += numGroups * numPasses; yield done / total; return null; }
      for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g += UNIT_GROUPS) {
        const end = Math.min(numGroups, g + UNIT_GROUPS);
        const saved = yield* carried('count', () => { restore(); for (let h = g; h < end; h++) countTokens(h, counts[p], p); return null; }, state);
        if (saved !== PASSED && saved !== null) answered = saved;
        while (done < p * numGroups + end) yield ++done / total;
      }
      restore();
      return null;
    }, state, false, true);
    if (answered) done = numGroups * numPasses;
    if (journaling()) {
      const given = answered;
      const blocks = yield* unit('block-counts', () => (restore(), blockCounts));
      if (given) {
        blocks.forEach((from, c) => from && blockCounts[c].set(from));
        const plain = (i, value) => Object.defineProperty(counts, i, {value, writable: true, enumerable: true, configurable: true});
        const settle = () => { const made = given.counts.map(tokenCountsFrom); answered = null; made.forEach((value, i) => plain(i, value)); };
        for (let i = 0; i < counts.length; i++) Object.defineProperty(counts, i, {get: () => (settle(), counts[i]), enumerable: true, configurable: true});
      }
    } else restore();
  }
  if (countedByOrder) countedByOrder.set(orderKey, counts);
  counted = !progression;
  if (shared && !progression) shared.blockCounts = blockCounts;
  let codings = null;
  const countedMap = contexts;
  const list = [];
  const fineBuckets = (typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && fineDc && counting.thresholds?.length ? [...new Set([0, 1, baseWanted, counting.thresholds.length].filter(b => b <= counting.thresholds.length))] : null;
  for (const name of designs) for (const buckets of name === 'standard' ? [0] : plan.fast ? [wanted] : fineBuckets && name.startsWith('dc') ? fineBuckets : wanted > 0 && name === 'dcBuckets' ? [0, wanted] : wanted > 0 && name === 'sizesDc' ? [wanted] : [0]) list.push([name, buckets]);
  if (plan.designs) { const only = list.filter(([name, buckets]) => plan.designs.includes(`${name}:${buckets === wanted && wanted > 0 ? 'wanted' : buckets}`) || (wanted === 0 && plan.designs.includes(`${name}:wanted`))); if (only.length) list.splice(0, list.length, ...only); }
  const remote = !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && (plan.splitGroups && ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) || plan.remoteDesigns) && list.length > 1 && counts.length === 1 && !plan.fast
    ? yield {kind: 'designs', list, counts: counts[0], lumaDc: lumaDcOf(), wanted, grey, fine: !!((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null), clusters: plan.clusters, coding: buildCoding} : null;
  const remoteTotals = Array.isArray(remote) ? remote : remote?.totals ?? null, remotePriced = remote?.priced ?? null;
  const dcCache = !journaling() && !remoteTotals && !progression && counts.length === 1 && shared?.acCoding === buildCoding ? buildCoding?.designCache : null;
  let dcOrderMap = null, dcKey = null, dcHit = null;
  if (dcCache) {
    const byOrder = (shared.chosenDesigns ||= new Map());
    dcOrderMap = byOrder.get(orderKey);
    if (!dcOrderMap) byOrder.set(orderKey, dcOrderMap = new Map());
    dcKey = `${dc3dKey ? 'dc3d:' + dc3dKey + ':' : fineDc ? 'fine:' : ''}${designs.join(',')}${plan.designs ? '/' + list.map(l => l.join(':')).join(',') : ''}|${(counting.thresholds ?? []).join(',')}|${grey ? 1 : 0}|${((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? ORDERS : 1}|${dcCache.key({...plan.clusters, smallestMap: true, kernels})}`;
    dcHit = dcOrderMap.get(dcKey) ?? null;
  }
  if (dcHit) {
    codings = dcHit.parts.map(p => dcCache.from(p, kernels));
    contexts = dcHit.candidate;
    contextHeader = Object.assign(new BitWriter(0), dcHit.header);
  } else if (counting.dcThresholds) {
    const opts3d = {...plan.clusters, smallestMap: true, kernels};
    codings = [];
    for (let p = 0; p < counts.length; p++) {
      const src = counts[p];
      codings.push(buildCoding.steps ? yield* buildCoding.steps(() => src, opts3d) : buildCoding(src, opts3d));
    }
    if (dcOrderMap && codings.every(c => c?.model?.kind === 'ans')) {
      dcOrderMap.set(dcKey, {parts: codings.map(dcCache.parts), candidate: contexts,
        header: {bytes: contextHeader.bytes.slice(0, contextHeader.at + 1), at: contextHeader.at, pending: contextHeader.pending, acc: contextHeader.acc}});
    }
  } else {
    let best = Infinity, bestAt = -1;
    for (let i = 0; i < list.length; i++) {
      const [name, buckets] = list[i];
      if (remoteTotals) { if (remoteTotals[i] != null && (bestAt < 0 || remoteTotals[i] < best)) { best = remoteTotals[i]; bestAt = i; } continue; }
      const priced = yield* designPriceSteps(name, buckets, grey, null, countedMap, counts, buildCoding, {...plan.clusters, smallestMap: true, kernels}, counting.thresholds ?? [], ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? ORDERS : 1);
      if (!priced) continue;
      if (!codings || priced.total < codings.reduce((n, coding) => n + coding.bits, contextHeader.bitLength)) {
        codings = priced.codings; contexts = priced.candidate; contextHeader = priced.header;
      }
    }
    if (!(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) && remoteTotals && bestAt >= 0) {
      const made = !remotePriced?.[bestAt] && remote.coding?.(bestAt), shape = made ? designShape(list[bestAt][0], list[bestAt][1], grey, lumaDcOf()) : null;
      if (remotePriced?.[bestAt] || shape) globalThis.__jxlTrace?.push(['the kept design built as ' + (shape ? 'a helper priced it' : 'priced here'), performance.now()]);
      const priced = remotePriced?.[bestAt] ?? (shape && designWith(shape, [made])) ?? designPrice(list[bestAt][0], list[bestAt][1], grey, lumaDcOf(), countedMap, counts, buildCoding, {...plan.clusters, smallestMap: true, kernels}, null, ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? ORDERS : 1);
      codings = priced.codings; contexts = priced.candidate; contextHeader = priced.header;
    }
    if (dcOrderMap && codings?.every(c => c?.model?.kind === 'ans')) {
      dcOrderMap.set(dcKey, {parts: codings.map(dcCache.parts), candidate: contexts,
        header: {bytes: contextHeader.bytes.slice(0, contextHeader.at + 1), at: contextHeader.at, pending: contextHeader.pending, acc: contextHeader.acc}});
    }
  }
  const sameMap = contexts === countedMap || (contexts.numDc === countedMap.numDc && contexts.numCtxs === countedMap.numCtxs && contexts.map.every((v, i) => v === countedMap.map[i]));
  if ((typeof __RAPIER_JXL_RECOMPRESS__ === 'undefined' || __RAPIER_JXL_RECOMPRESS__ === true) && contexts.thresholds.length > 0 && (contexts.thresholds.length !== (counting.thresholds?.length ?? 0) || contexts.thresholds.some((t, i) => t !== counting.thresholds[i]))) {
    const remap = Uint8Array.from({length: counting.thresholds.length + 1}, (_, b) => targetDcIndex(countedMap, contexts, b));
    activeBuckets = new Uint8Array(lumaBuckets.length);
    for (let i = 0; i < lumaBuckets.length; i++) activeBuckets[i] = remap[lumaBuckets[i]];
  }
  if (!CAPTURE_PHOTO && kept) renaming = sameMap ? null : contextRenaming(countedMap, contexts, ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? ORDERS : 1);
  if (!CAPTURE_PHOTO && plan.writeGroups) {
    const coding = codings[0], written = [];
    for (let g = plan.writeGroups[0]; g < plan.writeGroups[1]; g++) {
      const w = new BitWriter(4096);
      writeGroupTokens(g, coding, w, 0);
      written.push({bytes: w.bytes.slice(0, w.at + 1), at: w.at, pending: w.pending, acc: w.acc});
    }
    return written;
  }

  const writers = Array.from({length: varDCTSectionCount(numGroups, numDcGroups, numPasses)}, () => null);
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
  if (patches) (typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true ? null : writeCapturePatches)(dc, patches, alphaChannel);
  if (splineBits) dc.append(splineBits);
  if (noiseLut) for (const value of noiseLut) dc.write(10, Math.round(value * 1024));

  const alphaPlane = (gx, gy) => {
    const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0), data = jpeg.alphaWords ? new Int32Array(w * h) : new Int16Array(w * h);
    const rows = jpeg.alphaRows?.(y0, h);
    copyVarDCTAlphaRows(alpha, rows, width, x0, y0, w, data, mask);
    return {w, h, data};
  };
  const writeAlpha = (w, planes) => {
    if (mask) return plainModularStream(w, planes, GRADIENT_PREDICTOR, 255);
    const plain = target => writeModularStream(target, planes, GRADIENT_PREDICTOR, plan.modularAns, kernels);
    if (plan.lfCoder && plan.lfCoder.plainMetadata !== true) plan.lfCoder.metadata(w, planes, plain, kernels); else plain(w);
  };
  writeVarDCTDCFields(dc, jpeg, layout, contextHeader);
  if (auxiliary) auxiliary.global(dc);
  else if (alphaChannel) writeAlpha(dc, [numGroups === 1 ? alphaPlane(0, 0) : {w: 0, h: 0, data: new Int32Array(0)}]);
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
  const cached = journaling() && !shared?.ownDc ? null : dcSections;
  const dcTask = g => ({kind: 'lf', image: jpeg, plan, g}), missing = (!CAPTURE_PHOTO && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading())) ? Array.from({length: numDcGroups}, (_, g) => g).filter(g => !cached?.[g]) : [];
  if (missing.length) yield {offload: 'prefetch', tasks: missing.map(dcTask), at: () => done / total};
  for (let g = 0; g < numDcGroups; g++) {
    if (cached?.[g]) {
      section(1 + g).append(dcSections[g]); checkSection(1 + g); yield ++done / total; continue;
    }
    const remote = missing.length && (yield {offload: 'run', task: dcTask(g), at: () => done / total});
    if (remote?.wide) modular16bit = false;
    let w;
    if (remote) w = Object.assign(new BitWriter(0), {bytes: remote.bytes, at: remote.at, pending: remote.pending, acc: remote.acc});
    else for (const part of [0, 1]) {
      const local = yield* stage('dc', function* () { const narrow = modular16bit, w = yield* dcGroupSteps(g, part); return {w: writerData(w), wide: narrow && !modular16bit}; },
        ({w, wide}) => ({w: savedWriter(w), wide}));
      if (local.wide) modular16bit = false;
      const written = Object.assign(new BitWriter(0), local.w);
      if (part) w.append(written); else w = written;
    }
    section(1 + g).append(w); checkSection(1 + g);
    if (dcSections) { w.bytes = w.bytes.slice(0, w.at); dcSections[g] = w; }
    if (shared) shared.modular16bit = modular16bit;
    if (lfEntry && narrowBefore && !modular16bit) lfEntry.wide = true;
    yield ++done / total;
  }

  const ac = section(1 + numDcGroups);
  const sampleCosts = !CAPTURE_PHOTO && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && single && jpeg.seedSampleCosts;
  const sampleStart = sampleCosts ? ac.bitLength : 0;
  ac.write(1, 0);
  for (let i = 0; i < 17; i++) {
    const table = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)?.tables[i];
    if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? !table : i !== 0) { ac.write(3, 0); continue; }
    if (table?.parameters) { writeQuantParams(ac, table.parameters.syntax, map); continue; }
    if (!table && jpeg.quantTable) {
      ac.write(3, 6); ac.write(4, 5);
      for (const c of map) for (const bits of jpeg.quantTable[c]) ac.write(16, bits);
      continue;
    }
    const square = table && i === 0 && table.w === 8 && table.h === 8;
    const compact = !(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && (!table || square) && photoDCT8Table(jpeg, table ? map.map(c => table.planes[c]) : comps.map(c => c.quant), field, quantScale, table ? null : comps);
    if (compact) { writeQuantParams(ac, compact, [0, 1, 2]); continue; }
    const shift = rawStepShift(table ? map.map(c => table.planes[c]) : comps.map(c => c.quant));
    ac.write(3, 7); ac.write(16, float16Bits(field / (8 * 255 * quantScale) * 2 ** shift));
    if (!table) {
      if (writeCachedQuantMatrices(ac, comps, shift)) modular16bit = false;
      continue;
    }
    writeSmallerModularStream(ac, [0, 1, 2].map(c => {
      const data = shift ? Int32Array.from(table.planes[map[c]], value => value / 2 ** shift) : table.planes[map[c]];
      for (const value of data) if (value < -32768 || value > 32767) modular16bit = false;
      return {w: table.h, h: table.w, data};
    }), table.w !== table.h ? ZERO_PREDICTOR : GRADIENT_PREDICTOR);
  }
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  for (let pass = 0; pass < codings.length; pass++) {
  const coding = codings[pass];
  writeVarDCTOrders(ac, jpeg, layout, plan, pass);
  if (coding.writeHistograms) coding.writeHistograms(ac);
  else writeHistograms(ac, {contextMap: coding.contextMap, histograms: coding.histograms});
  }
  checkSection(1 + numDcGroups);
  const sampleHeader = sampleCosts ? ac.bitLength - sampleStart - 1 : 0;
  if (shared) shared.modular16bit = modular16bit;
  if (plan.estimate && codings.every(coding => coding.payloadBits !== undefined))
    return Math.ceil(sectionBytes + codings.reduce((n, coding) => n + coding.payloadBits, 0) / 8 + 4 * numGroups * numPasses);

  const reuseAC = shared?.acCoding === buildCoding && !single && !progression && !auxiliary && !plan.pooled && !plan.estimate;
  const acKey = reuseAC ? {global: ac.finish(), globalBits: ac.bitLength, contexts: contextHeader.finish(), contextBits: contextHeader.bitLength,
    coder: buildCoding, entropy: kernelHooks.entropy, group: kernelHooks.acGroup,
    alphaCoder: alphaChannel && !mask ? plan.lfCoder : undefined} : null;
  const matchAC = entry => entry && entry.coder === acKey.coder && entry.entropy === acKey.entropy && entry.group === acKey.group && entry.alphaCoder === acKey.alphaCoder &&
    entry.globalBits === acKey.globalBits && entry.contextBits === acKey.contextBits &&
    acKey.global.length === entry.global.length && acKey.contexts.length === entry.contexts.length &&
    acKey.global.every((v, i) => v === entry.global[i]) && acKey.contexts.every((v, i) => v === entry.contexts[i]);
  const acList = acKey && !journaling() && Array.isArray(shared.acSections) ? shared.acSections : null;
  let cachedAC = null;
  if (acList) {
    const acIdx = acList.findIndex(matchAC);
    if (acIdx >= 0) {
      cachedAC = acList[acIdx];
      if (acIdx < acList.length - 1) { acList.splice(acIdx, 1); acList.push(cachedAC); }
    }
  }

  const groupSamples = values => values != null && (Object.getPrototypeOf(values) === Int16Array.prototype || Object.getPrototypeOf(values) === Int32Array.prototype);
  const boundedGroups = !jpeg.band && (plan.pooled || (!CAPTURE_PHOTO && (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && offloading()))) && (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null).blocks.every(block => block.coeffs.every(groupSamples)) : comps.every(comp => groupSamples(comp.coeffs)));
  let reply;
  if (!cachedAC && boundedGroups && (numGroups > 1 || plan.pooled && single) && !progression && !auxiliary && codings[0].model) {
    const coding = codings[0], hshifts = [0, 1, 2].map(hshift), vshifts = [0, 1, 2].map(vshift);
    const model = {coding: coding.model, grey, orders, hshifts, vshifts,
      authoredOrderPasses: authoredOrderPasses?.map(({byStrategy, ordinary}) => ({byStrategy, ordinary})),
      contexts: {thresholds: contexts.thresholds, map: contexts.map, numDc: contexts.numDc, numCtxs: contexts.numCtxs}};
    const job = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) ? null : (g, maxInputBytes = Infinity) => {
      const bx0 = g % groupsX * 32, by0 = Math.floor(g / groupsX) * 32;
      const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
      const lw = bw >> hshift(1), lh = bh >> vshift(1);
      let inputBytes = lw * lh;
      if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) {
        const orders = new Set();
        for (const block of ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null).groups[g]) {
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
        throw Object.assign(new RangeError('AC group: over reservation'), {code: 'JXL_MEMORY'});
      const buckets = new Uint8Array(lw * lh);
      for (let y = 0; y < lh; y++) {
        const from = ((by0 >> vshift(1)) + y) * lumaW + (bx0 >> hshift(1));
        buckets.set(activeBuckets.subarray(from, from + lw), y * lw);
      }
      const transfer = [buckets.buffer], data = {xsizeBlocks: bw, ysizeBlocks: bh, lumaW: lw, lumaBuckets: buckets};
      if (((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null)) {
        data.strategyData = {groups: [((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null).groups[g].map(block => {
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
      ...(plan.splitGroups ? {lumaBuckets: activeBuckets, lumaW} : {}),
      local: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function local(g) {
        try {
          const w = new BitWriter(4096);
          writeGroupTokens(g, coding, w, 0); return w;
        } finally { coding.reset?.(); }
      },
      at: g => (done + g + 1) / total, stop: g => plan.abortable && g + 1 < numGroups};
    if (reply instanceof Error) throw reply;
    if (!reply && plan.pooled) return null;
    if (reply) for (let g = 0; g < numGroups; g++) {
      if (Object.hasOwn(reply.errors, g)) throw reply.errors[g];
      const index = 2 + numDcGroups + g, w = Object.assign(new BitWriter(0), reply.results[g]);
      reply.results[g] = null;
      if (single) section(index).append(w);
      else {
        writers[index] = w;
        if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && alphaChannel) writeAlpha(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))]);
      }
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
  const writeGroup = (g, p) => {
    const index = 2 + numDcGroups + p * numGroups + g, w = section(index), coding = codings[p];
    writeGroupTokens(g, coding, w, p);
    if (auxiliary) {
      const bracket = progression?.brackets[p] ?? {minimum: 0, maximum: 2};
      auxiliary.group(w, g % groupsX * GROUP_DIM, Math.floor(g / groupsX) * GROUP_DIM, GROUP_DIM, bracket.minimum, bracket.maximum);
    }
    else if (!(typeof __RAPIER_JXL_JPEG__ !== 'undefined' && __RAPIER_JXL_JPEG__ === true) && alphaChannel && numGroups > 1 && p === (progression?.alphaPass ?? 0)) writeAlpha(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))]);
    return index;
  };
  for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g += UNIT_GROUPS) {
    const end = Math.min(numGroups, g + UNIT_GROUPS);
    if (single) for (let h = g; h < end; h++) { checkSection(writeGroup(h, p)); yield ++done / total; }
    else {
      const rows = yield* unit('ac', () => { const out = []; for (let h = g; h < end; h++) out.push(writerData(writers[writeGroup(h, p)])); return out; },
        out => out.map(savedWriter));
      for (let h = g; h < end; h++) {
        const index = 2 + numDcGroups + p * numGroups + h;
        if (rows[h - g].bytes !== writers[index]?.bytes) writers[index] = Object.assign(new BitWriter(0), rows[h - g]);
        checkSection(index); yield ++done / total;
      }
    }
  }
  }
  if (jpeg.level === 5 && !modular16bit) throw fault('JXL_INPUT', 'samples > 16-bit: use level 10');
  const level = isFirstFrame && !jpeg.frameHeader ? Math.max(jpeg.level ?? 5, modular16bit ? 5 : 10) : 5, boundedHeader = journaling() && jpeg.profile?.iccData, joined = journaling() && !single && !boundedHeader;
  let bytes, sections;
  if (boundedHeader) bytes = yield* journalTool('varDCTFile')(header => writeVarDCTHeader(header, jpeg, layout, modular16bit, writeImageHeader), writers, level, {BitWriter, writeTOC, codestreamFromParts});
  else {
    const header = new BitWriter(256);
    writeVarDCTHeader(header, jpeg, layout, modular16bit, writeImageHeader);
    if (joined) bytes = assembleCodestream(header, writers.map(joinedSection), level, journalJoin);
    else { sections = finishSections(writers); bytes = assembleCodestream(header, sections, level); }
  }
  const coeffBytes = ((typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) ? strategyData : null) ? width * height * 2 : components.reduce((n, c) => n + (c.coeffs?.byteLength ?? 0), 0);
  if (acKey && !cachedAC && sections && !boundedHeader && !joined && bytes.length + acKey.global.length + acKey.contexts.length <= coeffBytes) {
    const groups = [], first = 2 + numDcGroups;
    let at = bytes.length - sections.slice(first).reduce((n, section) => n + section.length, 0);
    for (let g = first; g < sections.length; g++) { groups.push(bytes.subarray(at, at + sections[g].length)); at += sections[g].length; }
    const list = Array.isArray(shared.acSections) ? shared.acSections : (shared.acSections = []);
    if (list.length >= 12) list.shift();
    list.push({...acKey, groups});
  }
  if (sampleCosts) sampleCosts.set(bytes, {header: sampleHeader, section: sectionSizes[0]});
  return isFirstFrame && isLastFrame && !crop ? shown(bytes, jpeg, plan) : bytes;
}
