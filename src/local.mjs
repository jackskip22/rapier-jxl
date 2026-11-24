// SPDX-License-Identifier: MIT
import {BitWriter} from './bits.mjs';
import {writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {writeImageHeader} from './icc-write.mjs';
import {buildCode, writePrefixCode} from './prefix.mjs';
import {writeModularAnsHistograms} from './ans.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf, intervals, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeWeighted} from './weighted.mjs';
import {admitOutputSize} from './admit.mjs';
import {planeFill} from './lossless.mjs';
import {learnTree} from './capture-trees.mjs';
import {captureLocalResiduals, captureLocalProperties, captureLocalTokens, captureLocalWrite} from './capture-kernels.mjs';

const localRaw = s => Math.max(0, s < 224 ? s - 1 : s - 236);
const price = freqs => {
  const code = buildCode(freqs), writer = new BitWriter(128);
  writePrefixCode(writer, code);
  let bits = writer.bitLength;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + localRaw(s));
  return bits;
};

function residuals(plane, width, height, predictor, properties) {
  if (predictor !== 6) return captureLocalResiduals(plane, width, height, predictor);
  const out = new Uint32Array(width * height);
  codeWeighted(null, null, plane, width, height, 0, undefined, out, properties);
  return out;
}

const LEARNED = 'learned';
function tokens(values, properties, cuts) {
  const freqs = captureLocalTokens(values, properties, cuts, RESIDUAL_CONFIG, LZ77, ALPHABET, cuts ? cuts.length + 1 : 1);
  return {freqs, values, properties, cuts};
}

function intervalPlan(values, properties, predictor, property, cuts) {
  const coded = tokens(values, properties, cuts), count = coded.freqs.length, filled = coded.freqs.map(freq => freq.some(n => n));
  const costs = new Float64Array(count + 1).fill(Infinity), from = new Uint8Array(count + 1);
  costs[0] = 0;
  for (let end = 1; end <= count; end++) {
    const freq = new Uint32Array(ALPHABET);
    let own = 0;
    for (let start = end - 1; start >= 0; start--) {
      if (filled[start]) { for (let s = 0; s < ALPHABET; s++) freq[s] += coded.freqs[start][s]; own = price(freq); }
      const bits = costs[start] + own + 24;
      if (bits < costs[end]) { costs[end] = bits; from[end] = start; }
    }
  }
  const spans = [];
  for (let end = count; end; end = from[end]) spans.unshift([from[end], end]);
  const leaves = spans.map(() => leaf(predictor)), mapping = new Uint8Array(count);
  const freqs = spans.map(([start, end], index) => {
    const freq = new Uint32Array(ALPHABET);
    for (let k = start; k < end; k++) { mapping[k] = index; for (let s = 0; s < ALPHABET; s++) freq[s] += coded.freqs[k][s]; }
    return freq;
  });
  return {leaves, tree: intervals(property, spans.slice(0, -1).map(s => cuts[s[1] - 1]), i => leaves[i]), freqs, values, properties, cuts, mapping};
}

const WEIGHTED_LOCAL_CUTS = [-127, -31, -7, -1, 0, 1, 7, 31, 127];
const GRADIENT_CUTS = [-191, -127, -63, -31, -7, -1, 0, 7, 31, 63, 127, 191, 255];
const localProperties = (plane, width, height, property) => captureLocalProperties(plane, width, height, property);
function planPrice(plan) {
  const writer = new BitWriter(512);
  const histograms = writeChannelHistograms(writer, writeTree(writer, plan.tree), plan.freqs, l => plan.leaves.indexOf(l));
  let bits = writer.bitLength;
  plan.freqs.forEach((freq, i) => { const {lengths} = histograms[i + 1].code; for (let s = 0; s < freq.length; s++) bits += freq[s] * ((lengths[s] || 0) + localRaw(s)); });
  return bits;
}

function plansOf(planes, width, height, rung) {
  return planes.map(plane => {
    let best;
    for (const predictor of plane instanceof Int16Array ? [5, 3, 6] : [5, 3]) {
      const properties = predictor === 6 ? new Int32Array(width * height) : null;
      const values = residuals(plane, width, height, predictor, properties), one = leaf(predictor);
      const candidates = [{...tokens(values), leaves: [one], tree: one}];
      if (properties) candidates.push(intervalPlan(values, properties, predictor, 15, WEIGHTED_LOCAL_CUTS));
      if (rung >= 6 && predictor === 5) for (const property of [9, 10]) {
        const local = localProperties(plane, width, height, property), cuts = property === 9 ? GRADIENT_CUTS : WEIGHTED_LOCAL_CUTS;
        if (local) candidates.push(intervalPlan(values, local, predictor, property, cuts));
      }
      for (const plan of candidates) { const bits = planPrice(plan); if (!best || bits < best.bits) best = {...plan, bits}; }
    }
    if (rung >= 6 && plane instanceof Int16Array && width * height >= 4096) {
      const learned = learnedPlan(plane, width, height, rung);
      if (learned) { const bits = planPrice(learned); if (bits < best.bits) best = {...learned, bits}; }
    }
    return best;
  });
}

function learnedPlan(plane, width, height) {
  let model;
  try { model = learnTree(plane, width, height, {nodes: 99}); } catch (error) { if (error.code === 'JXL_WASM' || error.code === 'JXL_INTERNAL') return null; throw error; }
  if (!model) return null;
  const {tree, leaves, values, contexts} = model;
  const packed = Uint32Array.from(values), freqs = captureLocalTokens(packed, contexts, LEARNED, RESIDUAL_CONFIG, LZ77, ALPHABET, leaves.length);
  return {tree, leaves, freqs, values: packed, properties: contexts, cuts: LEARNED};
}

function writeModel(writer, plans) {
  const leaves = plans.flatMap(plan => plan.leaves);
  const histograms = writeChannelHistograms(writer, writeTree(writer, channelTree(plans.map(plan => plan.tree))), plans.flatMap(plan => plan.freqs), l => leaves.indexOf(l));
  return () => {
    for (let c = 0; c < plans.length; c++) {
      const {values, properties, cuts, mapping} = plans[c], codes = plans[c].leaves.map(l => histograms[leaves.indexOf(l) + 1].code);
      captureLocalWrite(writer, values, properties, cuts, codes, mapping, RESIDUAL_CONFIG, LZ77, ALPHABET);
    }
  };
}

function writeModelAns(writer, plans) {
  const leaves = plans.flatMap(plan => plan.leaves), freqs = plans.flatMap(plan => plan.freqs);
  const ordered = writeTree(writer, channelTree(plans.map(plan => plan.tree)));
  const write = writeModularAnsHistograms(writer, ordered, freqs, l => leaves.indexOf(l));
  return () => {
    const parts = plans.map(plan => captureLocalTokens(plan.values, plan.properties, plan.cuts, RESIDUAL_CONFIG, LZ77, ALPHABET, plan.freqs.length,
      {first: leaves.indexOf(plan.leaves[0]), map: plan.mapping}));
    const used = parts.reduce((total, part) => total + part.used, 0);
    let {tags, extra} = parts[0];
    if (parts.length > 1) {
      tags = new Uint32Array(used); extra = new Uint32Array(used);
      for (let p = 0, at = 0; p < parts.length; at += parts[p++].used) { tags.set(parts[p].tags, at); extra.set(parts[p].extra, at); }
    }
    write([{tags, extra, used, freqs}]);
  };
}

function smallerSection(build) {
  const prefix = build(writeModel);
  try { const ans = build(writeModelAns); return ans.length < prefix.length ? ans : prefix; }
  catch (error) { if (error?.code === 'JXL_SIZE') return prefix; throw error; }
}

const nativePlane = (setup, c) => setup.samples && !(setup.chan?.[c] && setup.chan[c].length < 32768) ? Int32Array : Int16Array;

function localGroup(setup) {
  const fill = planeFill(setup), planes = Array.from({length: setup.palette ? 1 : setup.channels}, (_, c) => new (nativePlane(setup, c))(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    const plans = plansOf(planes, w, h, setup.rung), build = model => {
      const section = new BitWriter(w * h * planes.length + 256);
      writeModularHeader(section, {useGlobalTree: false});
      model(section, plans)();
      return section.finish();
    };
    return setup.samples ? smallerSection(build) : build(writeModel);
  };
}

export function* localSteps(rgba, width, height, shape, colorSpace, rung = 4, usePalette = false, ceiling = Infinity) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const palette = usePalette ? shape.palette : null;
  if (usePalette && !palette) return null;
  const setup = {channels, alpha: shape.alpha, palette: palette && palette.colours, rung};
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const transforms = palette ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}] : channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
  let palettePlans;
  if (palette) {
    const count = palette.colours.length, values = new Int16Array(count * channels);
    palette.colours.forEach((colour, i) => { for (let c = 0; c < channels; c++) values[c * count + i] = palette.byte(colour, c); });
    palettePlans = plansOf([values], count, channels, rung);
  }
  const global = new BitWriter(4096), sections = [];
  let sectionBytes = 0;
  const appendSection = bytes => {
    sectionBytes += bytes.length; admitOutputSize(sectionBytes);
    sections.push(bytes);
    return bytes;
  };
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    const planes = Array.from({length: palette ? 1 : channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
    planeFill(setup)(planes, rgba, width, 0, 0, width, height);
    const write = writeModel(global, [...palettePlans || [], ...plansOf(planes, width, height, rung)]);
    writeModularHeader(global, {transforms});
    write(); appendSection(global.finish());
    if (yield 1) return null;
    if (sectionBytes >= ceiling) return null;
    return assembleCodestream(header, sections);
  }
  let write;
  if (palettePlans) write = writeModel(global, palettePlans);
  else {
    const only = leaf(5);
    writeChannelHistograms(global, writeTree(global, only), [new Uint32Array(ALPHABET)], () => 0);
  }
  writeModularHeader(global, {transforms});
  if (write) write();
  appendSection(global.finish());
  if (sectionBytes >= ceiling) return null;
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  const group = localGroup(setup);
  if ((yield* groupPass({at: g => (g + 1) / groups, stop: () => true, byteCeiling: ceiling - sectionBytes},
    groups, g => appendSection(group(rgba, width, ...groupRect(layout, width, height, g))))) === null) return null;
  return assembleCodestream(header, sections);
}

export function* nativeLocalSteps(data, width, height, shape, samples, rung = 4, ceiling = Infinity) {
  const {channels, alpha, chan} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const tabled = chan.flatMap((table, c) => table ? [c] : []), setup = {channels, alpha, samples, chan, rung};
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, alpha, samples);
  writeModularFrameHeader(header, {alpha});
  const transforms = tabled.map((c, at) => ({type: 'palette', beginC: at + c, numC: 1, nbColors: chan[c].length}));
  const metaPlans = tabled.map(c => Int32Array.from(chan[c])).reverse().flatMap(plane => plansOf([plane], plane.length, 1, rung));
  const level = samples.level === 10 || samples.bitDepth > 12 || samples.exponentBits ? 10 : 5;
  const global = new BitWriter(4096), sections = [];
  let sectionBytes = 0;
  const appendSection = bytes => { sectionBytes += bytes.length; admitOutputSize(sectionBytes); sections.push(bytes); return bytes; };
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    const planes = Array.from({length: channels}, (_, c) => new (nativePlane(setup, c))(width * height));
    planeFill(setup)(planes, data, width, 0, 0, width, height);
    const plans = [...metaPlans, ...plansOf(planes, width, height, rung)];
    appendSection(smallerSection(model => {
      const section = new BitWriter(4096);
      section.write(1, 1); section.write(1, 1);
      const write = model(section, plans);
      writeModularHeader(section, {transforms});
      write();
      return section.finish();
    }));
    if (yield 1) return null;
    if (sectionBytes >= ceiling) return null;
    return assembleCodestream(header, sections, level);
  }
  appendSection(smallerSection(model => {
    const section = new BitWriter(4096);
    section.write(1, 1); section.write(1, 1);
    const write = model(section, metaPlans);
    writeModularHeader(section, {transforms});
    write();
    return section.finish();
  }));
  if (sectionBytes >= ceiling) return null;
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  const group = localGroup(setup);
  if ((yield* groupPass({at: g => (g + 1) / groups, stop: () => true, byteCeiling: ceiling - sectionBytes},
    groups, g => appendSection(group(data, width, ...groupRect(layout, width, height, g))))) === null) return null;
  return assembleCodestream(header, sections, level);
}
