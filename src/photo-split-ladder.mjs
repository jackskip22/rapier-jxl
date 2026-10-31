// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {PHOTO_BAND_MARGIN} from './photo-bands.mjs';
import {varDCTSteps, blockContexts, seedLfSections, vdLfGroupCount} from './vardct.mjs';
import {TokenCounts} from './entropy.mjs';
import {rungs, ansPlan, BUDGETS} from './coefficient-ans.mjs';
import {splitBands, serveSplit, splitImage, addCounts, dcStep, splitIds, splitRelease} from './photo-split.mjs';

function ladderContexts(image, fast) {
  const stride = Math.ceil(image.width / 8), rows = Math.ceil(image.height / 8), blocksTotal = stride * rows;
  const q = image.components[1].quant, quantSum = (q[8] + q[16] + q[24] + q[32] + q[40]) / (image.quantScale || 1);
  const wanted = fast || image.useDCFrame || blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - 6));
  if (!wanted) return blockContexts(new Int32Array(0), 0, false);
  return blockContexts(Int32Array.from(image.components[1].dc), wanted, false);
}
const ladderSerial = c => ({thresholds: c.thresholds, map: c.map, numDc: c.numDc, numCtxs: c.numCtxs});

export async function encodeSplitLadder(data, width, height, quality, helpers, {signal, effort = 4} = {}) {
  const {id, ticket} = splitIds(), bands = splitBands(height, helpers.length + 1), keys = bands.map((_, k) => id + ':' + k);
  const shared = typeof SharedArrayBuffer === 'function' && data.buffer instanceof SharedArrayBuffer, issued = [];
  const ask = (k, message, transfer = []) => {
    message.key = keys[k]; message.ticket = ticket();
    let reply;
    try { reply = k ? Promise.resolve(helpers[k - 1].send(message, transfer)) : Promise.resolve(serveSplit(message)[0]); }
    catch (error) { reply = Promise.reject(error); }
    const answer = reply.then(answer => { if (answer?.error) throw Object.assign(new Error(answer.error.message), {name: answer.error.name}); return answer; });
    answer.catch(() => {});
    issued.push(answer);
    return answer;
  };
  const rows = band => {
    const from = Math.max(0, band.top - PHOTO_BAND_MARGIN), to = Math.min(height, band.top + band.height + PHOTO_BAND_MARGIN);
    return {pixels: data.subarray(from * width * 4, to * width * 4), offset: band.top - from};
  };
  try {
    const first = bands.map((band, k) => {
      if (!k) return null;
      const {pixels: view, offset} = rows(band), pixels = shared ? view : view.slice();
      return ask(k, {split: 'band', width, height: band.height, quality, data: pixels, offset, gaborish: true, full: true}, shared ? [] : [pixels.buffer]);
    });
    const own = rows(bands[0]);
    first[0] = ask(0, {split: 'band', width, height: bands[0].height, quality, data: own.pixels, offset: own.offset, gaborish: true, full: true});
    const done = await Promise.all(first);
    signal?.throwIfAborted();
    const {image, orders} = splitImage(done, width, height, data, false);
    const dcCount = vdLfGroupCount(image), dcImage = {...image, alpha: null}, dcByKey = new Map();
    const dcFor = (lf, ans) => {
      const key = (lf ?? 0) + ':' + ans;
      if (!dcByKey.has(key)) {
        const writers = Math.max(1, bands.length - 1), groupsOf = h => Array.from({length: dcCount}, (_, g) => g).filter(g => g % writers === h);
        dcByKey.set(key, Promise.all(bands.length > 1
          ? Array.from({length: Math.min(writers, dcCount)}, (_, h) => ask(h + 1, {split: 'dc', image: dcImage, groups: groupsOf(h), lf, ans}))
          : [Promise.resolve(dcStep({image: {...image, components: image.components.map(c => ({...c}))}, lf, ans}))]).then(replies => {
          const sections = [];
          for (const reply of replies) for (const {g, ...section} of reply.sections) sections[g] = section;
          return {sections, modular16bit: replies.every(reply => reply.modular16bit)};
        }));
      }
      return dcByKey.get(key);
    };
    const natural = order => !(order && order.some(o => o.some((k, r) => k !== r)));
    const countsByKey = new Map(), countsFor = (fast, order) => {
      const key = (fast ? 'f' : 'b') + (natural(order) ? 'n' : 'o');
      if (!countsByKey.has(key)) {
        const contexts = ladderContexts(image, fast), serial = ladderSerial(contexts);
        countsByKey.set(key, Promise.all(bands.map((_, k) => ask(k, {split: 'count', orders: natural(order) ? null : order, contexts: serial}))).then(replies => {
          const counts = new TokenCounts(contexts.contexts);
          for (const reply of replies) addCounts(counts, reply);
          return counts;
        }));
      }
      return countsByKey.get(key);
    };
    async function candidate(plan, lf, ans) {
      const [counts, {sections, modular16bit}] = await Promise.all([countsFor(!!plan.fast, plan.orders), dcFor(lf, ans)]);
      const orderKey = natural(plan.orders) ? null : plan.orders;
      const cache = {jpeg: image, countedByOrder: new Map([[orderKey, [counts]]]), modular16bit, ...(plan.modularAns ? {modularAns: plan.modularAns} : {}), ...(plan.lfCoder ? {lfCoder: plan.lfCoder} : {})};
      if (plan.lfCoder && plan.modularAns) seedLfSections(image, plan, sections);
      else cache[ans ? 'ansDcSections' : 'dcSections'] = sections.map(section => Object.assign(new BitWriter(0), section));
      const steps = varDCTSteps(image, {...plan, pooled: true, abortable: false}, cache);
      let step, reply, answered = false;
      while (!(step = steps.next(reply)).done) {
        reply = undefined;
        const value = step.value;
        if (value?.kind !== 'ac-group') continue;
        const written = await Promise.all(bands.map((_, k) => ask(k, {split: 'write', frame: value.model, keep: true}))), results = [];
        for (const answer of written) results.push(...answer.sections);
        if (results.length !== value.groups) throw new Error('Split sections do not cover the frame.');
        reply = {results, errors: {}}; answered = true;
      }
      if (!answered) throw new Error('The frame asked for no AC sections.');
      return step.value;
    }
    const written = new Set(), keyOf = (rung, use) => (use === orders && use ? 'o' : use ? '?' : 'n') + ':' + (rung.lf ?? 0) + ':' + (rung.clusters ? BUDGETS.indexOf(rung.clusters) : -1);
    const ladder = [], later = [];
    for (const rung of rungs(effort)) {
      if (rung.orders === 'best') { later.push(rung); continue; }
      const use = rung.orders ? orders : null, key = keyOf(rung, use);
      if (rung.orders === true && !orders || written.has(key)) continue;
      written.add(key);
      ladder.push({plan: ansPlan(rung, use, effort), lf: rung.lf ?? null, ans: true, use});
    }
    for (const {lf, ans} of ladder) dcFor(lf, ans);
    for (const {plan} of ladder) countsFor(!!plan.fast, plan.orders);
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
