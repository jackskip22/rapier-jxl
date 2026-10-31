// SPDX-License-Identifier: MIT
import {complete, BitWriter} from './bits.mjs';
import {photoXYBSteps} from './photo-xyb.mjs';
import {photoXYBBand, PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {V6, UPLOAD_PICTURE} from './photo-v6.mjs';
import {screenLike} from './screen.mjs';
import {varDCTSteps, blockContexts, fillACGroup, DCT8_DENSITY, seedLfSections, vdLfGroupCount} from './vardct.mjs';
import {lfCoderFor} from './lf-coding.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {ordersFromCounts} from './coefficient-effort.mjs';
import {buildAnsCoding, ansGroupWriter, writeModularAnsHistograms} from './ans.mjs';
import {TokenCounts} from './entropy.mjs';
import {ZIGZAG} from './jpeg-tables.mjs';
import {GROUP_DIM, GROUP_TOKENS} from './frame.mjs';

const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));
export const SPLIT_MIN_PIXELS = 512 * 512 + 1;

export function splitBands(height, parts) {
  const rows = Math.ceil(height / GROUP_DIM), count = Math.max(1, Math.min(parts, rows)), bands = [];
  let from = 0;
  for (let k = 0; k < count; k++) {
    const take = Math.floor((rows + k) / count);
    bands.push({top: from * GROUP_DIM, height: Math.min(height, (from + take) * GROUP_DIM) - from * GROUP_DIM});
    from += take;
  }
  return bands;
}

const held = new Map();

function bandStep(message) {
  const {key, width, height, quality, data, screen, gaborish, offset} = message;
  const image = gaborish ? photoXYBBand(data, width, height, quality, UPLOAD_PICTURE, offset)
    : complete(photoXYBSteps(data, width, height, quality, screen ? {...V6, fast: true, calibrationRow: 'screen'} : {...V6, fast: true}));
  const orderCounts = image.components.map(() => new Uint32Array(64)), dc = image.components.map(c => new Int16Array(c.coeffs.length / 64));
  const natural = new Uint32Array(64);
  image.components.forEach(({coeffs}, c) => {
    const plane = dc[c];
    natural.fill(0);
    for (let from = 0; from < coeffs.length; from += 65536) {
      const end = Math.min(from + 65536, coeffs.length);
      if (!kernelHooks.nonzero?.(coeffs, from, end, natural)) for (let at = from; at < end; at += 64) for (let i = 0; i < 64; i++) if (coeffs[at + i]) natural[i]++;
    }
    for (let k = 1; k < 64; k++) orderCounts[c][k] = natural[SCAN[k]];
    for (let at = 0, b = 0; at < coeffs.length; at += 64, b++) plane[b] = coeffs[at];
  });
  held.set(key, {image, width, height});
  const meta = {...image, components: image.components.map(({h, v, stride, rows, quant}) => ({h, v, stride, rows, quant})), alpha: !!image.alpha};
  delete meta.nonZero; delete meta.cfl;
  return [{split: 'band', key, orderCounts, dc, cfl: image.cfl, meta}, [...orderCounts.map(a => a.buffer), ...dc.map(a => a.buffer), image.cfl.x.buffer, image.cfl.b.buffer]];
}

function countStep(message) {
  const {key, orders} = message, band = held.get(key);
  const {image, width, height} = band, contexts = blockContexts(new Int32Array(0), 0, false);
  const groupsX = Math.ceil(width / GROUP_DIM), groups = groupsX * Math.ceil(height / GROUP_DIM);
  const state = {groupsX, contexts, lumaBuckets: null, lumaW: 0, nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)),
    xsizeBlocks: Math.ceil(width / 8), ysizeBlocks: Math.ceil(height / 8), comps: image.components, grey: false,
    orders: orders ? orders.map(order => order.map(k => SCAN[k])) : [SCAN, SCAN, SCAN], counted: !!(image.nonZero), blockCounts: image.nonZero || image.components.map(c => new Uint8Array(c.coeffs.length / 64)),
    nonZero: image.nonZero, hshifts: [0, 0, 0], vshifts: [0, 0, 0]};
  const counts = new TokenCounts(contexts.contexts), ctxs = new Int32Array(GROUP_TOKENS), values = new Int32Array(GROUP_TOKENS);
  band.tokens = []; band.state = state; band.groups = groups;
  for (let g = 0; g < groups; g++) {
    if (kernelHooks.acGroup?.(state, g, 0, {counts, coding: null, w: null}, DCT8_DENSITY)) { band.tokens.push(null); continue; }
    const n = fillACGroup(state, g, 0, ctxs, values);
    counts.addTokens(ctxs, values, n);
    band.tokens.push({ctxs: ctxs.slice(0, n), values: values.slice(0, n)});
  }
  if (band.tokens.every(Boolean)) { band.image = null; band.state = null; }
  const large = [], used = [];
  for (let ctx = 0; ctx < counts.contexts; ctx++) if (counts.totals[ctx]) used.push(ctx);
  const small = new Uint32Array(used.length * 64), totals = new Float64Array(used.length);
  used.forEach((ctx, i) => { small.set(counts.small.subarray(ctx * 64, ctx * 64 + 64), i * 64); totals[i] = counts.totals[ctx]; });
  counts.large.forEach((map, ctx) => { if (map) large.push(ctx, [...map.keys()], [...map.values()]); });
  const list = Int32Array.from(used);
  return [{split: 'count', key, contexts: list, small, totals, large}, [list.buffer, small.buffer, totals.buffer]];
}

function writeStep(message) {
  const {key, model} = message, band = held.get(key), coding = {...ansGroupWriter(model), model}, sections = [], transfer = [];
  held.delete(key);
  let buffer;
  for (let g = 0; g < band.groups; g++) {
    const w = new BitWriter(4096), kept = band.tokens[g];
    try {
      if (!kept && kernelHooks.acGroup?.(band.state, g, 0, {counts: null, coding, w}, DCT8_DENSITY) === 2) {}
      else if (kept) { coding.writeTokens(w, kept.ctxs, kept.values, kept.ctxs.length); coding.flush(w); }
      else {
        buffer ||= {ctxs: new Int32Array(GROUP_TOKENS), values: new Int32Array(GROUP_TOKENS)};
        coding.writeTokens(w, buffer.ctxs, buffer.values, fillACGroup(band.state, g, 0, buffer.ctxs, buffer.values)); coding.flush(w);
      }
    } finally { coding.reset?.(); }
    sections.push({bytes: w.bytes, at: w.at, pending: w.pending, acc: w.acc}); transfer.push(w.bytes.buffer);
  }
  return [{split: 'write', key, sections}, transfer];
}

function dcStep({key, image, groups}) {
  const count = vdLfGroupCount(image), lfCoder = lfCoderFor(3), mine = groups ?? Array.from({length: count}, (_, g) => g);
  const plan = {coding: () => ({bits: 0}), modularAns: writeModularAnsHistograms, lfCoder, fast: true};
  const shared = {jpeg: image, countedByOrder: new Map([[null, [new TokenCounts(blockContexts(new Int32Array(0), 0, false).contexts)]]]),
    modularAns: writeModularAnsHistograms, lfCoder, lfSections: []};
  const others = [];
  for (let g = 0; g < count; g++) if (!mine.includes(g)) others[g] = {bytes: new Uint8Array(0), at: 0, pending: 0, acc: 0};
  seedLfSections(image, plan, others);
  const steps = varDCTSteps(image, plan, shared);
  try { while (!mine.every(g => shared.lfSections?.[g]) && !steps.next().done) {} }
  finally { steps.return(); }
  const sections = mine.map(g => { const {bytes, at, pending, acc} = shared.lfSections[g]; return {g, bytes, at, pending, acc}; });
  return {split: 'dc', key, sections, modular16bit: shared.modular16bit};
}

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
    if (message.split === 'dc') { const reply = dcStep(message); return [reply, reply.sections.map(s => s.bytes.buffer)]; }
    if (message.split === 'drop') { held.delete(message.key); return [{split: 'drop', key: message.key}, []]; }
    throw new Error('Unknown split message.');
  } catch (error) {
    held.delete(message?.key);
    return [{split: message?.split, key: message?.key, error: {name: String(error?.name ?? 'Error'), message: String(error?.message ?? error)}}, []];
  }
}

function addCounts(counts, {contexts, small, totals, large}) {
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

let serial = 0, tickets = 0;
export async function encodeSplit(data, width, height, quality, helpers, {signal, gaborish = false} = {}) {
  const bands = splitBands(height, helpers.length + 1), id = ++serial;
  const screen = screenLike(data, width, height);
  const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer;
  const issued = [];
  const ask = (k, message, transfer = []) => {
    message.key = id + ':' + k; message.ticket = ++tickets;
    let reply;
    try { reply = k ? Promise.resolve(helpers[k - 1].send(message, transfer)) : Promise.resolve(serveSplit(message)[0]); }
    catch (error) { reply = Promise.reject(error); }
    const answer = reply.then(answer => { if (answer?.error) throw Object.assign(new Error(answer.error.message), {name: answer.error.name}); return answer; });
    answer.catch(() => {});
    issued.push(answer);
    return answer;
  };
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
      const {pixels: view, offset} = rows(band), pixels = shared ? view : view.slice();
      return ask(k, {split: 'band', width, height: band.height, quality, data: pixels, offset, screen, gaborish}, shared ? [] : [pixels.buffer]);
    });
    const own = rows(bands[0]);
    first[0] = ask(0, {split: 'band', width, height: bands[0].height, quality, data: own.pixels, offset: own.offset, screen, gaborish});
    mark('own band');
    const done = await Promise.all(first);
    mark('bands');
    signal?.throwIfAborted();
    const orderCounts = [0, 1, 2].map(c => {
      const sum = new Uint32Array(64);
      for (const reply of done) for (let k = 0; k < 64; k++) sum[k] += reply.orderCounts[c][k];
      return sum;
    });
    const meta = done[0].meta, stride = Math.ceil(width / 8), blockRows = Math.ceil(height / 8);
    const orders = ordersFromCounts(orderCounts, 8, true, stride * blockRows);
    const components = meta.components.map((c, k) => {
      const dc = new Int16Array(stride * blockRows);
      let at = 0;
      for (const reply of done) { dc.set(reply.dc[k], at); at += reply.dc[k].length; }
      return {...c, rows: blockRows, coeffs: new Int16Array(0), dc};
    });
    const cflWidth = done[0].cfl.width, cfl = {width: cflWidth, x: new Int8Array(cflWidth * Math.ceil(height / 64)), b: new Int8Array(cflWidth * Math.ceil(height / 64))};
    let at = 0;
    for (const reply of done) { cfl.x.set(reply.cfl.x, at); cfl.b.set(reply.cfl.b, at); at += reply.cfl.x.length; }
    const image = {...meta, height, components, cfl, alpha: done.some(reply => reply.meta.alpha) ? data : null};
    const second = bands.map((_, k) => k ? ask(k, {split: 'count', orders}) : null);
    const dcCount = vdLfGroupCount(image), writers = Math.max(1, bands.length - 1), dcImage = {...image, alpha: null};
    const dcWriters = bands.length > 1
      ? Array.from({length: Math.min(writers, dcCount)}, (_, h) => ask(h + 1, {split: 'dc', image: dcImage, groups: Array.from({length: dcCount}, (_, g) => g).filter(g => g % writers === h)}))
      : [Promise.resolve(dcStep({image}))];
    second[0] = ask(0, {split: 'count', orders});
    mark('own count');
    const counted = await Promise.all(second);
    mark('counts');
    signal?.throwIfAborted();
    const counts = new TokenCounts(blockContexts(new Int32Array(0), 0, false).contexts);
    for (const reply of counted) addCounts(counts, reply);
    mark('merge');
    const clusters = {maxClusters: 64, newClusterCost: 100, seeds: 128}, options = {smallestMap: true, ...clusters}, coding = buildAnsCoding(counts, options);
    mark('coding');
    const third = bands.map((_, k) => k ? ask(k, {split: 'write', model: coding.model}) : null);
    third[0] = ask(0, {split: 'write', model: coding.model});
    mark('own write');
    const dcReplies = await Promise.all(dcWriters), dcGroups = {sections: [], modular16bit: dcReplies.every(reply => reply.modular16bit)};
    for (const reply of dcReplies) for (const {g, ...section} of reply.sections) dcGroups.sections[g] = section;
    mark('dc');
    const lfCoder = lfCoderFor(3);
    const plan = {coding: (c, o) => c === counts && o?.smallestMap && o?.seeds === 128 ? coding : buildAnsCoding(c, o),
      modularAns: writeModularAnsHistograms, lfCoder, clusters, fast: true, orders, pooled: true, abortable: false};
    seedLfSections(image, plan, dcGroups.sections);
    const steps = varDCTSteps(image, plan, {jpeg: image, countedByOrder: new Map([[orders, [counts]]]),
      modularAns: writeModularAnsHistograms, lfCoder, lfSections: dcGroups.sections, modular16bit: dcGroups.modular16bit});
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
    throw error;
  }
}
