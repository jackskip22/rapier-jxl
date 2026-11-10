// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {uploadFlat, uploadGrain} from './photo-v6-settings.mjs';
import {varDCTSteps, blockContexts, seedLfSections, vdLfGroupCount, designPriced} from './vardct.mjs';
import {TokenCounts} from './entropy.mjs';
import {rungs, ansPlan, BUDGETS} from './coefficient-ans.mjs';
import {buildAnsCoding, ansCodingFrom} from './ans.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {splitBands, serveSplit, splitImage, addCounts, dcStep, splitIds, splitRelease, splitAsker} from './photo-split.mjs';

function ladderContexts(image, fast) {
  const stride = Math.ceil(image.width / 8), rows = Math.ceil(image.height / 8), blocksTotal = stride * rows;
  const q = image.components[1].quant, quantSum = (q[8] + q[16] + q[24] + q[32] + q[40]) / (image.quantScale || 1);
  const wanted = fast || image.useDCFrame || blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - 6));
  if (!wanted) return blockContexts(new Int32Array(0), 0, false);
  return blockContexts(Int32Array.from(image.components[1].dc), wanted, false);
}
const ladderSerial = c => ({thresholds: c.thresholds, map: c.map, numDc: c.numDc, numCtxs: c.numCtxs});

export const designAsker = (typeof __RAPIER_JXL_HELPER__ !== 'undefined' && __RAPIER_JXL_HELPER__ === true) ? null : function designAsker(send, count) {
  let next = 0;
  return async value => {
    if (value.coding !== buildAnsCoding) return null;
    const {list, counts} = value, priced = new Array(list.length).fill(), whole = [], parts = [];
    const info = {lumaDc: value.lumaDc, wanted: value.wanted, grey: value.grey, fine: value.fine, clusters: value.clusters};
    const shares = Array.from({length: count}, () => []);
    for (let i = 0; i < list.length; i++) shares[(next + i) % count].push(i);
    next = (next + list.length) % count;
    const message = {split: 'designs', list, small: counts.small, totals: counts.totals, large: counts.large.map(m => m ? [...m] : null), ...info, whole: true};
    const answers = await Promise.all(shares.map((at, h) => at.length ? send(h + 1, {...message, at}).catch(() => null) : null));
    for (const answer of answers) if (answer?.totals) answer.at.forEach((i, j) => { priced[i] = answer.totals[j]; parts[i] = answer.parts?.[j] ?? null; });
    const missing = priced.map((t, i) => t === undefined ? i : -1).filter(i => i >= 0);
    if (missing.length) designPriced(list, missing, {counts, ...info}, buildAnsCoding, kernelHooks.entropy?.()).forEach((p, j) => { priced[missing[j]] = p?.total ?? null; whole[missing[j]] = p; });
    globalThis.__jxlTrace?.push(['designs priced on ' + (list.length - missing.length) + ' of ' + list.length + ' by helpers', performance.now()]);
    return {totals: priced, priced: whole, coding: i => parts[i] ? ansCodingFrom(parts[i], kernelHooks.entropy?.()) : null};
  };
}

export const encodeSplitLadder = (typeof __RAPIER_JXL_HELPER__ !== 'undefined' && __RAPIER_JXL_HELPER__ === true) ? null : async function encodeSplitLadder(data, width, height, quality, helpers, {signal, effort = 4, arena = false, uploadFlat: knownFlat, grain: knownGrain} = {}) {
  const commonUpload = effort === 4 || effort === 5, flat = commonUpload && (knownFlat ?? uploadFlat(data, width, height));
  const grain = commonUpload && !flat && (knownGrain ?? uploadGrain(data, width, height));
  const {id, ticket} = splitIds(), bands = splitBands(height, helpers.length + 1), keys = bands.map((_, k) => id + ':' + k);
  const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer, issued = [];
  const call = splitAsker(helpers, serveSplit, issued), ask = (w, message, transfer) => call(w, message, keys[w], transfer);
  const rows = band => {
    const from = Math.max(0, band.top - PHOTO_BAND_MARGIN), to = Math.min(height, band.top + band.height + PHOTO_BAND_MARGIN);
    return {pixels: data.subarray(from * width * 4, to * width * 4), offset: band.top - from};
  };
  try {
    const first = bands.map((band, k) => {
      if (!k) return null;
      const {pixels: view, offset} = rows(band), pixels = shared ? view : view.slice();
      return ask(k, {split: 'band', width, height: band.height, quality, data: pixels, offset, gaborish: true, full: true, upload: commonUpload, uploadFlat: flat, grain}, shared ? [] : [pixels.buffer]);
    });
    const own = rows(bands[0]);
    first[0] = ask(0, {split: 'band', width, height: bands[0].height, quality, data: own.pixels, offset: own.offset, gaborish: true, full: true, upload: commonUpload, uploadFlat: flat, grain});
    let image, orders;
    let dcCount, dcImage;
    const dcByKey = new Map();
    const dcFor = (lf, ans, own = null) => {
      const key = (lf ?? 0) + ':' + ans;
      if (!dcByKey.has(key)) {
        const writers = helpers.length, groupsOf = slot => Array.from({length: dcCount}, (_, g) => g).filter(g => g % (writers + 1) === slot);
        const asked = Array.from({length: writers}, (_, h) => groupsOf(h)).flatMap((groups, h) => groups.length ? [ask(h + 1, {split: 'dc', image: dcImage, groups, lf, ans, arena})] : []);
        const here = groupsOf(writers);
        if (here.length) globalThis.__jxlTrace?.push(['ladder: ' + here.length + ' DC groups here', performance.now()]);
        if (here.length) asked.push(new Promise(resolve => (own ?? (run => run()))(() => resolve(dcStep({image: {...image, components: image.components.map(c => ({...c}))}, groups: here, lf, ans})))));
        dcByKey.set(key, Promise.all(asked).then(replies => {
          const sections = [];
          for (const reply of replies) for (const {g, ...section} of reply.sections) sections[g] = section;
          return {sections, modular16bit: replies.every(reply => reply.modular16bit)};
        }));
      }
      return dcByKey.get(key);
    };
    const natural = order => !(order && order.some(o => o.some((k, r) => k !== r)));
    const countsByKey = new Map(), ownCounts = [], countsFor = (fast, order, own = null) => {
      const key = (fast ? 'f' : 'b') + (natural(order) ? 'n' : 'o');
      if (!countsByKey.has(key)) {
        const contexts = ladderContexts(image, fast), message = () => ({split: 'count', orders: natural(order) ? null : order, contexts: ladderSerial(contexts)});
        const replies = bands.map((_, k) => k ? ask(k, message()) : null);
        const mine = new Promise(resolve => (own ?? (run => run()))(() => resolve(ask(0, message()))));
        replies[0] = mine;
        countsByKey.set(key, Promise.all(replies).then(replies => {
          const counts = new TokenCounts(contexts.contexts);
          for (const reply of replies) addCounts(counts, reply);
          return counts;
        }));
      }
      return countsByKey.get(key);
    };
    const designsOnHelpers = designAsker(ask, helpers.length), acByKey = {};
    async function candidate(plan, lf, ans) {
      const [counts, {sections, modular16bit}] = await Promise.all([countsFor(!!plan.fast, plan.orders), dcFor(lf, ans)]);
      const orderKey = natural(plan.orders) ? null : plan.orders;
      const ac = acByKey[keyOf(plan, orderKey)] ??= {};
      const cache = {jpeg: image, countedByOrder: new Map([[orderKey, [counts]]]), modular16bit, ...(plan.modularAns ? {modularAns: plan.modularAns} : {}), ...(plan.lfCoder ? {lfCoder: plan.lfCoder} : {})};
      if (plan.lfCoder && plan.modularAns) seedLfSections(image, plan, sections);
      else cache[ans ? 'ansDcSections' : 'dcSections'] = sections.map(section => Object.assign(new BitWriter(0), section));
      const steps = varDCTSteps(image, {...plan, pooled: true, abortable: false, ...(arena && helpers.length ? {remoteDesigns: true} : {})}, cache);
      let step, reply, answered = false;
      while (!(step = steps.next(reply)).done) {
        reply = undefined;
        const value = step.value;
        if (value?.kind === 'designs') { reply = await (ac.designs ??= designsOnHelpers(value)); continue; }
        if (value?.kind !== 'ac-group') continue;
        const written = await (ac.written ??= Promise.all(bands.map((_, k) => ask(bands.length - 1 - k, {split: 'write', frame: value.model, keep: true})).reverse()));
        const results = written.flatMap(answer => answer.sections);
        if (results.length !== value.groups) throw new Error('Split sections do not cover the frame.');
        reply = {results, errors: {}}; answered = true;
      }
      if (!answered) throw new Error('The frame asked for no AC sections.');
      return step.value;
    }
    const written = new Set(), keyOf = (rung, use) => (use === orders && use ? 'o' : use ? '?' : 'n') + ':' + (rung.lf ?? 0) + ':' + (rung.clusters ? BUDGETS.indexOf(rung.clusters) : -1);
    const ladder = [], later = [];
    const ready = Promise.all(first).then(done => {
      ({image, orders} = splitImage(done, width, height, data, false));
      dcCount = vdLfGroupCount(image); dcImage = {...image, alpha: null};
      for (const rung of rungs(effort)) {
        if (rung.orders === 'best') { later.push(rung); continue; }
        const use = rung.orders ? orders : null, key = keyOf(rung, use);
        if (rung.orders === true && !orders || written.has(key)) continue;
        written.add(key);
        ladder.push({plan: ansPlan(rung, use, effort), lf: rung.lf ?? null, ans: true, use});
      }
      const ownDc = [];
      for (const {lf, ans} of ladder) dcFor(lf, ans, run => ownDc.push(run));
      for (const {plan} of ladder) countsFor(!!plan.fast, plan.orders, run => ownCounts.push(run));
      for (const run of [...ownCounts.splice(0), ...ownDc]) run();
    });
    await ready;
    signal?.throwIfAborted();
    const files = await Promise.all(ladder.map(({plan, lf, ans}) => candidate(plan, lf, ans)));
    let best = files[0], bestOrders = ladder[0].use;
    for (let i = 1; i < ladder.length; i++) if (files[i].length < best.length) { best = files[i]; bestOrders = ladder[i].use; }
    for (const rung of later) {
      signal?.throwIfAborted();
      const use = bestOrders, key = keyOf(rung, use);
      if (written.has(key)) continue;
      written.add(key);
      const bytes = await candidate(ansPlan(rung, use, effort), rung.lf ?? null, true);
      if (bytes.length < best.length) { best = bytes; bestOrders = use; }
    }
    return best;
  } finally {
    await Promise.allSettled(issued);
    splitRelease(keys[0]);
    const drops = [];
    for (let k = 1; k < bands.length; k++) {
      try { drops.push(Promise.resolve(helpers[k - 1].send({split: 'drop', key: keys[k], ticket: ticket()}, []))); } catch {}
    }
    await Promise.allSettled(drops);
  }
}
