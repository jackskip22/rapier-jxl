// SPDX-License-Identifier: MIT
import {exactPow} from './exact-math.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';
import {xybStrategies, forcedLayout} from './varblocks.mjs';
import {lazyStrategyImage} from './varblock-core.mjs';

const VB_LARGE = /* @__PURE__ */ new Set([18, 19, 20]);
export const RATE_DOUBT = 3e-6, MAP_TOTAL_DOUBT = 2e-6, RATE_TOTAL_DOUBT = 1e-7;
export function sameDct8ImageValue(a, b) {
  return Object.is(a, b) || !!a && !!b && a.length === b.length && typeof a.every === 'function'
    && sameDct8ImageValues(a, b, 0, a.length);
}
export function sameDct8ImageValues(a, b, from, to) {
  for (let i = from; i < to; i++) {
    const v = a[i];
    if (Array.isArray(v) || ArrayBuffer.isView(v) ? !sameDct8ImageValue(v, b[i]) : !Object.is(v, b[i])) return false;
  }
  return true;
}
export function sameDct8QuantTable(quant, table) {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (table[x * 8 + y] !== quant[y * 8 + x]) return false;
  return true;
}
export function sameDct8Block(plain, strategy, block) {
  if (block.id !== 0) return false;
  for (let c = 0; c < 3; c++) {
    const source = plain.components[c].coeffs, at = block.by * plain.components[c].stride + block.bx;
    if (source[at * 64] !== strategy.components[c].dc[at]) return false;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x || y) && source[at * 64 + y * 8 + x] !== block.coeffs[c][x * 8 + y]) return false;
  }
  return true;
}

export function sameDct8Image(plain, strategy, part = false) {
  if (strategy?.lazyStrategy) {
    if (!plain || plain.strategyData || plain.width !== strategy.width || plain.height !== strategy.height) return false;
    const rows = plain.components[0].rows, stride = plain.components[0].stride;
    if (strategy.layout.length !== stride * rows || strategy.layout.some(entry => entry.id !== 0)) return false;
    for (let by = 0; by < rows; by += 64) if (!sameDct8Image(plain, strategy.lazyStrategy.rows(by, by + 64), true)) return false;
    return true;
  }
  if (!plain || plain.strategyData || !strategy.strategyData || plain.width !== strategy.width || plain.height !== strategy.height) return false;
  const same = sameDct8ImageValue;
  for (const key of ['quantScale', 'epf', 'quantFieldBase', 'epfIterations']) if (!Object.is(plain[key], strategy[key])) return false;
  for (const key of ['gab', 'quantFields', 'sharpness']) if (!same(plain[key], strategy[key])) return false;
  if (plain.cfl.width !== strategy.cfl.width || !same(plain.cfl.x, strategy.cfl.x) || !same(plain.cfl.b, strategy.cfl.b)) return false;
  const table = strategy.strategyData.tables[0]?.planes;
  if (!table || !part && strategy.strategyData.blocks.length !== plain.components[0].stride * plain.components[0].rows) return false;
  for (let c = 0; c < 3; c++) {
    const a = plain.components[c], b = strategy.components[c];
    if (a.stride !== b.stride || a.rows !== b.rows || !same(a.quant, b.quant)) return false;
    if (!sameDct8QuantTable(a.quant, table[c])) return false;
  }
  for (const block of strategy.strategyData.blocks) if (!sameDct8Block(plain, strategy, block)) return false;
  return true;
}

export function* closedLoopStrategySteps(base, width, height, options = {}) {
  const {p = 3, ids = [5, 10, 11, 4, 6, 7]} = options, maps = [], rates = new Map(), stride = base.components[0].stride, rows = base.components[0].rows;
  const costs = (yield {varblocks: {kind: 'costs', base, width, height, options: {...options, ids: ids.filter(id => !VB_LARGE.has(id))}}}) || null;
  let mapDoubt = 0;
  const lazy = !costs && !!base.planeRows, {p: _p, initial: _initial, ...build} = options;
  for (const id of [0, ...ids]) {
    let forced = {...options, force: id, maps: null, rates, ...(costs ? {costs} : {})};
    if (costs?.has(id)) {
      const certified = yield {varblocks: {kind: 'exact', layout: xybStrategies(base, width, height, {...forced, chooseOnly: true}).layout}};
      if (certified) forced = {...forced, exact: certified};
    }
    const image = lazy ? lazyStrategyImage(base, width, height, build, xybStrategies(base, width, height, {...forced, chooseOnly: true, priceOnly: true}).layout)
      : xybStrategies(base, width, height, forced).image;
    const initial = id === 0 && p === 3 && options.initial?.scores.cells && !options.initial.scores.doubt?.cells
      && sameDct8Image(options.initial.image, image) ? options.initial.scores : null;
    const reply = initial || (yield {measure: image, want: {p}});
    maps[id] = initial ? Float64Array.from(reply.cells) : reply.cells; mapDoubt = Math.max(mapDoubt, reply.doubt?.cells ?? 0);
  }
  if (lazy && !mapDoubt) {
    const {layout} = xybStrategies(base, width, height, {...options, maps, rates, chooseOnly: true});
    return {layout, image: lazyStrategyImage(base, width, height, build, layout)};
  }
  if (!costs && !mapDoubt) return xybStrategies(base, width, height, {...options, maps, rates});
  const choose = extra => xybStrategies(base, width, height, {...options, maps, rates, chooseOnly: true, ...(costs ? {costs,
    ...(!costs.certified && {rateDoubt: RATE_DOUBT, rateTotalDoubt: RATE_TOTAL_DOUBT})} : {}),
    mapDoubt, totalDoubt: mapDoubt && MAP_TOTAL_DOUBT, ...extra});
  let choice = choose({});
  if (choice.open.length) {
    const regions = choice.open.map(({bx, by, size}) => ({x0: bx * 8, y0: by * 8, x1: Math.min(width, (bx + size) * 8), y1: Math.min(height, (by + size) * 8)}));
    const exactCells = new Set();
    if (mapDoubt) {
      const {p: _p, initial: _initial, transforms: _transforms, ...build} = options;
      const exact = yield {exact: {kind: 'cells', regions, ids: [0, ...ids], p, base, options: build}};
      if (exact && [...exact.values()].every(e => e.whole)) {
        for (const [id, {cells}] of exact) maps[id] = Float64Array.from(cells);
        mapDoubt = 0;
        choice = choose({});
      } else if (exact) for (const [id, {cells}] of exact) for (const [k, v] of cells) { maps[id][k] = v; exactCells.add(k); }
    }
    if (!mapDoubt) for (const {bx, by, size} of choice.open) for (let y = by; y < Math.min(rows, by + size); y++) for (let x = bx; x < Math.min(stride, bx + size); x++) exactCells.add(y * stride + x);
    if (exactCells.size && choice.open.length) {
      choice = choose({exactCells});
      if (choice.open.length) {
        const whole = mapDoubt ? yield {exact: {kind: 'whole', image: xybStrategies(base, width, height, {...options, force: 0, maps: null}).image, p}} : {cells: maps[0]};
        if (whole) {
          maps[0] = Float64Array.from(whole.cells);
          const cpuRates = new Map();
          xybStrategies(base, width, height, {...options, force: 0, maps: null, rates: cpuRates});
          rates.set(0, cpuRates.get(0));
          for (let k = 0; k < stride * rows; k++) exactCells.add(k);
          choice = choose({exactCells, exactTotal: true});
        }
      }
    }
  }
  const {layout} = choice;
  if (!costs) return xybStrategies(base, width, height, {...options, layout});
  const certified = yield {varblocks: {kind: 'exact', layout}};
  yield {varblocks: {kind: 'release'}};
  return xybStrategies(base, width, height, {...options, layout, ...(certified ? {exact: certified} : {})});
}
