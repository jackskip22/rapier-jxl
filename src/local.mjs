// SPDX-License-Identifier: MIT
// Effort-only Modular modelling. Every group owns its tree and histograms; a bounded group of samples is the
// working set, and the complete candidate competes against every lower rung at the door.
import {BitWriter, packSigned} from './bits.mjs';
import {writeImageHeader, writeModularFrameHeader, groupLayout, groupRect, groupPass, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {buildCode, writePrefixCode, countToken, writeHybrid} from './prefix.mjs';
import {ALPHABET, LZ77, RESIDUAL_CONFIG, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {codeWeighted} from './weighted.mjs';
import {admitOutputSize} from './admit.mjs';
import {planeFill} from './lossless.mjs';

const localRaw = s => Math.max(0, s < 224 ? s - 1 : s - 236);
const price = freqs => {
  const code = buildCode(freqs), writer = new BitWriter(128);
  writePrefixCode(writer, code);
  let bits = writer.bitLength;
  for (let s = 0; s < freqs.length; s++) if (freqs[s]) bits += freqs[s] * (code.lengths[s] + localRaw(s));
  return bits;
};

// Residuals are exactly the decoder's unsigned values before entropy coding, including RGB under zero alpha.
function residuals(plane, width, height, predictor, properties) {
  const out = new Uint32Array(width * height);
  if (predictor === 6) { codeWeighted(null, null, plane, width, height, 0, undefined, out, properties); return out; }
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
    const left = x ? plane[i - 1] : y ? plane[i - width] : 0, top = y ? plane[i - width] : left;
    const nw = x && y ? plane[i - width - 1] : left;
    const prediction = predictor === 3 ? ((left + top) / 2) | 0 : Math.max(Math.min(left, top), Math.min(Math.max(left, top), left + top - nw));
    out[i] = packSigned(plane[i] - prediction);
  }
  return out;
}

function tokens(values, contexts, count = 1) {
  const freqs = Array.from({length: count}, () => new Uint32Array(ALPHABET)), pieces = [];
  const emit = (i, value, base = 0) => {
    const context = contexts ? contexts[i] : 0;
    pieces.push(value, base, context); countToken(base ? LZ77.lengthConfig : RESIDUAL_CONFIG, value, freqs[context], base);
  };
  // A zero run can cross a tree leaf or row. Its first literal and copy use their own samples' contexts.
  for (let i = 0; i < values.length;) {
    let run = 1;
    if (!values[i]) while (i + run < values.length && !values[i + run]) run++;
    emit(i, values[i]);
    if (run > LZ77.minLength) {
      emit(i + 1, run - 1 - LZ77.minLength, LZ77.minSymbol);
    } else for (let n = 1; n < run; n++) emit(i + n, 0);
    i += run;
  }
  return {freqs, pieces};
}

function intervalPlan(values, properties, predictor, property, cuts) {
  const contexts = Uint8Array.from(properties, value => {
    let lo = 0, hi = cuts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (value > cuts[mid]) lo = mid + 1; else hi = mid; }
    return lo;
  });
  const coded = tokens(values, contexts, cuts.length + 1), count = coded.freqs.length, filled = coded.freqs.map(freq => freq.some(n => n));
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
  for (let i = 2; i < coded.pieces.length; i += 3) coded.pieces[i] = mapping[coded.pieces[i]];
  const tree = (lo, hi) => {
    if (lo === hi) return leaves[lo];
    const mid = (lo + hi) >> 1;
    return split(property, cuts[spans[mid][1] - 1], tree(mid + 1, hi), tree(lo, mid));
  };
  return {leaves, tree: tree(0, spans.length - 1), freqs, pieces: coded.pieces};
}

const WEIGHTED_LOCAL_CUTS = [-127, -31, -7, -1, 0, 1, 7, 31, 127];
const GRADIENT_CUTS = [-191, -127, -63, -31, -7, -1, 0, 7, 31, 63, 127, 191, 255];
function localProperties(plane, width, height, property) {
  const out = new Int32Array(width * height);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
    const left = x ? plane[i - 1] : y ? plane[i - width] : 0, top = y ? plane[i - width] : left;
    const nw = x && y ? plane[i - width - 1] : left;
    out[i] = property === 9 ? left + top - nw : left - nw;
  }
  return out;
}
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
    for (const predictor of [5, 3, 6]) {
      const properties = predictor === 6 ? new Int32Array(width * height) : null;
      const values = residuals(plane, width, height, predictor, properties), one = leaf(predictor);
      const candidates = [{...tokens(values), leaves: [one], tree: one}];
      if (properties) candidates.push(intervalPlan(values, properties, predictor, 15, WEIGHTED_LOCAL_CUTS));
      // Property 9 is the unclamped gradient; property 10 is W - NW. Signed cuts let the latter separate both
      // tails around a flat neighbourhood without treating a high-magnitude negative edge as a small one.
      if (rung >= 6 && predictor === 5) for (const property of [9, 10]) {
        const local = localProperties(plane, width, height, property), cuts = property === 9 ? GRADIENT_CUTS : WEIGHTED_LOCAL_CUTS;
        candidates.push(intervalPlan(values, local, predictor, property, cuts));
      }
      for (const plan of candidates) { const bits = planPrice(plan); if (!best || bits < best.bits) best = {...plan, bits}; }
    }
    return best;
  });
}

function writeModel(writer, plans) {
  const leaves = plans.flatMap(plan => plan.leaves);
  const histograms = writeChannelHistograms(writer, writeTree(writer, channelTree(plans.map(plan => plan.tree))), plans.flatMap(plan => plan.freqs), l => leaves.indexOf(l));
  return () => {
    for (let c = 0; c < plans.length; c++) {
      const {pieces} = plans[c], codes = plans[c].leaves.map(l => histograms[leaves.indexOf(l) + 1].code);
      for (let i = 0; i < pieces.length; i += 3) {
        const base = pieces[i + 1];
        writeHybrid(writer, codes[pieces[i + 2]], base ? LZ77.lengthConfig : RESIDUAL_CONFIG, pieces[i], base);
      }
    }
  };
}

// A group's own trees and histograms, here or in a pool's worker: the group's section, its bytes returned.
export function localGroup(setup) {
  const fill = planeFill(setup), planes = Array.from({length: setup.palette ? 1 : setup.channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
  return (rgba, stride, x0, y0, w, h) => {
    fill(planes, rgba, stride, x0, y0, w, h);
    const section = new BitWriter(w * h * planes.length + 256);
    writeModularHeader(section, {useGlobalTree: false});
    writeModel(section, plansOf(planes, w, h, setup.rung))();
    return section.finish();
  };
}

export function* localSteps(rgba, width, height, shape, colorSpace, rung = 4, usePalette = false, pooled) {
  const {channels} = shape, layout = groupLayout(width, height), groups = layout.groupsX * layout.groupsY;
  const palette = usePalette ? shape.palette : null;
  if (usePalette && !palette) return null;
  const setup = {channels, alpha: shape.alpha, palette: palette && palette.colours, rung};
  const header = new BitWriter(256);
  writeImageHeader(header, width, height, shape.colour, shape.alpha, {colorSpace});
  writeModularFrameHeader(header, {alpha: shape.alpha});
  const transforms = palette ? [{type: 'palette', beginC: 0, numC: channels, nbColors: palette.colours.length}] : channels >= 3 ? [{type: 'rct', beginC: 0, rctType: 6}] : [];
  // The palette's meta channel precedes the picture in the global section; local AC groups contain only indices.
  let palettePlans;
  if (palette) {
    const count = palette.colours.length, values = new Int16Array(count * channels);
    palette.colours.forEach((colour, i) => { for (let c = 0; c < channels; c++) values[c * count + i] = palette.byte(colour, c); });
    palettePlans = plansOf([values], count, channels, rung);
  }
  const global = new BitWriter(4096), sections = [];
  let sectionBytes = 0;
  const appendSection = bytes => {
    // Refuse before retaining later groups of an oversized optional candidate.
    sectionBytes += bytes.length; admitOutputSize(sectionBytes);
    sections.push(bytes);
  };
  global.write(1, 1); global.write(1, 1);
  if (layout.single) {
    // One group: everything in the global section, the palette's plans before the picture's.
    const planes = Array.from({length: palette ? 1 : channels}, () => new Int16Array(GROUP_DIM * GROUP_DIM));
    planeFill(setup)(planes, rgba, width, 0, 0, width, height);
    const write = writeModel(global, [...palettePlans || [], ...plansOf(planes, width, height, rung)]);
    writeModularHeader(global, {transforms});
    write(); appendSection(global.finish());
    if (yield 1) return null;
    return assembleCodestream(header, sections);
  }
  let write;
  if (palettePlans) write = writeModel(global, palettePlans);
  else {
    const leaves = Array.from({length: channels}, () => leaf(5));
    writeChannelHistograms(global, writeTree(global, channelTree(leaves)), leaves.map(() => new Uint32Array(ALPHABET)), l => leaves.indexOf(l));
  }
  writeModularHeader(global, {transforms});
  if (write) write();
  appendSection(global.finish());
  for (let i = 0; i < layout.dcGroupsX * layout.dcGroupsY + 1; i++) sections.push(new Uint8Array(0));
  const group = localGroup(setup);
  if ((yield* groupPass({pooled, kind: 'local', setup, at: g => (g + 1) / groups, stop: () => true},
    groups, g => appendSection(group(rgba, width, ...groupRect(layout, width, height, g))), (g, bytes) => appendSection(bytes))) === null) return null;
  return assembleCodestream(header, sections);
}
