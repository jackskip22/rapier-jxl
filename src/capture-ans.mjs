// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {hybridToken, writeUintConfig} from './prefix.mjs';
import {SCREEN_INTEGER_CONFIGS} from './screen-codes.mjs';
import {learnedModel, learnedModelSteps, letGoTrees} from './capture-trees.mjs';
import {colourTransform} from './rct-search.mjs';
import {fault} from './fault.mjs';
import {reverseAlias, shapeHistogram, writeModularAnsHeader, SYMBOL_BITS} from './ans-core.mjs';
import './kernels.mjs';
import {captureAnsTokens, captureAnsWrite, capturePrices} from './capture-kernels.mjs';
import {ANS_FIT, mergeCounts as joined, sharedHistograms, valueCounts} from './capture-modular-stream.mjs';
import {writeSmallestContextMap} from './context-map.mjs';

export {captureAnsTokens};

export function writeCaptureAns(header, data, {lz77, contextMap, configs, headerAware = false, mapWriter}, tokens) {
  const w = header;
  const {freqs} = tokens;
  let largest = 0;
  for (const f of freqs) for (let s = 255; s > largest; s--) if (f[s]) { largest = s; break; }
  const logAlphabet = Math.max(5, ceilLog2(largest + 1), ...configs.map(c => c.split));
  if (logAlphabet > 8) return false;
  const shapes = [];
  for (const f of freqs) {
    const shape = shapeHistogram(f, headerAware);
    if (!shape) return false;
    shapes.push({...shape, ...reverseAlias(shape.counts, logAlphabet)});
  }
  writeModularAnsHeader(w, lz77, contextMap, logAlphabet, configs, shapes, mapWriter ?? (headerAware ? writeSmallestContextMap : undefined));
  if (captureAnsWrite(data, tokens, shapes) === false) throw fault('JXL_INTERNAL', 'capture-ans:writer');
  return (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) ? shapes : true;
}

const PRE = 64, PRE_WIDE = 128, MAP_BITS = 3.2;
const PRE_CONFIG = /* @__PURE__ */ (() => ANS_FIT.find(c => c.split === 3 && c.msb === 1 && c.lsb === 1))();
const PRE_CONFIG_WIDE = /* @__PURE__ */ (() => ANS_FIT.find(c => c.split === 5 && c.msb === 2 && c.lsb === 0))();
const SPARE = [0, 0, 0];

function clusterModel(literals, trials = 3) {
  const ranked = [];
  for (let at = 0; at < ANS_FIT.length; at += 64) {
    const some = ANS_FIT.slice(at, at + 64), prices = capturePrices(some, literals);
    for (let c = 0; c < some.length; c++) if (prices[c * 2 + 1] < 256) ranked.push({config: some[c], estimate: prices[c * 2]});
  }
  ranked.sort((a, b) => a.estimate - b.estimate);
  let best = null;
  for (const {config} of ranked.slice(0, trials)) {
    const freqs = new Uint32Array(256);
    let extra = 0;
    for (let i = 0; i < literals.values.length; i++) {
      hybridToken(config, literals.values[i], SPARE);
      freqs[SPARE[0]] += literals.counts[i]; extra += SPARE[1] * literals.counts[i];
    }
    const shape = shapeHistogram(freqs, true);
    if (!shape) continue;
    const w = new BitWriter(8);
    writeUintConfig(w, config, 8);
    const bits = w.bitLength + shape.bits + extra;
    if (!best || bits < best.bits) best = {config, shape, bits};
  }
  return best;
}
function preTokens(literals, pre = PRE, cfg = PRE_CONFIG) {
  const freqs = new Float64Array(pre);
  let raw = 0;
  for (let i = 0; i < literals.values.length; i++) {
    hybridToken(cfg, literals.values[i], SPARE);
    freqs[Math.min(pre - 1, SPARE[0])] += literals.counts[i]; raw += SPARE[1] * literals.counts[i];
  }
  return {freqs, raw};
}
function preBits(freqs, raw) {
  let total = 0, used = 0, bits = raw;
  for (let s = 0; s < freqs.length; s++) total += freqs[s];
  if (!total) return 0;
  const log = Math.log2(total);
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) { bits += freqs[s] * (log - Math.log2(freqs[s])); used++; }
  return bits + 46 + 4.2 * used;
}
function valueBits(model, cap = 512) {
  const table = new Float64Array(cap), counts = model.shape.counts;
  for (let v = 0; v < cap; v++) {
    hybridToken(model.config, v, SPARE);
    const c = SPARE[0] < counts.length ? counts[SPARE[0]] : 0;
    table[v] = SPARE[0] > 255 ? Infinity : (c ? SYMBOL_BITS[c] : 13.5) + SPARE[1];
  }
  return v => {
    if (v < cap) return table[v];
    hybridToken(model.config, v, SPARE);
    const c = SPARE[0] < counts.length ? counts[SPARE[0]] : 0;
    return SPARE[0] > 255 ? Infinity : (c ? SYMBOL_BITS[c] : 13.5) + SPARE[1];
  };
}
export function exactClusters(units, limit = 64, passes = 3, wide = false) {
  const n = units.length, pre = wide ? PRE_WIDE : PRE, preCfg = wide ? PRE_CONFIG_WIDE : PRE_CONFIG;
  const trials = wide ? 8 : 3, vCap = wide ? 4096 : 512;
  let groups = units.map((literals, i) => ({members: [i], literals, constant: Boolean(literals.constant), ...preTokens(literals, pre, preCfg)}));
  for (const g of groups) g.pre = preBits(g.freqs, g.raw);
  const scratch = new Float64Array(pre);
  const merged = (a, b) => {
    if (a.constant !== b.constant) return Infinity;
    for (let s = 0; s < pre; s++) scratch[s] = a.freqs[s] + b.freqs[s];
    return preBits(scratch, a.raw + b.raw) - a.pre - b.pre;
  };
  const rises = new Map();
  const risen = (a, b) => {
    const key = a.uid * 1048576 + b.uid;
    let rise = rises.get(key);
    if (rise === undefined) { rise = merged(a, b); rises.set(key, rise); }
    return rise;
  };
  const EXACT_FROM = Math.max(limit + 6, 48);
  if (groups.length > EXACT_FROM) {
    const G = groups.length, alive = new Uint8Array(G).fill(1), near = new Int32Array(G).fill(-1), gain = new Float64Array(G);
    const nearest = a => {
      near[a] = -1; gain[a] = Infinity;
      for (let b = a + 1; b < G; b++) if (alive[b]) { const d = merged(groups[a], groups[b]); if (d < gain[a]) { gain[a] = d; near[a] = b; } }
    };
    for (let a = 0; a < G; a++) nearest(a);
    for (let left = G; left > EXACT_FROM; left--) {
      let a = -1;
      for (let i = 0; i < G; i++) if (alive[i] && near[i] >= 0 && (a < 0 || gain[i] < gain[a])) a = i;
      if (a < 0) break;
      const b = near[a], ga = groups[a], gb = groups[b];
      for (let s = 0; s < pre; s++) ga.freqs[s] += gb.freqs[s];
      ga.raw += gb.raw; ga.pre = preBits(ga.freqs, ga.raw); ga.members.push(...gb.members);
      ga.literals = joined(ga.literals, gb.literals); alive[b] = 0;
      nearest(a);
      for (let i = 0; i < G; i++) if (alive[i] && i !== a && (near[i] === a || near[i] === b)) nearest(i);
        else if (alive[i] && i < a) { const d = merged(groups[i], ga); if (d < gain[i]) { gain[i] = d; near[i] = a; } }
    }
    groups = groups.filter((_, i) => alive[i]);
  }
  for (const g of groups) { g.model = clusterModel(g.literals, trials); if (!g.model) return null; }
  const priced = new Map();
  let uid = 0;
  for (const g of groups) g.uid = uid++;
  while (groups.length > 1) {
    const pairs = [];
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) if (groups[a].constant === groups[b].constant) {
      const rise = risen(groups[a], groups[b]);
      if (pairs.length === 9 && !(rise < pairs[8][0])) continue;
      let at = pairs.length === 9 ? 8 : pairs.length;
      while (at > 0 && rise < pairs[at - 1][0]) { pairs[at] = pairs[at - 1]; at--; }
      pairs[at] = [rise, a, b];
    }
    let best = groups.length > limit ? Infinity : 0, take = null;
    for (const [, a, b] of pairs) {
      const key = groups[a].uid * 1048576 + groups[b].uid;
      let found = priced.get(key);
      if (!found) {
        const literals = joined(groups[a].literals, groups[b].literals), model = clusterModel(literals, trials);
        found = {literals, model, delta: model ? model.bits - groups[a].model.bits - groups[b].model.bits - MAP_BITS : Infinity};
        priced.set(key, found);
      }
      if (found.delta < best) { best = found.delta; take = [a, b, found]; }
    }
    if (!take) break;
    const [a, b, {literals, model}] = take, ga = groups[a], gb = groups[b];
    for (let s = 0; s < pre; s++) ga.freqs[s] += gb.freqs[s];
    ga.raw += gb.raw; ga.pre = preBits(ga.freqs, ga.raw); ga.members.push(...gb.members);
    ga.literals = literals; ga.model = model; ga.uid = uid++;
    groups.splice(b, 1);
  }
  let of = new Int32Array(n);
  groups.forEach((g, c) => { for (const m of g.members) of[m] = c; });
  let models = groups.map(g => ({...g.model, constant: g.constant}));
  for (let pass = 0; pass < passes && models.length > 1; pass++) {
    const costs = models.map(m => valueBits(m, vCap));
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const {values, counts, constant} = units[i], isConst = Boolean(constant);
      let to = of[i], least = Infinity;
      for (let c = 0; c < costs.length; c++) {
        if (models[c].constant !== isConst) continue;
        let bits = c === of[i] ? -0.25 : 0;
        for (let k = 0; k < values.length && bits < least; k++) bits += counts[k] * costs[c](values[k]);
        if (bits < least) { least = bits; to = c; }
      }
      if (to !== of[i]) { moved++; of[i] = to; }
    }
    if (!moved) break;
    const sums = models.map(() => null);
    for (let i = 0; i < n; i++) sums[of[i]] = sums[of[i]] ? joined(sums[of[i]], units[i]) : units[i];
    const remap = new Int32Array(models.length).fill(-1), next = [];
    for (let c = 0; c < sums.length; c++) if (sums[c]) {
      const model = clusterModel(sums[c], trials);
      if (!model) return null;
      remap[c] = next.length; next.push({...model, constant: models[c].constant});
    }
    of = of.map(c => remap[c]);
    models = next;
  }
  return {of, configs: models.map(m => m.config)};
}
export function writeSharedAns(groups, contexts, leaves) {
  const live = sharedHistograms(groups.flatMap(g => g.models), contexts);
  const clusters = exactClusters(live.map(h => valueCounts(h.small, h.large)), 255);
  if (!clusters) return null;
  const write = ({of, configs: all}) => {
    const remap = new Int32Array(all.length).fill(-1), order = [];
    const map = Uint8Array.from(leaves, context => { const g = of[context]; if (remap[g] < 0) { remap[g] = order.length; order.push(g); } return remap[g]; });
    const mapped = Int32Array.from(of, g => Math.max(0, remap[g])), configs = order.map(g => all[g]);
    const tokensOf = some => captureAnsTokens(some, mapped, configs, null, configs.length, some.reduce((n, m) => n + m.count, 0));
    const freqs = configs.map(() => new Uint32Array(256));
    for (const g of groups) {
      const tokens = tokensOf(g.models);
      if (!tokens) return null;
      tokens.freqs.forEach((f, h) => { for (let s = 0; s < 256; s++) freqs[h][s] += f[s]; });
    }
    const header = new BitWriter(1024), sections = groups.map(g => g.writer());
    const shapes = writeCaptureAns(header, sections[0], {lz77: null, contextMap: map, configs, headerAware: true, mapWriter: writeSmallestContextMap}, {...tokensOf(groups[0].models), freqs});
    if (!shapes) return null;
    for (let g = 1; g < groups.length; g++) if (captureAnsWrite(sections[g], tokensOf(groups[g].models), shapes) === false) throw fault('JXL_INTERNAL', 'capture-ans:writer');
    return {header, sections};
  };
  return write(clusters);
}
export function writeCrossChannelAns(models, live, index, contextMap, pieces, wide = false, limit = 64) {
  if (live.length < 2) return null;
  const clusters = exactClusters(live.map(h => ({...valueCounts(h.small, h.large), constant: Boolean(h.constant)})), limit, 3, wide);
  if (!clusters) return null;
  const remap = new Int32Array(clusters.configs.length).fill(-1), order = [];
  const map = Uint8Array.from(contextMap, previous => {
    const g = clusters.of[previous];
    if (remap[g] < 0) { remap[g] = order.length; order.push(g); }
    return remap[g];
  });
  const mapped = Int32Array.from(index, previous => remap[clusters.of[previous]]);
  const configs = order.map(g => clusters.configs[g]);
  const tokens = captureAnsTokens(models, mapped, configs, null, configs.length, pieces);
  if (!tokens) return null;
  const header = new BitWriter(1024), data = new BitWriter(tokens.n + 64);
  return writeCaptureAns(header, data, {lz77: null, contextMap: map, configs, headerAware: true, mapWriter: writeSmallestContextMap}, tokens)
    ? {header, data} : null;
}

function distanceConfig({values, counts}) {
  let best = null, least = Infinity;
  const token = [0, 0, 0];
  for (const config of SCREEN_INTEGER_CONFIGS) {
    const tally = new Map();
    let bits = 0, total = 0, fits = true;
    for (let i = 0; i < values.length && fits; i++) {
      hybridToken(config, values[i], token);
      if (token[0] > 255) fits = false;
      tally.set(token[0], (tally.get(token[0]) || 0) + counts[i]); bits += token[1] * counts[i]; total += counts[i];
    }
    if (!fits) continue;
    for (const c of tally.values()) bits += c * Math.log2(total / c);
    if (bits < least) { least = bits; best = config; }
  }
  return best;
}
function lengthConfig(live, room) {
  let best = null, least = Infinity;
  const token = [0, 0, 0];
  for (const config of SCREEN_INTEGER_CONFIGS) {
    let bits = 0, fits = true;
    for (const h of live) {
      if (!h.copies) continue;
      const tally = new Map(), {values, counts} = h.lengths;
      for (let i = 0; i < values.length && fits; i++) {
        hybridToken(config, values[i], token);
        if (token[0] >= room) fits = false;
        tally.set(token[0], (tally.get(token[0]) || 0) + counts[i]); bits += token[1] * counts[i];
      }
      for (const c of tally.values()) bits += c * Math.log2(h.copies / c);
    }
    if (fits && bits < least) { least = bits; best = config; }
  }
  return best;
}

export const CAPTURE_ANS = /* @__PURE__ */ Object.freeze({tokens: captureAnsTokens, write: writeCaptureAns, distanceConfig, lengthConfig});
export const CAPTURE_TOOLS_COMPLETE = /* @__PURE__ */ Object.freeze({top: 9, next: null, ans: CAPTURE_ANS,
  signs: !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true), trees: Object.freeze({model: learnedModel, steps: learnedModelSteps, letGo: letGoTrees}), transform: (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) ? colourTransform : null, gpu: Object.freeze({pixels: 1 << 20})});

export const writeCrossChannelAnsWide = (models, live, index, contextMap, pieces) => writeCrossChannelAns(models, live, index, contextMap, pieces, true, 96);
