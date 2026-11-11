// SPDX-License-Identifier: MIT
import {packLevels} from './photo-levels.mjs';
const TYPES = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array'];
const DROPPED = new Set(['coeffs', 'levels']);
const SUMMARY = 'rapier-jxl.band-summary.1';
const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
const isView = v => ArrayBuffer.isView(v) && Object.getPrototypeOf(Object.getPrototypeOf(v)) === typedProto && TYPES.includes(v.constructor.name);
const isValues = v => Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every(x => isView(x) && x.length === 1);

function columns(list) {
  const first = list[0];
  if (!first || Object.getPrototypeOf(first) !== Object.prototype) return null;
  const keys = Object.keys(first).filter(k => !DROPPED.has(k));
  const kinds = keys.map(k => typeof first[k] === 'number' ? 'n' : isView(first[k]) ? 'v'
    : isValues(first[k]) ? 'd' + first[k].length + ':' + TYPES.indexOf(first[k][0].constructor.name) : null);
  if (kinds.includes(null)) return null;
  const numbers = [], views = [], viewIds = new Map(), shared = [];
  for (const block of list) {
    if (Object.getPrototypeOf(block) !== Object.prototype) return null;
    const own = Object.keys(block).filter(k => !DROPPED.has(k));
    if (own.length !== keys.length || own.some((k, i) => k !== keys[i])) return null;
    for (let i = 0; i < keys.length; i++) {
      const v = block[keys[i]], kind = kinds[i];
      if (kind === 'n') { if (typeof v !== 'number') return null; numbers.push(v); }
      else if (kind === 'v') {
        if (!isView(v)) return null;
        let id = viewIds.get(v);
        if (id === undefined) { id = shared.length; viewIds.set(v, id); shared.push(v); }
        views.push(id);
      } else {
        const [n, type] = kind.slice(1).split(':').map(Number);
        if (!isValues(v) || v.length !== n || v.some(x => TYPES.indexOf(x.constructor.name) !== type)) return null;
        for (const x of v) numbers.push(x[0]);
      }
    }
  }
  return {count: list.length, keys, kinds, numbers: Float64Array.from(numbers), views: Int32Array.from(views), shared};
}

function blocksOf({count, keys, kinds, numbers, views, shared}, each = null) {
  const parsed = kinds.map(kind => kind[0] === 'd' ? kind.slice(1).split(':').map(Number) : null);
  const list = new Array(count);
  let n = 0, v = 0;
  for (let b = 0; b < count; b++) {
    const block = {};
    for (let i = 0; i < keys.length; i++) {
      const kind = kinds[i];
      if (kind === 'n') block[keys[i]] = numbers[n++];
      else if (kind === 'v') block[keys[i]] = shared[views[v++]];
      else {
        const [length, type] = parsed[i], Type = globalThis[TYPES[type]], values = new Array(length);
        for (let k = 0; k < length; k++) values[k] = Type.of(numbers[n++]);
        block[keys[i]] = values;
      }
    }
    list[b] = each ? each(block, b) : block;
  }
  return list;
}

function plainComponent(component) {
  const {coeffs} = component;
  if (component.packed) return component;
  if (!(coeffs instanceof Int16Array)) return null;
  const blocks = coeffs.length / 64, dc = new Int16Array(blocks), natural = new Uint32Array(64);
  for (let b = 0, at = 0; b < blocks; b++, at += 64) {
    dc[b] = coeffs[at];
    for (let k = 1; k < 64; k++) if (coeffs[at + k]) natural[k]++;
  }
  const kept = {components: [{...component}]};
  packLevels(kept);
  return {...kept.components[0], packed: {...kept.components[0].packed, dc, natural}};
}

function summarizeBand(band, extra = null) {
  const data = band?.strategyData;
  if (!data && Array.isArray(band?.components)) {
    const components = band.components.map(plainComponent);
    return components.includes(null) ? band : {[SUMMARY]: 'plain', band: {...band, components}, extra};
  }
  if (!data || !Array.isArray(data.blocks) || !Array.isArray(data.groups)) return band;
  const index = new Map(data.blocks.map((block, i) => [block, i]));
  if (index.size !== data.blocks.length) return band;
  const lengths = [], members = [];
  for (let g = 0; g < data.groups.length; g++) {
    if (!(g in data.groups)) { lengths.push(-1); continue; }
    const group = data.groups[g];
    if (!Array.isArray(group)) return band;
    lengths.push(group.length);
    for (let i = 0; i < group.length; i++) { const at = index.get(group[i]); if (!(i in group) || at === undefined) return band; members.push(at); }
  }
  const blocks = columns(data.blocks);
  if (!blocks) return band;
  return {[SUMMARY]: true, band: {...band, strategyData: {...data, blocks: null, groups: null}}, keys: Object.keys(data),
    blocks, groupCount: data.groups.length, lengths: Int32Array.from(lengths), members: Int32Array.from(members), extra};
}

function bandOfSummary(saved) {
  if (!saved?.[SUMMARY]) return saved;
  if (saved[SUMMARY] === 'plain') return Object.defineProperties({...saved.band}, {answered: {value: true}, extra: {value: saved.extra}});
  let blocks = null, groups = null;
  const blocksOfBand = () => blocks ??= blocksOf(saved.blocks);
  const groupsOf = () => {
    if (groups) return groups;
    blocksOfBand();
    groups = new Array(saved.groupCount);
    for (let g = 0, at = 0; g < saved.groupCount; g++) {
      const length = saved.lengths[g];
      if (length < 0) continue;
      groups[g] = Array.from({length}, (_, i) => blocks[saved.members[at + i]]);
      at += length;
    }
    return groups;
  };
  const data = saved.band.strategyData, strategyData = {};
  for (const key of saved.keys)
    if (key === 'groups') Object.defineProperty(strategyData, key, {get: groupsOf, set: v => { groups = v; }, enumerable: true, configurable: true});
    else if (key === 'blocks') Object.defineProperty(strategyData, key, {get: blocksOfBand, set: v => { blocks = v; }, enumerable: true, configurable: true});
    else strategyData[key] = data[key];
  const frameBlocks = (rows, coeffs) => blocksOf(saved.blocks, (block, i) => {
    block.by += rows;
    return Object.defineProperty(block, 'coeffs', {get: () => coeffs(i), enumerable: true, configurable: true});
  });
  return Object.defineProperties({...saved.band, strategyData}, {summary: {value: true}, extra: {value: saved.extra}, frameBlocks: {value: frameBlocks}});
}

export const bandSummaryTool = Object.freeze({save: summarizeBand, answer: bandOfSummary});
