// SPDX-License-Identifier: MIT
import {s2CellMap} from './s2-cells.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';
import {stage} from './step-journal.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };

const AQ_SCALES = /* @__PURE__ */ Object.freeze([1.0, 0.76, 0.88, 1.12, 1.28]);
const DZ_SCALES = /* @__PURE__ */ Object.freeze([1.0, 0.66, 0.74, 0.82, 0.90, 1.12, 1.25, 1.42, 1.62]);
const DZ_SCALES_HUGE = /* @__PURE__ */ Object.freeze([1.0, 0.68, 0.78, 0.88, 1.16, 1.32, 1.54]);
const CFL_COARSE_SMALL = /* @__PURE__ */ Object.freeze([0, -20, -12, -7, -4, -2, 2, 4, 7, 12, 20, 999]);
const CFL_COARSE_HUGE = /* @__PURE__ */ Object.freeze([0, -12, -5, 5, 12, 999]);
const CFL_FINE = /* @__PURE__ */ Object.freeze([0, -2, -1, 1, 2]);
const HUGE_PIXELS = 2500000;
const LIBJXL_OVER = 0.02;
const RATE_STRENGTHS = /* @__PURE__ */ Object.freeze([0.84, 0.92, 1.08, 1.16]);

function* rendered(make, q, config, reference, width, height, at, tag, held, cellSums) {
  return yield* stage(tag, function* () {
    const picture = yield* make(q, config), rate = picture.rates;
    const {cells, score, norms} = s2CellMap(yield* cellSums(picture, reference, width, height, false, held), width, height, at);
    let D = 0, R = 0;
    for (let i = 0; i < cells.length; i++) { D += cells[i]; R += rate[i]; }
    return {cells, rate, score, norms, D, R};
  });
}

const groupOf = (b, columns) => (b.by >> 5) * columns + (b.bx >> 5);
function codedOrder(layout, stride) {
  const columns = Math.ceil(stride / 32), before = (a, b) => groupOf(a, columns) - groupOf(b, columns) || a.by - b.by || a.bx - b.bx;
  for (let i = 1; i < layout.length; i++) if (before(layout[i - 1], layout[i]) > 0) return [...layout].sort(before);
  return layout;
}
export function viterbiField(maps, width, height, given, mu) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), n = stride * rows, layout = codedOrder(given, stride);
  const T = maps[0].D, switchPenalty = 0.00075 * T;
  const K = AQ_SCALES.length, nb = layout.length;
  const dp = new Float64Array(nb * K), back = new Int32Array(nb * K);
  let ones = 0;
  for (let bi = 0; bi < nb; bi++) {
    const b = layout[bi], t = TRANSFORMS[b.id], bw = Math.max(1, t.width >> 3), bh = Math.max(1, t.height >> 3);
    for (let k = 0; k < K; k++) {
      let m = 0;
      for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) m += maps[k].cells[(b.by + dy) * stride + b.bx + dx];
      const cost = m + mu * (maps[k].rate[b.by * stride + b.bx] + (k === 0 ? 0.4 : 2.8));
      if (k === 0) ones += cost;
      if (bi === 0) { dp[k] = cost; continue; }
      let bestPrev = Infinity, bestP = 0;
      for (let p = 0; p < K; p++) {
        const v = dp[(bi - 1) * K + p] + (p === k ? 0 : switchPenalty * (1 + Math.abs(Math.log(AQ_SCALES[k] / AQ_SCALES[p]))));
        if (v < bestPrev) { bestPrev = v; bestP = p; }
      }
      dp[bi * K + k] = bestPrev + cost; back[bi * K + k] = bestP;
    }
  }
  let bestK = 0;
  for (let k = 1; k < K; k++) if (dp[(nb - 1) * K + k] < dp[(nb - 1) * K + bestK]) bestK = k;
  if (!(dp[(nb - 1) * K + bestK] < ones)) return null;
  const chosen = new Int32Array(nb);
  chosen[nb - 1] = bestK;
  for (let bi = nb - 1; bi > 0; bi--) chosen[bi - 1] = back[bi * K + chosen[bi]];
  const field = new Float64Array(n).fill(1);
  let nonUniform = 0;
  for (let bi = 0; bi < nb; bi++) {
    const b = layout[bi], s = AQ_SCALES[chosen[bi]];
    if (chosen[bi] !== 0) nonUniform++;
    const t = TRANSFORMS[b.id], bw = Math.max(1, t.width >> 3), bh = Math.max(1, t.height >> 3);
    for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) field[(b.by + dy) * stride + b.bx + dx] = s;
  }
  if (nonUniform < 8) return null;
  let logSum = 0;
  for (let i = 0; i < n; i++) logSum += Math.log(field[i]);
  const mean = Math.exp(logSum / n);
  for (let i = 0; i < n; i++) field[i] /= mean;
  return field;
}

function deadzoneMapOf(maps, scales, idxs, width, height, layout, mu) {
  const stride = Math.ceil(width / 8), out = new Float64Array(stride * Math.ceil(height / 8)).fill(1);
  for (const b of layout) {
    const t = TRANSFORMS[b.id], bw = Math.max(1, t.width >> 3), bh = Math.max(1, t.height >> 3);
    let best = idxs[0], bestJ = Infinity;
    for (const k of idxs) {
      let m = 0;
      for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) m += maps[k].cells[(b.by + dy) * stride + b.bx + dx];
      const J = m + mu * maps[k].rate[b.by * stride + b.bx];
      if (J < bestJ) { bestJ = J; best = k; }
    }
    for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) out[(b.by + dy) * stride + b.bx + dx] = scales[best];
  }
  return out;
}

function tileCosts(r, cfl, ch, width, height) {
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), tw = cfl.width, nTiles = tw * Math.ceil(rows / 8);
  const tDist = new Float64Array(nTiles), tRate = new Float64Array(nTiles), v = cfl[ch];
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
    const idx = by * stride + bx, ti = (by >> 3) * tw + (bx >> 3);
    tDist[ti] += r.cells[idx]; tRate[ti] += r.rate[idx];
  }
  for (let ti = 0; ti < nTiles; ti++) {
    const diff = Math.abs(v[ti] - (ti % tw > 0 ? v[ti - 1] : 0));
    tRate[ti] += diff === 0 ? 1.1 : 1.8 + Math.log2(1 + diff * 2);
  }
  return {tDist, tRate};
}
const shifted = (v, d) => Int8Array.from(v, x => d === 999 ? 0 : Math.max(-128, Math.min(127, x + d)));

function* landStrengthSteps(probeAt, maxProbes, signal) {
  let pass = null, fail = null;
  const probe = function* (s) { check(signal); const r = yield* probeAt(Math.round(s * 1000) / 1000); return {...r, s: Math.round(s * 1000) / 1000}; };
  let cur = yield* probe(1), n = 1;
  if (cur.pass) pass = cur; else fail = cur;
  for (let step = 0.12; n < maxProbes && (!pass || !fail); n++, step *= 1.6) {
    cur = yield* probe(pass ? pass.s + step : fail.s - step);
    if (cur.pass) { if (!pass || cur.s > pass.s) pass = cur; } else if (!fail || cur.s < fail.s) fail = cur;
    if (!pass && cur.s < 0.5) break;
  }
  while (n < maxProbes && pass && fail && fail.s - pass.s > 0.012) {
    cur = yield* probe((pass.s + fail.s) / 2); n++;
    if (cur.pass) pass = cur; else fail = cur;
  }
  return pass;
}

function* landFineSteps(buildAt, qSeed, targetS2, libjxlFloor, evalProbe, maxProbes = 10, signal) {
  const tried = new Map();
  const probe = function* (q) {
    check(signal);
    const rq = Math.max(1, Math.min(99.9, Math.round(q * 200) / 200));
    if (tried.has(rq)) return tried.get(rq);
    const obs = yield* evalProbe(rq, buildAt);
    tried.set(rq, obs);
    return obs;
  };

  let cur = yield* probe(qSeed);
  let bestPass = cur.pass ? cur : null, highFail = !cur.pass ? cur : null;
  let slope = 0.85;

  for (let i = 0; i < 5 && (!bestPass || !highFail); i++) {
    let step;
    if (cur.pass) {
      const room = Math.min(cur.s2 - targetS2, cur.libS2 - libjxlFloor);
      step = -Math.max(0.18, (room + 0.025) / slope);
    } else if (cur.s2 >= targetS2 && cur.libS2 < libjxlFloor) {
      step = Math.max(0.2, (libjxlFloor + 0.015 - cur.libS2) / 0.45);
    } else {
      step = Math.max(0.18, (targetS2 + 0.015 - cur.s2) / slope);
    }
    step = Math.max(-4.0, Math.min(4.0, step));
    const prev = cur;
    cur = yield* probe(cur.q + step);
    if (Math.abs(cur.q - prev.q) > 0.02 && Math.abs(cur.s2 - prev.s2) > 1e-4)
      slope = Math.max(0.2, Math.min(2.2, (cur.s2 - prev.s2) / (cur.q - prev.q)));
    if (cur.pass && (!bestPass || cur.q < bestPass.q)) bestPass = cur;
    if (!cur.pass && (!highFail || cur.q > highFail.q)) highFail = cur;
  }

  while (tried.size < maxProbes && bestPass) {
    const room = Math.min(bestPass.s2 - targetS2, bestPass.libS2 - libjxlFloor);
    if (room <= 0.004 && (!highFail || bestPass.q - highFail.q <= 0.01)) break;
    let nextQ;
    if (highFail && highFail.q < bestPass.q) {
      if (bestPass.q - highFail.q <= 0.005) break;
      const libBinds = highFail.s2 >= targetS2 && highFail.libS2 < libjxlFloor;
      if (!libBinds && bestPass.s2 - highFail.s2 > 1e-4 && highFail.s2 < targetS2) {
        const sec = highFail.q + ((targetS2 + 0.003 - highFail.s2) / (bestPass.s2 - highFail.s2)) * (bestPass.q - highFail.q);
        nextQ = Math.max(highFail.q + 0.005, Math.min(bestPass.q - 0.005, sec));
      } else nextQ = (highFail.q + bestPass.q) / 2;
    } else nextQ = bestPass.q - Math.max(0.025, room / slope);
    const r = yield* probe(nextQ);
    if (r.pass) {
      if (r.q < bestPass.q) bestPass = r;
      else break;
    } else {
      if (!highFail || r.q > highFail.q) highFail = r;
      else break;
    }
  }
  return bestPass;
}


export function* photoEffortTenPass2Steps(args) {
  const held = {cells: {}, rebuild: {}, constants: null};
  try { return yield* pass2Steps(args, held); } finally { held.cells.release?.(); held.rebuild.release?.(); }
}
function* pass2Steps({
  provider, data, width, height, quality, nineBytes, nineScore, nineFloor, recipes,
  pruneLayout, plainLayout, planeLayoutSteps, cellSums, scoreExact, scoreLibjxl, writeAtNine, writeAtTen, recipeAt, journal, banded, offloading, signal,
}, held) {
  const targetS2 = Math.max(nineFloor ?? 0, nineScore);
  const nineLibjxl = recipes[0]?.libjxl;
  let libjxlFloor = Math.max((nineFloor ?? nineScore) - 0.9, Number.isFinite(nineLibjxl) ? nineLibjxl + LIBJXL_OVER : -Infinity);
  const pixels = width * height, huge = pixels > HUGE_PIXELS;
  let bestBytes = nineBytes, bestScore = nineScore, seq = 0;
  const keepIfBetter = (candBytes, s2, libS2) => {
    if (candBytes && candBytes.length < bestBytes.length && s2 >= targetS2 && libS2 >= libjxlFloor) {
      bestBytes = candBytes;
      bestScore = s2;
    }
  };

  const gentleChromaDz = quality > 85;
  const blocksOf = rec => ({...(rec.providerBlocks || !rec.options ? provider.blockOptions() : {}), ...(rec.options ?? {})});
  const evalProbe = (rq, buildAt) => stage(`e10-probe-${seq++}`, function* () {
    const img = yield* buildAt(rq);
    const s2 = yield* scoreExact(img);
    const libS2 = s2 >= targetS2 ? yield* scoreLibjxl(img) : -Infinity;
    return {q: rq, s2, libS2, pass: s2 >= targetS2 && libS2 >= libjxlFloor};
  });

  const primary = recipes[0];
  if (!primary) return {bytes: bestBytes, score: bestScore};
  const primeBase = yield* provider.baseSteps(primary.quality, {keepPlanes: true});
  yield* provider.baseSteps(primary.quality > 85 ? 80 : 90, {keepPlanes: true});
  {
    const q9 = primary.quality, buildExact9 = recipeAt(primary, pruneLayout(primary.layout) ?? plainLayout(primeBase));
    const obs9 = yield* evalProbe(q9, buildExact9);
    if (!Number.isFinite(nineLibjxl) && obs9.s2 === nineScore && Number.isFinite(obs9.libS2)) {
      libjxlFloor = Math.max(libjxlFloor, obs9.libS2 + LIBJXL_OVER);
      obs9.pass = obs9.s2 >= targetS2 && obs9.libS2 >= libjxlFloor;
    }
    const same = obs9.s2 === nineScore && (!Number.isFinite(nineLibjxl) || obs9.libS2 === nineLibjxl);
    if (same || obs9.pass) {
      const e10Rewrite = yield* writeAtTen(yield* buildExact9(q9), `seed9`);
      if (same) { if (e10Rewrite && e10Rewrite.length < bestBytes.length) bestBytes = e10Rewrite; }
      else keepIfBetter(e10Rewrite, obs9.s2, obs9.libS2);
    }
  }

  const activeRecipes = huge ? recipes.slice(0, 1) : recipes.slice(0, 2);
  const reference = {rgba: data};
  let bestPass2 = null;

  for (let ri = 0; ri < activeRecipes.length; ri++) {
    check(signal);
    const rec = activeRecipes[ri], tag = `r${ri}`, span = part => 0.12 + 0.78 * ((ri + part) / activeRecipes.length);
    const q0 = rec.quality, baseSample = yield* provider.baseSteps(q0, {keepPlanes: true});
    const layout = pruneLayout(rec.layout) ?? plainLayout(baseSample);
    const epfScale = rec.epfScale ?? 1.0;
    const blocks = {...blocksOf(rec), ...(rec.transforms && {transforms: rec.transforms})};
    delete blocks.deadzoneMap;
    delete blocks.rated;
    const options = (deadzoneMap, extra) => ({...blocks, ...(gentleChromaDz && {gentleChromaDz: true}), ...(deadzoneMap && {deadzoneMap}), ...extra});
    const base = function* (p, fieldScale, cfl) {
      let made = yield* provider.baseSteps(p, {keepPlanes: true, ...(fieldScale && {fieldScale}), ...(cfl && {cfl})});
      if (epfScale !== 1.0 && made.epf) made = {...made, epf: made.epf * epfScale};
      return made;
    };
    const make = (p, {fieldScale = null, cfl = null, deadzoneMap = null}) => (function* () {
      const b = yield* base(p, fieldScale, cfl), o = options(deadzoneMap, {rated: true});
      return journal || (banded || offloading()) && b.rowsRecipe ? provider.lazy(b, layout, o, false) : yield* planeLayoutSteps(b, width, height, layout, o, signal);
    })();
    const makeCoding = ({fieldScale = null, cfl = null, deadzoneMap = null}, compact) => function* (p) {
      const b = yield* base(p, fieldScale, cfl);
      const o = options(deadzoneMap, compact ? {compactDct8: true, tableBands: 6, dct8Bands: 8} : {compactDct8: false});
      return journal || (banded || offloading()) && b.rowsRecipe ? provider.lazy(b, layout, o, true) : yield* planeLayoutSteps(b, width, height, layout, o, signal);
    };

    let config = {fieldScale: rec.field ?? null, cfl: null, deadzoneMap: rec.options?.deadzoneMap ?? null};
    let cur = yield* rendered(make, q0, config, reference, width, height, null, `e10-${tag}-at`, held, cellSums);
    const at = {norms: cur.norms}, side = [], ones = new Float64Array(Math.ceil(width / 8) * Math.ceil(height / 8)).fill(1);
    for (const st of RATE_STRENGTHS) side.push(yield* rendered(make, q0, {...config, deadzoneMap: Float64Array.from(config.deadzoneMap ?? ones, v => v * st)}, reference, width, height, at, `e10-${tag}-side${st}`, held, cellSums));
    const meanD = side.reduce((a, r) => a + r.D, 0) / side.length, meanR = side.reduce((a, r) => a + r.R, 0) / side.length;
    const mu = -side.reduce((a, r) => a + (r.D - meanD) * (r.R - meanR), 0) / side.reduce((a, r) => a + (r.R - meanR) ** 2, 0);
    const render = (cfg, label, q = q0) => rendered(make, q, cfg, reference, width, height, at, `e10-${tag}-${label}`, held, cellSums);
    const gateCompact = huge ? !!blocks.compactDct8 : true;
    const landAt = function* (cfg, label, compact = gateCompact) {
      const map = cfg.deadzoneMap ?? ones, at = st => makeCoding({...cfg, deadzoneMap: Float64Array.from(map, v => v * st)}, compact);
      const landed = yield* landStrengthSteps(st => evalProbe(q0, () => at(st)(q0)), huge ? 7 : 9, signal);
      if (!landed?.pass) return null;
      const build = at(landed.s), buildAt = () => build(q0), file = yield* writeAtNine(yield* buildAt(), `${tag}-${label}`);
      keepIfBetter(file, landed.s2, landed.libS2);
      const out = {bytes9: file, landed: {...landed, q: q0}, buildAt};
      if (!bestPass2 || file.length < bestPass2.bytes9.length) bestPass2 = out;
      return out;
    };
    let kept = yield* landAt(config, 'base');
    const gate = function* (cfg, label) {
      const landed = yield* landAt(cfg, label);
      if (!landed || kept && landed.bytes9.length >= kept.bytes9.length) return false;
      kept = landed; config = cfg; cur = yield* render(cfg, label);
      return true;
    };
    if (Number.isFinite(mu) && mu > 0) {
      let cfl = {width: baseSample.cfl.width, x: Int8Array.from(baseSample.cfl.x), b: Int8Array.from(baseSample.cfl.b)};
      for (const [round, deltas] of (huge ? [CFL_COARSE_HUGE] : [CFL_COARSE_SMALL, CFL_FINE]).entries()) for (const ch of ['x', 'b']) {
        check(signal);
        const costs = [tileCosts(cur, cfl, ch, width, height)];
        for (let k = 1; k < deltas.length; k++) {
          const cand = {...cfl, [ch]: shifted(cfl[ch], deltas[k])};
          costs.push(tileCosts(yield* render({...config, cfl: cand}, `cfl-${round}-${ch}-${k}`), cand, ch, width, height));
        }
        const next = Int8Array.from(cfl[ch]);
        let changed = 0;
        for (let ti = 0; ti < next.length; ti++) {
          let bestK = 0, bestJ = Infinity;
          for (let k = 0; k < deltas.length; k++) {
            const J = costs[k].tDist[ti] + mu * costs[k].tRate[ti];
            if (J < bestJ) { bestJ = J; bestK = k; }
          }
          if (bestK) { next[ti] = shifted(cfl[ch].subarray(ti, ti + 1), deltas[bestK])[0]; changed++; }
        }
        const cand = {...cfl, [ch]: next};
        if (changed && (yield* gate({...config, cfl: cand}, `cfl-${round}-${ch}-gate`))) cfl = cand;
      }
      yield span(0.4);

      if (!rec.field) {
        const maps = [];
        for (let i = 0; i < AQ_SCALES.length; i++) {
          check(signal);
          maps.push(yield* render({...config, fieldScale: new Float64Array(Math.ceil(width / 8) * Math.ceil(height / 8)).fill(AQ_SCALES[i])}, `aq-${i}`));
        }
        const field = viterbiField(maps, width, height, layout, mu);
        if (field) yield* gate({...config, fieldScale: field}, 'aq-gate');
      }
      yield span(0.6);

      const scales = huge ? DZ_SCALES_HUGE : DZ_SCALES, maps = [];
      for (let i = 0; i < scales.length; i++) {
        check(signal);
        maps.push(yield* render({...config, deadzoneMap: new Float64Array(Math.ceil(width / 8) * Math.ceil(height / 8)).fill(scales[i])}, `dz-${i}`));
      }
      const all = Array.from({length: scales.length}, (_, i) => i);
      const zoned = [deadzoneMapOf(maps, scales, all, width, height, layout, mu)];
      if (!huge) zoned.push(deadzoneMapOf(maps, scales, scales.length >= 9 ? [0, 2, 6] : [0, 2, 4], width, height, layout, mu));
      const start = config;
      for (const [i, map] of zoned.entries()) yield* gate({...start, deadzoneMap: map}, `dz-gate-${i}`);
    }
    yield span(0.8);

    const compactModes = huge ? [!!blocks.compactDct8] : [true, false];
    let qHint = q0;
    for (const compact of compactModes) {
      const buildAt = makeCoding(config, compact);
      const landings = [];
      const onQuality = yield* landFineSteps(buildAt, qHint, targetS2, libjxlFloor, evalProbe, huge ? 8 : 10, signal);
      if (onQuality?.pass) { qHint = onQuality.q; landings.push({landed: onQuality, buildAt, label: 'q'}); }
      if (compact !== gateCompact) yield* landAt(config, 'other', compact);
      for (const {landed, buildAt: at, label} of landings) {
        const file9 = yield* writeAtNine(yield* at(landed.q), `${tag}c${compact ? 1 : 0}${label}`);
        keepIfBetter(file9, landed.s2, landed.libS2);
        if (!bestPass2 || file9.length < bestPass2.bytes9.length) bestPass2 = {bytes9: file9, landed, buildAt: at};
      }
    }
    yield span(1);
  }

  if (bestPass2) {
    const file10 = yield* writeAtTen(yield* bestPass2.buildAt(bestPass2.landed.q), 'winner');
    keepIfBetter(file10, bestPass2.landed.s2, bestPass2.landed.libS2);
  }
  yield 1;

  return {bytes: bestBytes, score: bestScore};
}
