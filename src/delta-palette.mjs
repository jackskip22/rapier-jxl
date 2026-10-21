// SPDX-License-Identifier: MIT
import {BitWriter, complete, part, packSigned, ceilLog2} from './bits.mjs';
import {admitOptions, admitPixels, admitSampleFormat, admitOutputSize, fault, job} from './admit.mjs';
import {inspectPixels, losslessSteps} from './lossless.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, assembleCodestream} from './frame.mjs';
import {ALPHABET, leaf, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {screenResiduals, screenModel, writeScreenModel} from './screen-lz77.mjs';
import {screenSteps} from './screen-search.mjs';
import {codeWeighted} from './weighted.mjs';

const DELTA_IMPLICIT = [
  [0,0,0],[4,4,4],[11,0,0],[0,0,-13],[0,-12,0],[-10,-10,-10],[-18,-18,-18],[-27,-27,-27],
  [-18,-18,0],[0,0,-32],[-32,0,0],[-37,-37,-37],[0,-32,-32],[24,24,45],[50,50,50],[-45,-24,-24],
  [-24,-45,-45],[0,-24,-24],[-34,-34,0],[-24,0,-24],[-45,-45,-24],[64,64,64],[-32,0,-32],[0,-32,0],
  [-32,0,32],[-24,-45,-24],[45,24,45],[24,-24,-45],[-45,-24,24],[80,80,80],[64,0,0],[0,0,-64],
  [0,-64,-64],[-24,-24,45],[96,96,96],[64,64,0],[45,-24,-24],[34,-34,0],[112,112,112],[24,-45,-45],
  [45,45,-24],[0,-32,32],[24,-24,45],[0,96,96],[45,-24,24],[24,-45,-24],[-24,-45,24],[0,-64,0],
  [96,0,0],[128,128,128],[64,0,64],[144,144,144],[96,96,0],[-36,-36,36],[45,-24,-45],[45,-45,-24],
  [0,0,-96],[0,128,128],[0,96,0],[45,24,-45],[-128,0,0],[24,-45,24],[-45,24,-45],[64,0,-64],
  [64,-64,-64],[96,0,96],[45,-45,24],[24,45,-45],[64,64,-64],[128,128,0],[0,0,-128],[-24,45,-45]
];
const DELTA_PREDICTORS = new Map([['left', 1], ['top', 2], ['average', 3], ['gradient', 5], ['weighted', 6]]);
const deltaSigned = value => value & 1 ? -(value + 1) / 2 : value / 2;

function deltaKey(values, at) {
  let key = 0;
  for (let c = values.length - 1; c >= 0; c--) {
    const value = values[c][at];
    if (value >= 1024) return values.map(plane => plane[at]).join(',');
    key = key * 1024 + value;
  }
  return key;
}
function deltaColorKey(planes, at) {
  let key = 0;
  for (let c = planes.length - 1; c >= 0; c--) key = key * 256 + planes[c][at];
  return key;
}
function deltaImplicitMaps(channels) {
  const differences = new Map(), colors = new Map();
  for (let n = 0; n < 143; n++) {
    const vector = DELTA_IMPLICIT[(n + 1) >> 1], sign = n & 1 ? 1 : -1;
    const values = Array.from({length: channels}, (_, c) => [packSigned(c < 3 ? sign * vector[c] : 0)]);
    const key = deltaKey(values, 0);
    if (!differences.has(key)) differences.set(key, -1 - n);
  }
  for (let n = 0; n < 189; n++) {
    if (channels > 3 && n < 64) continue;
    let key = 0;
    for (let c = channels - 1; c >= 0; c--) {
      const value = c >= 3 ? 0 : n < 64 ? ((Math.floor(n / [1, 4, 16][c]) % 4 * 255) >> 2) + 32
        : (Math.floor((n - 64) / [1, 5, 25][c]) % 5 * 255) >> 2;
      key = key * 256 + value;
    }
    if (!colors.has(key)) colors.set(key, n);
  }
  return {differences, colors};
}

function deltaPlaneResiduals(planes, width, height, predictor) {
  return planes.map(plane => {
    if (predictor !== 6) return screenResiduals(plane, width, height, predictor);
    const residuals = new Uint32Array(width * height);
    codeWeighted(null, null, plane, width, height, 0, undefined, residuals);
    return residuals;
  });
}

function deltaPlan(planes, residuals, width, height, predictor, budget, maxColors, implicit) {
  const pixels = width * height, counts = new Map();
  if (budget) for (let i = 0; i < pixels; i++) {
    const key = deltaKey(residuals, i), entry = counts.get(key);
    if (entry) entry.uses++;
    else {
      if (counts.size === 65536) continue;
      counts.set(key, {key, at: i, uses: 1});
    }
  }
  const entries = [...counts.values()].sort((a, b) => b.uses - a.uses || a.at - b.at).slice(0, budget);
  const deltas = new Map(entries.map((entry, i) => [entry.key, i]));
  const colors = new Map(), indices = new Int32Array(pixels), kinds = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const difference = deltaKey(residuals, i);
    if (deltas.has(difference)) { indices[i] = deltas.get(difference); continue; }
    if (implicit?.differences.has(difference)) { indices[i] = implicit.differences.get(difference); continue; }
    const color = deltaColorKey(planes, i);
    if (implicit?.colors.has(color)) { indices[i] = implicit.colors.get(color); kinds[i] = 2; continue; }
    let entry = colors.get(color);
    if (!entry) {
      if (colors.size === maxColors) return null;
      entry = {key: color, at: i, uses: 0}; colors.set(color, entry);
    }
    entry.uses++; kinds[i] = 1;
  }
  const absolute = [...colors.values()].sort((a, b) => b.uses - a.uses || a.key - b.key);
  const paletteWidth = entries.length + absolute.length;
  absolute.forEach((entry, i) => { entry.index = entries.length + i; });
  const table = new Int32Array(paletteWidth * planes.length);
  for (let c = 0; c < planes.length; c++) {
    for (let i = 0; i < entries.length; i++) table[c * paletteWidth + i] = deltaSigned(residuals[c][entries[i].at]);
    for (let i = 0; i < absolute.length; i++) table[c * paletteWidth + entries.length + i] = planes[c][absolute[i].at];
  }
  for (let i = 0; i < pixels; i++) {
    if (kinds[i] === 1) indices[i] = colors.get(deltaColorKey(planes, i)).index;
    else if (kinds[i] === 2) indices[i] += paletteWidth;
  }
  return {indices, table, paletteWidth, transforms: [{type: 'palette', beginC: 0, numC: planes.length,
    nbColors: absolute.length, nbDeltas: entries.length, predictor}]};
}

function deltaSection(plan, width, height, channels, single) {
  const writer = new BitWriter(256);
  if (single) { writer.write(1, 1); writer.write(1, 1); }
  else writeModularHeader(writer, {useGlobalTree: false, transforms: plan.transforms});
  const models = [screenModel(plan.table, plan.paletteWidth, channels, 16, 4), screenModel(plan.indices, width, height, 16, 4)];
  const write = writeScreenModel(writer, models);
  if (single) writeModularHeader(writer, {transforms: plan.transforms});
  write();
  return writer.finish();
}

function* deltaFrameSteps(rgba, width, height, shape, options) {
  const {colorSpace, groupSize: dim, maxPaletteColors, maxDeltaEntries, paletteMode, deltaPredictor} = options;
  const layout = groupLayout(width, height, dim), groups = layout.groupsX * layout.groupsY;
  const header = new BitWriter(128), sections = [];
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha, shift: ceilLog2(dim) - 7});
  let sectionBytes = 0, hurried = false;
  const append = bytes => { sectionBytes += bytes.length; admitOutputSize(sectionBytes); sections.push(bytes); };
  if (!layout.single) {
    const global = new BitWriter(128);
    global.write(1, 1); global.write(1, 1);
    writeChannelHistograms(global, writeTree(global, leaf(0)), [new Uint32Array(ALPHABET)]);
    writeModularHeader(global); append(global.finish());
    for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  }
  const predictors = deltaPredictor === 'auto' ? [5, 1, 2, 6, 3] : [DELTA_PREDICTORS.get(deltaPredictor)];
  const implicit = deltaImplicitMaps(shape.channels);
  for (let g = 0; g < groups; g++) {
    const [x0, y0, w, h] = groupRect(layout, width, height, g, dim);
    const planes = Array.from({length: shape.channels}, () => new Int16Array(w * h));
    for (let c = 0; c < shape.channels; c++) {
      const sourceChannel = shape.colour === 1 && c === 1 ? 3 : c;
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++)
        planes[c][i] = rgba[((y0 + y) * width + x0 + x) * 4 + sourceChannel];
    }
    let best;
    for (let p = 0; p < predictors.length; p++) {
      const predictor = predictors[p], residuals = deltaPlaneResiduals(planes, w, h, predictor);
      const choices = paletteMode === 'implicit' || paletteMode === 'auto' ? [[0, true]] : paletteMode === 'explicit' ? [[maxDeltaEntries, false]]
        : [[0, true], [Math.min(16, maxDeltaEntries), true], [maxDeltaEntries, true], [maxDeltaEntries, false]];
      for (const [budget, useImplicit] of choices) {
        const plan = deltaPlan(planes, residuals, w, h, predictor, budget, maxPaletteColors, useImplicit ? implicit : null);
        if (!plan) continue;
        const bytes = deltaSection(plan, w, h, shape.channels, layout.single);
        if (!best || bytes.length < best.length) best = bytes;
        if (hurried) break;
      }
      hurried ||= !!(yield (g + (p + 1) / predictors.length) / groups);
      if (hurried && best) break;
    }
    if (!best) {
      if (paletteMode === 'auto') return null;
      throw fault('JXL_SIZE', 'This group needs more palette entries; increase maxPaletteColors or maxDeltaEntries, or use paletteMode auto.');
    }
    append(best);
  }
  return assembleCodestream(header, sections);
}

function deltaOptions(rgba, width, height, options = {}) {
  const {quality, colorSpace} = admitOptions(options);
  admitPixels(rgba, width, height);
  if (quality !== 100 || !admitSampleFormat(rgba, options).native8)
    throw fault('JXL_INPUT', 'Delta palettes encode exact straight RGBA8 with sRGB transfer and sRGB or Display P3 primaries.');
  const paletteMode = options.paletteMode ?? 'auto', deltaPredictor = options.deltaPredictor ?? 'auto';
  const maxDeltaEntries = options.maxDeltaEntries ?? 256, maxPaletteColors = options.maxPaletteColors ?? 4096;
  const groupSize = options.groupSize ?? 1024, screenEffort = options.screenEffort ?? 5;
  if (!['auto', 'explicit', 'implicit', 'hybrid'].includes(paletteMode)) throw fault('JXL_INPUT', 'paletteMode is auto, explicit, implicit or hybrid.');
  if (deltaPredictor !== 'auto' && !DELTA_PREDICTORS.has(deltaPredictor)) throw fault('JXL_INPUT', 'deltaPredictor is auto, left, top, average, gradient or weighted.');
  if (!Number.isInteger(maxDeltaEntries) || maxDeltaEntries < 1 || maxDeltaEntries > 4096)
    throw fault('JXL_INPUT', 'maxDeltaEntries is an integer from 1 to 4096.');
  if (!Number.isInteger(maxPaletteColors) || maxPaletteColors < 1 || maxPaletteColors > 65536)
    throw fault('JXL_INPUT', 'maxPaletteColors is an integer from 1 to 65536.');
  if (![128, 256, 512, 1024].includes(groupSize)) throw fault('JXL_INPUT', 'groupSize is 128, 256, 512 or 1024.');
  if (!Number.isInteger(screenEffort) || screenEffort < 1 || screenEffort > 9) throw fault('JXL_INPUT', 'screenEffort is an integer from 1 to 9.');
  return {colorSpace, paletteMode, deltaPredictor, maxDeltaEntries, maxPaletteColors, groupSize, screenEffort};
}

function* deltaEncodeSteps(rgba, width, height, options) {
  const shape = inspectPixels(rgba, width, height);
  if (options.paletteMode !== 'auto') return yield* deltaFrameSteps(rgba, width, height, shape, options);
  let best, oversized;
  try { best = yield* part(losslessSteps(rgba, width, height, {shape, colorSpace: options.colorSpace}), 0, 3); }
  catch (error) { if (error.code !== 'JXL_SIZE') throw error; oversized = error; }
  if ((yield 1 / 3) && best) return best;
  if (options.screenEffort >= 3) {
    try {
      const screen = yield* part(screenSteps(rgba, width, height, shape, options.colorSpace, {effort: options.screenEffort}), 1, 3);
      if (screen && (!best || screen.length < best.length)) best = screen;
    } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  }
  if ((yield 2 / 3) && best) return best;
  try {
    const delta = yield* part(deltaFrameSteps(rgba, width, height, shape, options), 2, 3);
    if (delta && (!best || delta.length < best.length)) best = delta;
  } catch (error) { if (error.code !== 'JXL_SIZE' && (!(error instanceof RangeError) || error.code)) throw error; }
  if (!best) throw oversized;
  return best;
}

export function encodeDeltaPalette(data, width, height, options) {
  return complete(encodeDeltaPaletteSteps(data, width, height, options));
}
export function encodeDeltaPaletteSteps(data, width, height, options) {
  return job(deltaEncodeSteps(data, width, height, deltaOptions(data, width, height, options)));
}
