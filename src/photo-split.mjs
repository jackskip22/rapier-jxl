// SPDX-License-Identifier: MIT
import {complete, BitWriter} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {photoXYBBand, PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {V6, GABORISH, UPLOAD_PICTURE, SMALL_PIXELS, SMALL_CLUSTERS} from './photo-v6-settings.mjs';
import {screenLike} from './screen.mjs';
import {varDCTSteps, blockContexts, acContexts, fillACGroup, DCT8_DENSITY, seedLfSections, vdLfGroupCount} from './vardct.mjs';
import {lfCoderFor} from './lf-coding.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {ordersFromCounts} from './coefficient-effort.mjs';
import {buildAnsCoding, ansGroupWriter, writeModularAnsHistograms} from './ans.mjs';
import {TokenCounts, prefixGroupWriter} from './entropy.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {GROUP_DIM, GROUP_TOKENS} from './frame.mjs';

const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
export const SPLIT_MIN_PIXELS = 512 * 512 + 1;
export const splitRoute = (width, height) => width * height > 64 * 64;

export function splitBands(height, parts, unit = GROUP_DIM) {
  const rows = Math.ceil(height / unit), count = Math.max(1, Math.min(parts, rows)), bands = [];
  let from = 0;
  for (let k = 0; k < count; k++) {
    const take = Math.floor((rows + k) / count);
    bands.push({top: from * unit, height: Math.min(height, (from + take) * unit) - from * unit});
    from += take;
  }
  return bands;
}

function packLevels(image) {
  image.components.forEach((component, c) => {
    const {coeffs} = component, counts = image.nonZero?.[c] ?? splitBlockCounts(coeffs);
    let total = 0;
    for (let b = 0; b < counts.length; b++) total += counts[b];
    const at = new Uint8Array(total), levels = new Int16Array(total), stride = component.stride, starts = new Uint32Array(counts.length / stride);
    for (let b = 0, n = 0; b < counts.length; b++) {
      const base = b * 64;
      if (b % stride === 0) starts[b / stride] = n;
      for (let k = 1, left = counts[b]; left; k++) { const v = coeffs[base + k]; if (v) { at[n] = k; levels[n++] = v; left--; } }
    }
    component.packed = {at, levels, counts, starts, segment: stride, length: coeffs.length};
    component.coeffs = null;
  });
  return image;
}
function splitBlockCounts(coeffs) {
  const counts = new Uint8Array(coeffs.length / 64);
  for (let b = 0; b < counts.length; b++) { let n = 0; for (let k = 1; k < 64; k++) n += coeffs[b * 64 + k] !== 0; counts[b] = n; }
  return counts;
}
let splitScratch = [];
function unpackLevels(image) {
  image.components.forEach((component, c) => {
    const packed = component.packed;
    if (!packed || component.coeffs) return;
    if (!splitScratch[c] || splitScratch[c].length < packed.length) splitScratch[c] = new Int16Array(packed.length);
    const coeffs = splitScratch[c].subarray(0, packed.length), {at, levels, counts, starts, segment} = packed, stride = component.stride;
    const segments = Math.ceil(stride / segment);
    coeffs.fill(0);
    for (let row = 0, b = 0; b < counts.length; row++) for (let s = 0; s < segments; s++) {
      let n = starts[row * segments + s];
      for (const end = row * stride + Math.min(stride, (s + 1) * segment); b < end; b++) { const base = b * 64; for (const last = n + counts[b]; n < last; n++) coeffs[base + at[n]] = levels[n]; }
    }
    component.coeffs = coeffs;
  });
}

function packedOnly(image) { for (const component of image.components) if (component.packed) component.coeffs = null; }

const held = new Map();

function bandStep(message) {
  const {key, width, height, quality, data, screen, gaborish, offset} = message;
  const picture = message.full ? {...V6, ...GABORISH} : UPLOAD_PICTURE;
  const image = gaborish ? photoXYBBand(data, width, height, quality, message.pack ? {...picture, packed: true} : picture, offset)
    : complete(photoXYBSteps(data, width, height, quality, screen ? {...V6, fast: true, calibrationRow: 'screen'} : {...V6, fast: true}));
  const orderCounts = image.components.map(() => new Uint32Array(64));
  const dc = image.components.map(c => c.packed ? c.packed.dc : new Int16Array(c.coeffs.length / 64));
  const natural = new Uint32Array(64);
  image.components.forEach(({coeffs, packed}, c) => {
    if (packed) { for (let k = 1; k < 64; k++) orderCounts[c][k] = packed.natural[SCAN[k]]; return; }
    const plane = dc[c];
    natural.fill(0);
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      if (!kernelHooks.nonzero?.(coeffs, from, end, natural)) for (let at = from; at < end; at += 64) for (let i = 0; i < 64; i++) if (coeffs[at + i]) natural[i]++;
    }
    for (let k = 1; k < 64; k++) orderCounts[c][k] = natural[SCAN[k]];
    for (let at = 0, b = 0; at < coeffs.length; at += 64, b++) plane[b] = coeffs[at];
  });
  const meta = {...image, components: image.components.map(({h, v, stride, rows, quant}) => ({h, v, stride, rows, quant})), alpha: !!image.alpha};
  held.set(key, {image: message.pack && !image.components[0].packed ? packLevels(image) : image, width, height, lumaDc: message.full ? Int32Array.from(dc[1]) : null});
  delete meta.nonZero; delete meta.cfl;
  for (const component of image.components) if (component.packed) component.packed.dc = null;
  const back = message.giveBack && gaborish && data.byteOffset === 0 && data.buffer instanceof ArrayBuffer ? data.buffer : null;
  return [{split: 'band', key, orderCounts, dc, cfl: image.cfl, meta, ...(back ? {pixels: back} : {})},
    [...orderCounts.map(a => a.buffer), ...dc.map(a => a.buffer), image.cfl.x.buffer, image.cfl.b.buffer, ...(back ? [back] : [])]];
}

const splitContexts = c => c ? {...c, bucketOf: v => { let b = 0; for (const t of c.thresholds) if (v > t) b++; return b; }, ...acContexts(c.map, c.numDc, c.numCtxs)} : blockContexts(new Int32Array(0), 0, false);
const splitBuckets = (band, contexts) => {
  if (!band.lumaDc || !contexts.thresholds.length) return {lumaBuckets: null, lumaW: 0};
  const lumaBuckets = new Uint8Array(band.lumaDc.length);
  for (let i = 0; i < lumaBuckets.length; i++) lumaBuckets[i] = contexts.bucketOf(band.lumaDc[i]);
  return {lumaBuckets, lumaW: Math.ceil(band.width / 8)};
};
function countStep(message, into = null) {
  const {key, orders} = message, band = held.get(key);
  const {image, width, height} = band;
  const contexts = splitContexts(message.contexts), ladder = !!message.contexts;
  const groupsX = Math.ceil(width / GROUP_DIM), groups = groupsX * Math.ceil(height / GROUP_DIM);
  const state = {groupsX, contexts, ...splitBuckets(band, contexts), nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)),
    xsizeBlocks: Math.ceil(width / 8), ysizeBlocks: Math.ceil(height / 8), comps: image.components, grey: false,
    orders: orders ? orders.map(order => order.map(k => SCAN[k])) : [SCAN, SCAN, SCAN], counted: !!(image.nonZero), blockCounts: image.nonZero || image.components.map(c => new Uint8Array(c.coeffs.length / 64)),
    nonZero: image.nonZero, hshifts: [0, 0, 0], vshifts: [0, 0, 0]};
  const counts = into ?? new TokenCounts(contexts.contexts);
  let ctxs = null, values = null;
  band.tokens = []; band.state = state; band.groups = groups;
  band.kept = message.keep ? [] : null;
  for (let g = 0; g < groups; g++) {
    const sink = {counts, coding: null, w: null, defer: true, keep: !!message.keep};
    if (kernelHooks.acGroup?.(state, g, 0, sink, DCT8_DENSITY)) { band.tokens.push(null); if (band.kept) band.kept[g] = sink.kept ?? null; continue; }
    kernelHooks.acDeferred?.();
    unpackLevels(image);
    ctxs ||= new Int32Array(GROUP_TOKENS); values ||= new Int32Array(GROUP_TOKENS);
    const n = fillACGroup(state, g, 0, ctxs, values);
    counts.addTokens(ctxs, values, n);
    band.tokens.push(ladder ? null : {ctxs: ctxs.slice(0, n), values: values.slice(0, n)});
  }
  kernelHooks.acDeferred?.();
  packedOnly(image);
  if (!ladder && band.tokens.every(Boolean)) { band.image = null; band.state = null; }
  if (into) return null;
  const large = [], used = [];
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx]) used.push(ctx);
  const small = new Uint32Array(used.length * 64), totals = new Float64Array(used.length);
  used.forEach((ctx, i) => { small.set(counts.small.subarray(ctx * 64, ctx * 64 + 64), i * 64); totals[i] = counts.totals[ctx]; });
  counts.large.forEach((map, ctx) => { if (map) large.push(ctx, [...map.keys()], [...map.values()]); });
  const list = Int32Array.from(used);
  return [{split: 'count', key, contexts: list, small, totals, large}, [list.buffer, small.buffer, totals.buffer]];
}

function writeStep(message) {
  const {key, frame} = message, band = held.get(key), model = frame ? frame.coding : message.model, sections = [], transfer = [];
  let groupWriter = null;
  const writer = () => groupWriter ||= model.kind === 'prefix' ? prefixGroupWriter(model) : ansGroupWriter(model);
  const coding = {model, write: (w, ctx, value) => writer().write(w, ctx, value), writeTokens: (w, ctxs, tokens, n) => writer().writeTokens(w, ctxs, tokens, n),
    flush: model.kind === 'prefix' ? undefined : w => writer().flush(w), reset: () => groupWriter?.reset?.()};
  if (frame) {
    const contexts = splitContexts(frame.contexts), {image, width, height} = band;
    band.state = {groupsX: Math.ceil(width / GROUP_DIM), contexts, ...splitBuckets(band, contexts), nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)),
      xsizeBlocks: Math.ceil(width / 8), ysizeBlocks: Math.ceil(height / 8), comps: image.components, grey: false, orders: frame.orders,
      counted: !!image.nonZero, blockCounts: image.nonZero || image.components.map(c => new Uint8Array((c.coeffs?.length ?? c.packed.length) / 64)),
      nonZero: image.nonZero, hshifts: [0, 0, 0], vshifts: [0, 0, 0]};
    band.tokens = Array(band.groups ?? 0).fill(null); band.kept = null;
  }
  if (!message.keep) held.delete(key);
  let buffer;
  for (let g = 0; g < band.groups; g++) {
    const w = new BitWriter(4096), kept = band.tokens[g];
    if (!kept && g + 1 < band.groups && !band.tokens[g + 1] && kernelHooks.acGroupPair) {
      const next = new BitWriter(4096), done = kernelHooks.acGroupPair(band.state, g, g + 1, 0, {counts: null, coding, w, kept: band.kept?.[g]},
        {counts: null, coding, w: next, kept: band.kept?.[g + 1]}, DCT8_DENSITY);
      if (done) {
        for (const written of done === 2 ? [w, next] : [w]) {
          const bytes = written.bytes.slice(0, written.at + 8);
          sections.push({bytes, at: written.at, pending: written.pending, acc: written.acc}); transfer.push(bytes.buffer);
        }
        if (done === 2) g++;
        continue;
      }
    }
    try {
      const byKernels = !kept && kernelHooks.acGroup?.(band.state, g, 0, {counts: null, coding, w, kept: band.kept?.[g]}, DCT8_DENSITY);
      if (byKernels === 2) {}
      else if (byKernels) coding.flush?.(w);
      else if (kept) { coding.writeTokens(w, kept.ctxs, kept.values, kept.ctxs.length); coding.flush?.(w); }
      else {
        unpackLevels(band.image);
        buffer ||= {ctxs: new Int32Array(GROUP_TOKENS), values: new Int32Array(GROUP_TOKENS)};
        coding.writeTokens(w, buffer.ctxs, buffer.values, fillACGroup(band.state, g, 0, buffer.ctxs, buffer.values)); coding.flush?.(w);
      }
    } finally { coding.reset?.(); }
    const bytes = w.bytes.slice(0, w.at + 8);
    sections.push({bytes, at: w.at, pending: w.pending, acc: w.acc}); transfer.push(bytes.buffer);
  }
  if (band.image) packedOnly(band.image);
  if (frame && !message.keep) band.image = null;
  return [{split: 'write', key, sections}, transfer];
}

let dcStandIn = null;
export function dcStep({key, image, groups, lf = 3, ans = true}) {
  const count = vdLfGroupCount(image), lfCoder = lf ? lfCoderFor(lf) : undefined, mine = groups ?? Array.from({length: count}, (_, g) => g);
  const plan = {coding: () => ({bits: 0}), ...(ans ? {modularAns: writeModularAnsHistograms} : {}), ...(lfCoder ? {lfCoder} : {}), fast: true};
  const sectionKey = lfCoder ? 'lfSections' : ans ? 'ansDcSections' : 'dcSections';
  dcStandIn ??= new TokenCounts(blockContexts(new Int32Array(0), 0, false).contexts);
  const shared = {jpeg: image, countedByOrder: new Map([[null, [dcStandIn]]]),
    ...(ans ? {modularAns: writeModularAnsHistograms} : {}), ...(lfCoder ? {lfCoder} : {}), lfSections: [], ansDcSections: [], dcSections: []};
  const others = [];
  for (let g = 0; g < count; g++) if (!mine.includes(g)) others[g] = {bytes: new Uint8Array(0), at: 0, pending: 0, acc: 0};
  if (lfCoder) seedLfSections(image, plan, others);
  else others.forEach((group, g) => { shared[sectionKey][g] = Object.assign(new BitWriter(0), group); });
  const steps = varDCTSteps(image, plan, shared);
  try { while (!mine.every(g => shared[sectionKey]?.[g]) && !steps.next().done) {} }
  finally { steps.return(); }
  const sections = mine.map(g => { const {bytes, at, pending, acc} = shared[sectionKey][g]; return {g, bytes, at, pending, acc}; });
  return {split: 'dc', key, sections, modular16bit: shared.modular16bit};
}

const arenaDcStep = function arenaDcStep(message) {
  const kernels = message.arena && !kernelHooks.entropy ? kernelHooks.arena?.lend() : null;
  if (!kernels) return dcStep(message);
  kernelHooks.entropy = () => kernels;
  try { return dcStep(message); }
  catch (error) { if (!(error instanceof RangeError)) throw error; }
  finally { kernelHooks.entropy = null; kernelHooks.arena.release(); }
  return dcStep(message);
};

export const heldPieces = () => held.size;

export function serveSplit(message) {
  const [reply, transfer] = serveOne(message);
  reply.ticket = message?.ticket;
  return [reply, transfer];
}

function serveOne(message) {
  try {
    if (message.split === 'band') return bandStep(message);
    if (message.split === 'count') return countStep(message);
    if (message.split === 'write') return writeStep(message);
    if (message.split === 'dc') { const reply = arenaDcStep(message); return [reply, reply.sections.map(s => s.bytes.buffer)]; }
    if (message.split === 'drop') { held.delete(message.key); return [{split: 'drop', key: message.key}, []]; }
    throw new Error('Unknown split message.');
  } catch (error) {
    held.delete(message?.key);
    return [{split: message?.split, key: message?.key, error: {name: String(error?.name ?? 'Error'), message: String(error?.message ?? error)}}, []];
  }
}

export function addCounts(counts, {contexts, small, totals, large}) {
  const into = counts.small, sums = counts.totals;
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i], at = ctx * 64, from = i * 64;
    sums[ctx] += totals[i];
    for (let v = 0; v < 64; v++) into[at + v] += small[from + v];
  }
  for (let i = 0; i < large.length; i += 3) {
    const ctx = large[i], keys = large[i + 1], values = large[i + 2], map = counts.large[ctx] || (counts.large[ctx] = new Map());
    for (let j = 0; j < keys.length; j++) map.set(keys[j], (map.get(keys[j]) || 0) + values[j]);
  }
}

export function splitImage(done, width, height, data, adaptive = true) {
  const orderCounts = [0, 1, 2].map(c => {
    const sum = new Uint32Array(64);
    for (const reply of done) for (let k = 0; k < 64; k++) sum[k] += reply.orderCounts[c][k];
    return sum;
  });
  const meta = done[0].meta, stride = Math.ceil(width / 8), blockRows = Math.ceil(height / 8);
  const orders = ordersFromCounts(orderCounts, 8, adaptive, stride * blockRows);
  const components = meta.components.map((c, k) => {
    const dc = new Int16Array(stride * blockRows);
    let at = 0;
    for (const reply of done) { dc.set(reply.dc[k], at); at += reply.dc[k].length; }
    return {...c, rows: blockRows, coeffs: new Int16Array(0), dc};
  });
  const cflWidth = done[0].cfl.width, cfl = {width: cflWidth, x: new Int8Array(cflWidth * Math.ceil(height / 64)), b: new Int8Array(cflWidth * Math.ceil(height / 64))};
  let at = 0;
  for (const reply of done) { cfl.x.set(reply.cfl.x, at); cfl.b.set(reply.cfl.b, at); at += reply.cfl.x.length; }
  return {image: {...meta, height, components, cfl, alpha: done.some(reply => reply.meta.alpha) ? data : null}, orders};
}
const SPLIT_CLUSTERS = {maxClusters: 64, newClusterCost: 100, seeds: 128};
export const splitShape = (width, height) => width * height < SMALL_PIXELS ? {lf: null, clusters: SMALL_CLUSTERS} : {lf: 3, clusters: SPLIT_CLUSTERS};
const splitCoding = (counts, {clusters}) => buildAnsCoding(counts, {smallestMap: true, ...clusters, kernels: kernelHooks.entropy?.()});
function splitFrame(image, orders, counts, coding, dcGroups, {lf, clusters}) {
  const lfCoder = lf ? lfCoderFor(lf) : undefined;
  const plan = {coding: (c, o) => c === counts && o?.smallestMap && o?.seeds === clusters.seeds ? coding : buildAnsCoding(c, o),
    modularAns: writeModularAnsHistograms, ...(lfCoder ? {lfCoder} : {}), clusters, fast: true, orders, pooled: true, abortable: false};
  const cache = {jpeg: image, countedByOrder: new Map([[orders, [counts]]]), modularAns: writeModularAnsHistograms, modular16bit: dcGroups.modular16bit};
  if (lfCoder) { seedLfSections(image, plan, dcGroups.sections); Object.assign(cache, {lfCoder, lfSections: dcGroups.sections}); }
  else cache.ansDcSections = dcGroups.sections.map(section => Object.assign(new BitWriter(0), section));
  return varDCTSteps(image, plan, cache);
}

const SPLIT_BAND_BYTES = 8 << 20, SPLIT_KEEP_PIXELS = 5 << 20;
export function* photoSplitSteps(data, width, height, quality, {gaborish = false} = {}) {
  const split = splitStart(width, height);
  try {
    for (let k = 0; k < split.bands.length; k++) { splitBand(split, data, quality, gaborish, k); yield (k + 1) / split.parts; }
    return yield* splitRest(split, data);
  } finally { splitEnd(split); }
}
export function photoSplitBands(data, width, height, quality, {gaborish = false} = {}) {
  const split = splitStart(width, height);
  try { for (let k = 0; k < split.bands.length; k++) splitBand(split, data, quality, gaborish, k); }
  catch (error) { splitEnd(split); throw error; }
  return split;
}
export const splitHasAlpha = split => split.done.some(reply => reply.meta.alpha);
export function* splitSteps(split) {
  try { return yield* splitRest(split, null); }
  finally { splitEnd(split); }
}
function splitStart(width, height) {
  const perRow = Math.ceil(width / 8) * (GROUP_DIM / 8) * 64 * 2 * 3, take = Math.max(1, Math.floor(SPLIT_BAND_BYTES / perRow));
  const bands = splitBands(height, Math.ceil(Math.ceil(height / GROUP_DIM) / take)), id = ++serial;
  return {width, height, bands, keys: bands.map((_, k) => id + ':' + k), parts: 3 * bands.length + 1, done: [], screen: null};
}
function splitBand(split, data, quality, gaborish, k) {
  const {width, height, bands} = split, band = bands[k], margin = gaborish ? PHOTO_BAND_MARGIN : 0;
  split.screen ??= screenLike(data, width, height);
  const from = Math.max(0, band.top - margin), to = Math.min(height, band.top + band.height + margin);
  split.done.push(bandStep({key: split.keys[k], width, height: band.height, quality, data: data.subarray(from * width * 4, to * width * 4),
    offset: band.top - from, screen: split.screen, gaborish, pack: true})[0]);
}
function* splitRest(split, data) {
  const {width, height, bands, keys, parts} = split;
  if (!data && split.done.some(reply => reply.meta.alpha)) throw new Error('A split without pixels has alpha.');
  const {image, orders} = splitImage(split.done, width, height, data);
  split.done = [];
  const counts = new TokenCounts(blockContexts(new Int32Array(0), 0, false).contexts);
  const keep = width * height <= SPLIT_KEEP_PIXELS;
  for (let k = 0; k < bands.length; k++) { countStep({key: keys[k], orders, keep}, counts); yield (bands.length + k + 1) / parts; }
  const shape = splitShape(width, height), coding = splitCoding(counts, shape), reply = dcStep({image, lf: shape.lf}), dcGroups = {sections: [], modular16bit: reply.modular16bit};
  for (const {g, ...section} of reply.sections) dcGroups.sections[g] = section;
  const results = [];
  for (let k = 0; k < bands.length; k++) { results.push(...writeStep({key: keys[k], model: coding.model})[0].sections); yield (2 * bands.length + k + 1) / parts; }
  splitScratch = [];
  const steps = splitFrame(image, orders, counts, coding, dcGroups, shape);
  let step, answer, answered = false;
  while (!(step = steps.next(answer)).done) {
    answer = undefined;
    if (step.value?.kind !== 'ac-group') continue;
    if (results.length !== step.value.groups) throw new Error('Split sections do not cover the frame.');
    answer = {results, errors: {}}; answered = true;
  }
  if (!answered) throw new Error('The frame asked for no AC sections.');
  return step.value;
}
export function splitEnd(split) { for (const key of split.keys) held.delete(key); split.done = []; splitScratch = []; }

let serial = 0, tickets = 0;
export const splitIds = () => ({id: ++serial, ticket: () => ++tickets});
export const splitAsker = (helpers, serve, issued) => (w, message, key, transfer = []) => {
  if (key !== undefined) message.key = key;
  message.ticket = ++tickets;
  let reply;
  try { reply = w ? Promise.resolve(helpers[w - 1].send(message, transfer)) : Promise.resolve(serve(message)[0]); }
  catch (error) { reply = Promise.reject(error); }
  const answer = reply.then(answer => { if (answer?.error) throw Object.assign(new Error(answer.error.message), {name: answer.error.name}); return answer; });
  answer.catch(() => {});
  issued.push(answer);
  return answer;
};
export const splitRelease = key => held.delete(key);
const bandBuffers = [];
function bandCopy(view) {
  for (let i = 0; i < bandBuffers.length; i++) {
    const buffer = bandBuffers[i].deref();
    if (!buffer || !buffer.byteLength) { bandBuffers.splice(i--, 1); continue; }
    if (buffer.byteLength >= view.length) { bandBuffers.splice(i, 1); const copy = new Uint8Array(buffer, 0, view.length); copy.set(view); return copy; }
  }
  return view.slice();
}
function bandReturned(reply) {
  if (!(reply?.pixels instanceof ArrayBuffer)) return;
  if (typeof WeakRef === 'function' && bandBuffers.length < 8) bandBuffers.push(new WeakRef(reply.pixels));
  delete reply.pixels;
}
export async function encodeSplit(data, width, height, quality, helpers, {signal, gaborish = false, screen: known, opaque = false, arena = false} = {}) {
  const bands = splitBands(height, helpers.length + 1), id = ++serial;
  const screen = known ?? screenLike(data, width, height);
  const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer;
  const issued = [], call = splitAsker(helpers, serveSplit, issued), ask = (k, message, transfer) => call(k, message, id + ':' + k, transfer);
  const margin = gaborish ? PHOTO_BAND_MARGIN : 0;
  const rows = band => {
    const from = Math.max(0, band.top - margin), to = Math.min(height, band.top + band.height + margin);
    return {pixels: data.subarray(from * width * 4, to * width * 4), offset: band.top - from};
  };
  const keys = bands.map((_, k) => id + ':' + k);
  const T = globalThis.__splitMarks, mark = T ? name => T.push([name, performance.now()]) : () => {};
  try {
    mark('start');
    const first = bands.map((band, k) => {
      if (!k) return null;
      const {pixels: view, offset} = rows(band), pixels = shared ? view : bandCopy(view);
      const reply = ask(k, {split: 'band', width, height: band.height, quality, data: pixels, offset, screen, gaborish, pack: true, giveBack: !shared}, shared ? [] : [pixels.buffer])
        .then(answer => { bandReturned(answer); return answer; });
      reply.catch(() => {});
      return reply;
    });
    const own = rows(bands[0]);
    first[0] = ask(0, {split: 'band', width, height: bands[0].height, quality, data: own.pixels, offset: own.offset, screen, gaborish, pack: true});
    mark('own band');
    const done = await Promise.all(first);
    mark('bands');
    signal?.throwIfAborted();
    if (opaque && done.some(reply => reply.meta.alpha)) throw Object.assign(new Error('A band has alpha.'), {alpha: true});
    const {image, orders} = splitImage(done, width, height, data);
    const second = bands.map((_, k) => k ? ask(k, {split: 'count', orders}) : null);
    const shape = splitShape(width, height), dcCount = vdLfGroupCount(image), writers = Math.max(1, bands.length - 1), dcImage = {...image, alpha: null};
    const dcOf = slot => Array.from({length: dcCount}, (_, g) => g).filter(g => g % (writers + 1) === slot), dcHere = bands.length > 1 ? dcOf(writers) : [];
    const dcWriters = bands.length > 1
      ? Array.from({length: writers}, (_, h) => dcOf(h)).flatMap((groups, h) => groups.length ? [ask(h + 1, {split: 'dc', image: dcImage, groups, lf: shape.lf, arena})] : [])
      : [Promise.resolve(dcStep({image, lf: shape.lf}))];
    second[0] = ask(0, {split: 'count', orders});
    mark('own count');
    const counted = await Promise.all(second);
    mark('counts');
    signal?.throwIfAborted();
    const counts = new TokenCounts(blockContexts(new Int32Array(0), 0, false).contexts);
    for (const reply of counted) addCounts(counts, reply);
    mark('merge');
    const coding = splitCoding(counts, shape);
    mark('coding');
    const third = bands.map((_, k) => k ? ask(k, {split: 'write', model: coding.model}) : null);
    third[0] = ask(0, {split: 'write', model: coding.model});
    mark('own write');
    if (dcHere.length) globalThis.__jxlTrace?.push(['split: ' + dcHere.length + ' DC groups here', performance.now()]);
    if (dcHere.length) dcWriters.push(Promise.resolve(dcStep({image: {...dcImage, components: dcImage.components.map(c => ({...c}))}, groups: dcHere, lf: shape.lf})));
    const dcReplies = await Promise.all(dcWriters), dcGroups = {sections: [], modular16bit: dcReplies.every(reply => reply.modular16bit)};
    for (const reply of dcReplies) for (const {g, ...section} of reply.sections) dcGroups.sections[g] = section;
    mark('dc');
    const steps = splitFrame(image, orders, counts, coding, dcGroups, shape);
    let step, reply, answered = false;
    while (!(step = steps.next(reply)).done) {
      reply = undefined;
      const value = step.value;
      if (value?.kind !== 'ac-group') continue;
      mark('global');
      const written = await Promise.all(third), results = [];
      mark('sections');
      for (const answer of written) results.push(...answer.sections);
      if (results.length !== value.groups) throw new Error('Split sections do not cover the frame.');
      reply = {results, errors: {}}; answered = true;
    }
    if (!answered) throw new Error('The frame asked for no AC sections.');
    await Promise.allSettled(issued);
    mark('end');
    return step.value;
  } catch (error) {
    await Promise.allSettled(issued);
    held.delete(keys[0]);
    const drops = [];
    for (let k = 1; k < bands.length; k++) {
      try { drops.push(Promise.resolve(helpers[k - 1].send({split: 'drop', key: keys[k], ticket: ++tickets}, []))); }
      catch {}
    }
    await Promise.allSettled(drops);
    if (error?.alpha) return null;
    throw error;
  }
}

