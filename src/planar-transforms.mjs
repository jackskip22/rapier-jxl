// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {part} from './bits.mjs';
import {leaf} from './modular.mjs';
import {codeChannel} from './modular-channel.mjs';
import {admitWeightedPredictor, customWeightedResiduals} from './weighted-custom.mjs';
import {DELTA_IMPLICIT} from './implicit-palette.mjs';

const PLANAR_PALETTE_PREDICTORS = new Map([['zero', 0], ['left', 1], ['top', 2], ['average', 3], ['select', 4], ['gradient', 5], ['weighted', 6]]);
const TRANSFORM_POWERS = [1]; for (let i = 1; i <= 32; i++) TRANSFORM_POWERS.push(TRANSFORM_POWERS[i - 1] * 2);
const transformInteger = (value, minimum, maximum, name) => {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw fault('JXL_INPUT', name + ' is an integer from ' + minimum + ' through ' + maximum + '.');
  return value;
};
const transformShape = channel => ({...channel, hshift: channel.hshift ?? channel.shift, vshift: channel.vshift ?? channel.shift});
const transformKey = (planes, at) => planes.map(plane => plane[at] | 0).join(',');

function transformTable(input, count, maximum, name) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > maximum) throw fault('JXL_INPUT', name + ' is an array of at most ' + maximum + ' word vectors.');
  return Array.from(input, vector => {
    if (!vector || typeof vector !== 'object' || vector.length !== count) throw fault('JXL_INPUT', name + ' vectors have channelCount words.');
    return Int32Array.from({length: count}, (_, c) => transformInteger(vector[c], -2147483648, 4294967295, name + ' word') | 0);
  });
}

export function admitPlanarTransforms(value, colorCount, memoryLimit = 268435456) {
  transformInteger(memoryLimit, 1, 2147483648, 'maxTransformBytes');
  if (value === undefined || value === false) return null;
  if (!Array.isArray(value) || value.length > 273) throw fault('JXL_INPUT', 'transforms is false or an ordered array of at most 273 recipes.');
  if (!value.length) return null;
  let authoredBytes = 0;
  const recipes = Array.from(value, input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('JXL_INPUT', 'Each planar transform is an object.');
    const fields = new Map(Object.entries(input)), type = fields.get('type');
    const allowed = type === 'rct' ? ['type', 'beginChannel', 'rctType'] : type === 'palette'
      ? ['type', 'beginChannel', 'channelCount', 'mode', 'predictor', 'colors', 'deltas', 'maxColors', 'maxDeltaEntries'] : [];
    if (!allowed.length) throw fault('JXL_INPUT', 'A planar transform type is rct or palette.');
    for (const key of fields.keys()) if (!allowed.includes(key)) throw fault('JXL_INPUT', 'Unknown ' + type + ' field: ' + key + '.');
    const beginC = transformInteger(fields.get('beginChannel') ?? 0, 0, 9287, 'Transform beginChannel');
    if (type === 'rct') return {type, beginC, rctType: transformInteger(fields.get('rctType') ?? 6, 0, 41, 'rctType'), numC: 3};
    const numC = transformInteger(fields.get('channelCount') ?? colorCount, 1, 8192, 'Palette channelCount');
    const mode = fields.get('mode') ?? 'colors', name = fields.get('predictor') ?? (mode === 'colors' ? 'zero' : 'left');
    if (!['colors', 'implicit', 'explicit', 'hybrid'].includes(mode)) throw fault('JXL_INPUT', 'Palette mode is colors, implicit, explicit or hybrid.');
    if (!PLANAR_PALETTE_PREDICTORS.has(name)) throw fault('JXL_INPUT', 'Palette predictor is zero, left, top, average, select, gradient or weighted.');
    const predictor = PLANAR_PALETTE_PREDICTORS.get(name);
    if (numC === 1 && predictor === 0 && (mode === 'implicit' || mode === 'hybrid'))
      throw fault('JXL_INPUT', 'A one-channel implicit palette needs a nonzero predictor for independent-decoder compatibility.');
    for (const key of ['colors', 'deltas']) if (Array.isArray(fields.get(key))) authoredBytes += fields.get(key).length * numC * 4;
    if (authoredBytes > memoryLimit) throw fault('JXL_MEMORY', 'Authored palette words exceed maxTransformBytes.');
    const colors = transformTable(fields.get('colors'), numC, 70911, 'colors'), deltas = transformTable(fields.get('deltas'), numC, 66816, 'deltas');
    if (deltas !== undefined && mode !== 'explicit' && mode !== 'hybrid') throw fault('JXL_INPUT', 'Authored deltas require explicit or hybrid palette mode.');
    const maxColors = transformInteger(fields.get('maxColors') ?? (colors ? colors.length : 4096), 0, 70911, 'maxColors');
    const maxDeltaEntries = transformInteger(fields.get('maxDeltaEntries') ?? (deltas ? deltas.length : 256), 0, 66816, 'maxDeltaEntries');
    if (colors && colors.length > maxColors || deltas && deltas.length > maxDeltaEntries)
      throw fault('JXL_INPUT', 'An authored palette exceeds its declared entry limit.');
    return {type, beginC, numC, mode, predictor, colors, deltas, maxColors, maxDeltaEntries};
  });
  return {recipes, memoryLimit, authoredBytes};
}

function transformRange(channels, metaCount, recipe) {
  const {beginC, numC} = recipe, end = beginC + numC;
  if (end > channels.length) throw fault('JXL_INPUT', 'A transform selects an absent channel.');
  if (beginC < metaCount && end > metaCount) throw fault('JXL_INPUT', 'A transform cannot mix meta and image channels.');
  const selected = channels.slice(beginC, end), first = selected[0];
  for (const channel of selected) if (channel.width !== first.width || channel.height !== first.height ||
    channel.hshift !== first.hshift || channel.vshift !== first.vshift)
    throw fault('JXL_INPUT', 'Transformed channels share dimensions and sampling shifts.');
  return selected;
}

function* rctPlanes(selected, type) {
  const count = selected[0].data.length, permutation = Math.floor(type / 7), custom = type % 7;
  const order = [permutation % 3, (permutation + 1 + Math.floor(permutation / 3)) % 3, (permutation + 2 - Math.floor(permutation / 3)) % 3];
  const result = selected.map(channel => ({...channel, data: new Int32Array(count)}));
  let wide = false;
  const word = value => { if (value < -32768 || value > 32767) wide = true; return value | 0; };
  for (let i = 0; i < count; i++) {
    const a = selected[order[0]].data[i] | 0, b = selected[order[1]].data[i] | 0, c = selected[order[2]].data[i] | 0;
    if (custom === 6) {
      const co = word(a - c), middle = word(c + (co >> 1)), cg = word(b - middle);
      result[0].data[i] = word(middle + (cg >> 1)); result[1].data[i] = co; result[2].data[i] = cg;
    } else {
      const second = custom >> 1;
      result[0].data[i] = word(a);
      result[1].data[i] = word(b - (second === 1 ? a : second === 2 ? word(a + c) >> 1 : 0));
      result[2].data[i] = word(c - (custom & 1 ? a : 0));
    }
    if ((i + 1) % 4096 === 0 || i + 1 === count) yield (i + 1) / count;
  }
  return {channels: result, wide};
}

function implicitPlanarPalette(count, bitDepth) {
  const differences = new Map(), colors = new Map(), depth = Math.min(bitDepth, 24), scale = TRANSFORM_POWERS[Math.max(0, depth - 8)];
  for (let n = 0; n < 143; n++) {
    const vector = DELTA_IMPLICIT[(n + 1) >> 1], sign = n & 1 ? 1 : -1;
    const key = Array.from({length: count}, (_, c) => c < 3 ? sign * vector[c] * scale : 0).join(',');
    if (!differences.has(key)) differences.set(key, -1 - n);
  }
  if (bitDepth <= 24) for (let n = 0; n < 189; n++) {
    if (count > 3 && n < 64) continue;
    const maximum = TRANSFORM_POWERS[depth] - 1, offset = TRANSFORM_POWERS[Math.max(0, depth - 3)];
    const key = Array.from({length: count}, (_, c) => c >= 3 ? 0 : n < 64
      ? Math.floor(Math.floor(n / [1, 4, 16][c]) % 4 * maximum / 4) + offset
      : Math.floor(Math.floor((n - 64) / [1, 5, 25][c]) % 5 * maximum / 4)).join(',');
    if (!colors.has(key)) colors.set(key, n);
  }
  return {differences, colors};
}

function* residualPlanes(planes, width, height, predictor, weighted) {
  const residuals = [];
  for (let c = 0; c < planes.length; c++) {
    const output = new Int32Array(width * height); residuals.push(output);
    if (predictor === 6) yield* part(customWeightedResiduals(planes[c], width, height, weighted, output), c, planes.length);
    else for (let start = 0, rowBatch = Math.max(1, Math.floor(16384 / Math.max(1, width))); start < height; start += rowBatch) {
      const end = Math.min(height, start + rowBatch);
      codeChannel(null, null, planes[c], width, end, leaf(predictor), false, undefined, output, start);
      yield (c + end / height) / planes.length;
    }
  }
  return residuals;
}

function* palettePlanes(selected, recipe, bitDepth, weighted, available) {
  const {width, height} = selected[0], count = width * height, components = selected.length;
  const delta = recipe.mode !== 'colors', explicit = recipe.mode === 'explicit' || recipe.mode === 'hybrid';
  let scratch = count * (components * (delta ? 8 : 4) + 5);
  const charge = bytes => { scratch += bytes; if (scratch > available) throw fault('JXL_MEMORY', 'Palette preparation exceeds maxTransformBytes.'); };
  charge(0);
  const implicit = recipe.mode === 'implicit' || recipe.mode === 'hybrid' ? implicitPlanarPalette(components, bitDepth) : null;
  if (implicit) for (const map of [implicit.differences, implicit.colors]) for (const key of map.keys()) charge(96 + key.length * 2);
  const authoredEntry = values => { const key = [...values].join(','); charge(96 + key.length * 2); return {key, values}; };
  const planes = selected.map(channel => channel.data instanceof Uint32Array ? Int32Array.from(channel.data) : channel.data);
  const residuals = delta ? yield* part(residualPlanes(planes, width, height, recipe.predictor, weighted), 0, 4) : null;
  const candidates = new Map();
  if (explicit && recipe.deltas === undefined && recipe.maxDeltaEntries) for (let at = 0; at < count; at++) {
    const key = transformKey(residuals, at), existing = candidates.get(key);
    if (existing) existing.uses++;
    else if (candidates.size < Math.max(65536, recipe.maxDeltaEntries)) {
      charge(96 + key.length * 2); candidates.set(key, {key, at, uses: 1});
    }
    if ((at + 1) % 4096 === 0 || at + 1 === count) yield (1 + (at + 1) / count) / 4;
  }
  const entries = explicit ? recipe.deltas?.map(authoredEntry) ??
    [...candidates.values()].sort((a, b) => b.uses - a.uses || a.at - b.at).slice(0, recipe.maxDeltaEntries) : [];
  const differences = new Map(); entries.forEach((entry, i) => { if (!differences.has(entry.key)) differences.set(entry.key, i); });
  const absolute = recipe.colors?.map(authoredEntry) ?? [], colors = new Map();
  absolute.forEach((entry, i) => { if (!colors.has(entry.key)) colors.set(entry.key, i); });
  const indices = new Int32Array(count), kinds = new Uint8Array(count);
  for (let at = 0; at < count; at++) {
    const difference = delta ? transformKey(residuals, at) : '';
    if (differences.has(difference)) indices[at] = differences.get(difference);
    else if (implicit?.differences.has(difference)) indices[at] = implicit.differences.get(difference);
    else {
      const key = transformKey(planes, at);
      if (implicit?.colors.has(key)) { indices[at] = implicit.colors.get(key); kinds[at] = 2; }
      else {
        let index = colors.get(key);
        if (index === undefined) {
          if (recipe.colors || absolute.length >= recipe.maxColors) throw fault('JXL_INPUT', 'The palette needs another absolute color; supply it or increase maxColors.');
          charge(96 + key.length * 2); index = absolute.length; colors.set(key, index); absolute.push({key, at});
        }
        indices[at] = entries.length + index; kinds[at] = 1;
      }
    }
    if ((at + 1) % 4096 === 0 || at + 1 === count) yield (2 + (at + 1) / count) / 4;
  }
  const paletteWidth = entries.length + absolute.length;
  charge(paletteWidth * components * 4);
  const table = new Int32Array(paletteWidth * components);
  let wide = false;
  for (let c = 0; c < components; c++) {
    for (let i = 0; i < entries.length; i++) table[c * paletteWidth + i] = entries[i].values?.[c] ?? residuals[c][entries[i].at];
    for (let i = 0; i < absolute.length; i++) table[c * paletteWidth + entries.length + i] = absolute[i].values?.[c] ?? planes[c][absolute[i].at];
    yield (3 + (c + 1) / components / 2) / 4;
  }
  for (let at = 0; at < count; at++) {
    if (kinds[at] === 2) indices[at] += paletteWidth;
    if (indices[at] < -32768 || indices[at] > 32767) wide = true;
    if ((at + 1) % 4096 === 0 || at + 1 === count) yield (3.5 + (at + 1) / count / 2) / 4;
  }
  for (const value of table) if (value < -32768 || value > 32767) wide = true;
  return {wide, index: {...selected[0], data: indices},
    table: {data: table, width: paletteWidth, height: components, hshift: -1, vshift: -1},
    transform: {type: 'palette', beginC: recipe.beginC, numC: components, nbColors: absolute.length, nbDeltas: entries.length, predictor: recipe.predictor}};
}

export function* applyPlanarTransforms(channels, plan, bitDepth, weighted) {
  const result = channels.map(transformShape), transforms = [];
  let metaCount = 0, wide = false, maximumChannels = result.length;
  weighted ??= admitWeightedPredictor();
  for (let index = 0; index < plan.recipes.length; index++) {
    const recipe = plan.recipes[index], selected = transformRange(result, metaCount, recipe);
    const retained = result.reduce((sum, channel) => sum + channel.data.length * 4, 0), available = plan.memoryLimit - retained - plan.authoredBytes;
    if (recipe.type === 'rct') {
      if (selected[0].data.length * 12 > available) throw fault('JXL_MEMORY', 'RCT preparation exceeds maxTransformBytes.');
      const transformed = yield* part(rctPlanes(selected, recipe.rctType), index, plan.recipes.length);
      result.splice(recipe.beginC, 3, ...transformed.channels); wide ||= transformed.wide;
      transforms.push({type: 'rct', beginC: recipe.beginC, rctType: recipe.rctType});
    } else {
      const transformed = yield* part(palettePlanes(selected, recipe, bitDepth, weighted, available), index, plan.recipes.length);
      result.splice(recipe.beginC, recipe.numC, transformed.index); result.unshift(transformed.table);
      metaCount += recipe.beginC < metaCount ? 2 - recipe.numC : 1;
      transforms.push(transformed.transform); wide ||= transformed.wide;
    }
    maximumChannels = Math.max(maximumChannels, result.length);
  }
  return {channels: result, transforms, metaCount, maximumChannels, wide};
}
