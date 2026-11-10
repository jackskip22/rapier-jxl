// SPDX-License-Identifier: MIT
import {xybStrategies, strategyImage, strategyTables, learnedOrderCounts, seedLearnedOrderCounts} from './varblocks.mjs';
import {maskEnergy, maskWeights} from './aq.mjs';
import {naturalOrder, TRANSFORMS} from './vardct-strategies.mjs';
import {serveSplit, splitIds, splitAsker, splitBands} from './photo-split.mjs';
import {designAsker} from './photo-split-ladder.mjs';
import {PHOTO_BAND_MARGIN, photoXYBBand, appendPhotoBand} from './photo-bands.mjs';
import {V6, GABORISH} from './photo-v6-settings.mjs';
import {BitWriter, complete} from './bits.mjs';
import {varDCTSteps, vdLfGroupCount, seedLfSections, acContexts, walkACGroup, designPriced, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF} from './vardct.mjs';
import {arenaKernels, releaseArena} from './kernels.mjs';
import {ARENA_BYTES} from './arena.mjs';
import {TokenCounts} from './entropy.mjs';
import {lfCoderFor} from './lf-coding.mjs';
import {writeModularAnsHistograms, ansGroupWriter, buildAnsCoding, ansCodingParts} from './ans.mjs';
import {kernelHooks} from './kernel-hooks.mjs';

function searchBand({key, orderCounts, stride, by0, by1, W, quant, cfl, quantFields, quantFieldBase, mask, search}) {
  const rows = by1 - by0, band = bandsHeld.get(key);
  if (!band) throw new Error('No picture band is held for this search.');
  const planes = band.planes; band.planes = null;
  const base = {components: quant.map(q => ({stride, rows, quant: q})), planes, cfl, ...(quantFields ? {quantFields, quantFieldBase} : {})};
  const {chosen} = xybStrategies(base, W, rows * 8, {...search, maskWeight: mask, priceOnly: true, keepChosen: true, band: true});
  let total = 0;
  for (const b of chosen) total += 3 * (b.size + b.area);
  const counted = orderCounts ? learnedOrderCounts(chosen).map((c3, id) => c3 && {id, c3}).filter(Boolean) : null;
  Object.assign(band, {chosen, by0});
  const levels = new Int32Array(total), head = new Int32Array(5 * chosen.length);
  let at = 0;
  chosen.forEach((b, i) => {
    head.set([b.id, b.bx, b.by + by0, at, (b.narrow ? 1 : 0) | (b.levels ? 2 : 0)], 5 * i);
    for (let c = 0; c < 3; c++) { levels.set(b.coeffs[c], at); at += b.size; }
    for (let c = 0; c < 3; c++) { levels.set(b.dc[c], at); at += b.area; }
  });
  return {head, levels, counted};
}

const bandsHeld = new Map();
function pictureBand({key, width, height, quality, data, offset, by0, by1, options}) {
  const result = photoXYBBand(data, width, Math.min(height, by1 * 8) - by0 * 8, quality, {...V6, ...GABORISH, ...options, keepPlanes: true}, offset);
  const stride = Math.ceil(width / 8), energy = new Float64Array(stride * (by1 - by0));
  maskEnergy(result.planes, 0, stride, 0, by1 - by0, energy);
  bandsHeld.set(key, {planes: result.planes});
  const {planes: _planes, components, cfl, ...meta} = result;
  return [{split: 'picture-band', key, meta, components: components.map(({h, v, stride, rows, quant}) => ({h, v, stride, rows, quant})), cfl, energy},
    [energy.buffer, cfl.x.buffer, cfl.b.buffer]];
}

const blockSteps = {
  'picture-band': message => { const t0 = performance.now(), answer = pictureBand(message); answer[0].ms = performance.now() - t0; return answer; },
  'group-rows': message => groupRows(message),
  lf: ({image, places, effort, groups}) => {
    const blocks = [];
    for (let i = 0; i < places.length; i += 3) blocks.push({id: places[i], bx: places[i + 1], by: places[i + 2]});
    const picture = {...image, strategyData: {blocks}}, sections = groups.map(g => {
      const {bytes, at, pending, acc, wide} = complete(varDCTSteps(picture, {...lfPlan(effort), lfGroup: g}));
      return {g, bytes, at, pending, acc, wide};
    });
    return [{split: 'lf', sections}, sections.map(s => s.bytes.buffer)];
  },
  designs: message => [{split: 'designs', ...designStep(message)}, []],
  blocks: message => {
    const t0 = performance.now(), {head, levels, counted} = searchBand(message);
    return [{split: 'blocks', head, levels, counted, ms: performance.now() - t0}, [head.buffer, levels.buffer, ...(counted ?? []).flatMap(({c3}) => c3.map(n => n.buffer))]];
  },
};
export function serveBlockSplit(message) {
  const kind = message?.split, step = blockSteps[kind];
  if (!step) { if (kind === 'drop') bandsHeld.delete(message.key); return serveSplit(message); }
  try { const answer = step(message); answer[0].ticket = message.ticket; return answer; }
  catch (error) {
    if (kind === 'picture-band') bandsHeld.delete(message.key);
    return [{split: kind, ticket: message.ticket, error: {name: String(error?.name ?? 'Error'), message: String(error?.message ?? error)}}, []];
  } finally { if (kind === 'designs') releaseArena(); }
}

function unpack({head, levels}, into) {
  for (let i = 0; i < head.length; i += 5) {
    const id = head[i], t = TRANSFORMS[id], bw = t.width / 8, bh = t.height / 8, area = bw * bh, size = area * 64, at = head[i + 3], d = at + 3 * size;
    const coeffs = [levels.subarray(at, at + size), levels.subarray(at + size, at + 2 * size), levels.subarray(at + 2 * size, d)];
    const dc = [levels.subarray(d, d + area), levels.subarray(d + area, d + 2 * area), levels.subarray(d + 2 * area, d + 3 * area)];
    const block = {id, bx: head[i + 1], by: head[i + 2], bw, bh, area, size, order: naturalOrder(bw, bh), coeffs, dc};
    if (head[i + 4] & 2) block.levels = levels.subarray(at, d);
    block.narrow = !!(head[i + 4] & 1);
    into.push(block);
  }
}

export const pictureBlocksSplit = (typeof __RAPIER_JXL_HELPER__ !== 'undefined' && __RAPIER_JXL_HELPER__ === true) ? null : async function pictureBlocksSplit(data, width, height, quality, row, search, helpers, {signal, arena = false} = {}, write = null) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), W = stride * 8;
  const bands = splitBands(rows, helpers.length + 1, 8).map(({top, height}) => ({by0: top, by1: top + height}));
  const {id, ticket} = splitIds(), keys = bands.map((_, k) => id + ':blocks:' + k);
  const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer, issued = [];
  const call = splitAsker(helpers, serveBlockSplit, issued), ask = (k, message, transfer) => call(k, message, keys[k], transfer);
  try {
    const pictured = bands.map((_, index) => {
      const k = bands.length - 1 - index, band = bands[k];
      const from = Math.max(0, band.by0 * 8 - PHOTO_BAND_MARGIN), to = Math.min(height, band.by1 * 8 + PHOTO_BAND_MARGIN);
      const view = data.subarray(from * width * 4, to * width * 4), pixels = k && !shared ? view.slice() : view;
      return ask(k, {split: 'picture-band', width, height, quality, data: pixels, offset: band.by0 * 8 - from, by0: band.by0, by1: band.by1, options: row},
        k && !shared ? [pixels.buffer] : []);
    }).reverse();
    const made = await Promise.all(pictured);
    globalThis.__jxlTrace?.push(['picture bands ' + made.map(a => Math.round(a.ms)).join(' '), performance.now()]);
    signal?.throwIfAborted();
    let image = null;
    const energy = new Float64Array(stride * rows);
    made.forEach((reply, k) => {
      const {by0, by1} = bands[k];
      image = appendPhotoBand(image, {...reply.meta, components: reply.components.map(c => ({...c, coeffs: new Int16Array(0)})), cfl: reply.cfl},
        width, height, by0 * 8, data);
      energy.set(reply.energy, by0 * stride);
    });
    if (bands.length === 1) image = {...image, components: image.components.map(c => ({...c, coeffs: new Int16Array(c.stride * c.rows * 64)}))};
    const mask = maskWeights(energy, stride, rows).weight;
    const quant = image.components.map(c => c.quant), cfl = image.cfl, {maskWeight: _mask, ...options} = search;
    const part = (a, lo, hi) => a.slice(lo, hi);
    const searchOf = ({by0, by1}, k) => ask(k, {split: 'blocks', orderCounts: true, stride, by0, by1, W, quant,
      cfl: {width: cfl.width, x: part(cfl.x, by0 / 8 * cfl.width, Math.ceil(by1 / 8) * cfl.width), b: part(cfl.b, by0 / 8 * cfl.width, Math.ceil(by1 / 8) * cfl.width)},
      quantFields: image.quantFields ? image.quantFields.slice(by0 * stride, by1 * stride) : null, quantFieldBase: image.quantFieldBase,
      mask: mask.slice(by0 * stride, by1 * stride), search: options});
    const searched = [];
    for (let k = bands.length - 1; k >= 0; k--) searched[k] = searchOf(bands[k], k);
    const lists = await Promise.all(searched.map(reply => reply.then(a => { const list = []; unpack(a, list); list.counted = a.counted; list.ms = a.ms; return list; })));
    signal?.throwIfAborted();
    globalThis.__jxlTrace?.push(['search bands ' + lists.map(l => Math.round(l.ms)).join(' '), performance.now()]);
    const chosen = lists.flat();
    const families = new Map();
    for (const b of chosen) families.set(TRANSFORMS[b.id].table, (families.get(TRANSFORMS[b.id].table) ?? 0) + 1);
    const varImage = [5, 4, 6].some(f => families.get(f) > 0 && families.get(f) < 8) ? null
      : strategyImage(image, chosen, strategyTables(image, [0, ...new Set(chosen.map(b => b.id))], search), !!search.perceptual).image;
    if (varImage) {
      const byBucket = [];
      for (const list of lists) for (const {id, c3} of list.counted) {
        if (!byBucket[id]) byBucket[id] = c3.map(n => new Uint32Array(n.length));
        c3.forEach((n, c) => { const into = byBucket[id][c]; for (let k = 0; k < n.length; k++) into[k] += n[k]; });
      }
      seedLearnedOrderCounts(varImage, byBucket);
    }
    const bytes = varImage && write ? await writeOnHelpers(write.steps(varImage), {bands, keys, ask, stride, rows, image: varImage, effort: write.effort, arena}) : null;
    signal?.throwIfAborted();
    return {image, mask, varImage, bytes};
  } finally {
    await Promise.allSettled(issued);
    bandsHeld.delete(keys[0]);
    const drops = [];
    for (let k = 1; k < bands.length; k++) {
      try { drops.push(Promise.resolve(helpers[k - 1].send({split: 'drop', key: keys[k], ticket: ticket()}, []))); } catch {}
    }
    await Promise.allSettled(drops);
  }
}

const countsOf = ({small, totals, large}) => Object.assign(new TokenCounts(totals.length), {small, totals, large: large.map(e => e ? new Map(e) : null)});
function designStep({list, at, small, totals, large, ...rest}, charge = ARENA_BYTES) {
  const kernels = arenaKernels(charge);
  if (!kernels) return {at, totals: null};
  const priced = designPriced(list, at, {...rest, counts: countsOf({small, totals, large})}, buildAnsCoding, kernels);
  return {at, totals: priced.map(p => p?.total ?? null), parts: rest.whole ? priced.map(p => p && ansCodingParts(p.codings[0])) : undefined, held: kernels.memoryBytes()};
}


function bandGroups(band, groupsX, stride) {
  if (band.groups) return band.groups;
  const groups = new Map();
  for (const b of band.chosen) {
    const g = ((b.by + band.by0) >> 5) * groupsX + (b.bx >> 5);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  for (const list of groups.values()) list.sort((a, b) => a.by - b.by || a.bx - b.bx);
  return band.groups = groups;
}
function groupState(model, band, g, groupsX, stride, rows, buckets, lumaW) {
  const bx0 = g % groupsX * 32, by0 = Math.floor(g / groupsX) * 32, bw = Math.min(32, stride - bx0), bh = Math.min(32, rows - by0);
  const lumaBuckets = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) lumaBuckets.set(buckets.subarray(y * lumaW + bx0, y * lumaW + bx0 + bw), y * bw);
  const blocks = (bandGroups(band, groupsX, stride).get(g) ?? []).map(({id, area, size, bw, bh, order, bx, by, coeffs}) => ({id, area, size, bw, bh, order, bx: bx - bx0, by: by + band.by0 - by0, coeffs}));
  return {...model, nzeros: [0, 1, 2].map(() => new Int32Array(32 * 32)), groupsX: 1, map: [0, 1, 2], counted: true, grey: false,
    hshifts: [0, 0, 0], vshifts: [0, 0, 0], xsizeBlocks: bw, ysizeBlocks: bh, lumaW: bw, lumaBuckets, strategyData: {groups: [blocks]}};
}
const withContexts = c => ({...c, ...acContexts(c.map, c.numDc, c.numCtxs)});
function groupRows({key, rowsList, model, groupsX, stride, rows, buckets, lumaW}) {
  const band = bandsHeld.get(key);
  if (!band?.chosen) throw new Error('No blocks are held for these groups.');
  const state0 = {...model, contexts: withContexts(model.contexts)};
  const coding = {...ansGroupWriter(model.coding), model: model.coding}, sections = [];
  for (let i = 0; i < rowsList.length; i++) for (let gx = 0; gx < groupsX; gx++) {
    const g = rowsList[i] * groupsX + gx, state = groupState(state0, band, g, groupsX, stride, rows, buckets[i], lumaW), w = new BitWriter(4096);
    try {
      if (kernelHooks.strategyWrite?.(state, 0, 0, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT, ORDER_OF, coding, w) !== 2) {
        walkACGroup(state, 0, (ctx, value) => coding.write(w, ctx, value)); coding.flush(w);
      }
    } finally { coding.reset?.(); }
    sections.push({g, bytes: w.bytes.slice(0, w.at + 8), at: w.at, pending: w.pending, acc: w.acc});
  }
  return [{split: 'group-rows', sections}, sections.map(s => s.bytes.buffer)];
}

const lfPlan = effort => ({modularAns: writeModularAnsHistograms, lfCoder: lfCoderFor(Math.max(5, effort))});
function askLfGroups(image, effort, bands, ask) {
  const n = vdLfGroupCount(image), workers = bands.length - 1;
  if (!workers || effort > 7 || image.alpha || image.auxiliary || !image.strategyData) return [];
  const {strategyData, components, ...rest} = image, blocks = strategyData.blocks, places = new Int32Array(3 * blocks.length);
  for (let i = 0; i < blocks.length; i++) { places[3 * i] = blocks[i].id; places[3 * i + 1] = blocks[i].bx; places[3 * i + 2] = blocks[i].by; }
  const slim = {...rest, components: components.map(({coeffs: _c, ...c}) => ({...c, coeffs: new Int16Array(0)}))}, asked = [];
  const later = Array.from({length: n}, (_, g) => g).slice(n > workers ? 0 : n > 1 ? 1 : 0);
  for (let h = 0; h < Math.min(workers, later.length); h++) {
    const groups = later.filter((_, i) => i % workers === h);
    asked.push(ask(h + 1, {split: 'lf', image: slim, places, effort, groups}).then(a => {
      const sections = [];
      for (const {g, ...section} of a.sections) sections[g] = section;
      seedLfSections(image, lfPlan(effort), sections);
    }));
  }
  return asked;
}
const nextTurn = () => new Promise(resolve => {
  if (typeof MessageChannel === 'function') { const {port1, port2} = new MessageChannel(); port1.onmessage = () => { port1.close(); resolve(); }; port2.postMessage(0); }
  else setTimeout(resolve, 0);
});

async function writeOnHelpers(steps, {bands, keys, ask, stride, rows, image, effort, arena}) {
  let lfPending = 0;
  const designs = designAsker(ask, bands.length - 1);
  const lf = askLfGroups(image, effort, bands, ask);
  for (const reply of lf) { lfPending++; reply.then(() => lfPending--, () => lfPending--); }
  const groupRowsCount = Math.ceil(rows / 32);
  const owner = Array.from({length: groupRowsCount}, (_, r) => {
    const top = r * 32, end = Math.min(rows, top + 32);
    for (let k = 1; k < bands.length; k++) if (bands[k].by0 <= top && end <= bands[k].by1) return k;
    return 0;
  });
  const byOwner = k => owner.map((o, r) => o === k ? r : -1).filter(r => r >= 0);
  const rowBuckets = (lumaBuckets, lumaW, r) => lumaBuckets.slice(r * 32 * lumaW, Math.min(rows, r * 32 + 32) * lumaW);
  let step, reply, turned = performance.now();
  while (!(step = steps.next(reply)).done) {
    const value = step.value;
    reply = undefined;
    if (typeof value === 'number') { if (lfPending && performance.now() - turned > 5) { await nextTurn(); turned = performance.now(); } continue; }
    if (!value) continue;
    if (value.kind === 'designs') { reply = arena ? await designs(value) : null; continue; }
    if (value.kind === 'ac-group') {
      const groupsX = Math.ceil(stride / 32), asked = [];
      for (let k = 1; k < bands.length; k++) {
        const list = byOwner(k);
        if (list.length) asked.push(ask(k, {split: 'group-rows', rowsList: list, model: value.model, groupsX, stride, rows, lumaW: value.lumaW,
          buckets: list.map(r => rowBuckets(value.lumaBuckets, value.lumaW, r))}));
      }
      const results = new Array(value.groups);
      for (let r = 0; r < groupRowsCount; r++) if (!owner[r]) for (let g = r * groupsX; g < Math.min(value.groups, (r + 1) * groupsX); g++) {
        const w = value.local(g);
        results[g] = {bytes: w.bytes.slice(0, w.at + 8), at: w.at, pending: w.pending, acc: w.acc};
      }
      for (const answer of await Promise.all(asked)) for (const {g, ...section} of answer.sections) results[g] = section;
      reply = {results, errors: {}};
    }
  }
  await Promise.allSettled(lf);
  return step.value;
}
