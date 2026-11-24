// Rapier's JPEG XL encoder: the modular sub-bitstream. MIT (images/jxl/LICENSE).
import {BitWriter, packSigned} from './bits.mjs';
import {fault} from './fault.mjs';
import {buildCode, priceCode, canonicalCodes, writeHistograms, uintConfig, countToken, hybridToken, writeHybrid} from './prefix.mjs';

export const ZERO_PREDICTOR = 0, AVERAGE_PREDICTOR = 3, GRADIENT_PREDICTOR = 5;
export const PREDICTOR = /*#__PURE__*/ Object.freeze({zero: ZERO_PREDICTOR, left: 1, top: 2, average0: AVERAGE_PREDICTOR, select: 4, gradient: GRADIENT_PREDICTOR, weighted: 6,
  topRight: 7, topLeft: 8, leftLeft: 9, average1: 10, average2: 11, average3: 12, average4: 13});

export const MIN_RUN_SYMBOL = 224, MIN_RUN_LENGTH = 7, RUN_CONFIG = uintConfig(4);
export const LZ77 = Object.freeze({minSymbol: MIN_RUN_SYMBOL, minLength: MIN_RUN_LENGTH, lengthConfig: RUN_CONFIG});
export const RESIDUAL_CONFIG = uintConfig(0);
export const ALPHABET = MIN_RUN_SYMBOL + 33;

export function leaf(predictor, offset = 0, multiplier = 1) { return {predictor, offset, multiplier, context: -1}; }
const EDGE_SPLITS = new Map([[-8193, -8192], [8191, 8190]]);
export function split(property, splitval, left, right) {
  if ((property === 9 || property === 15) && EDGE_SPLITS.has(splitval)) splitval = EDGE_SPLITS.get(splitval);
  return {property, splitval, left, right};
}

export function intervals(property, cuts, child) {
  const build = (lo, hi) => {
    if (lo === hi) return child(lo);
    const mid = (lo + hi) >> 1;
    return split(property, cuts[mid], build(mid + 1, hi), build(lo, mid));
  };
  return build(0, cuts.length);
}
export function channelTree(leaves) { return intervals(0, Array.from({length: leaves.length - 1}, (_, k) => k), i => leaves[i]); }

export function writeTree(w, root, separate = false) {
  const queue = [root], tokens = [], leaves = [];
  const contexts = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && separate ? [] : null;
  for (const node of queue) {
    if (node.left) {
      if (!(node.property >= 0 && node.property <= 255)) throw fault('JXL_INTERNAL', `modular:property ${node.property}`);
      tokens.push(node.property + 1, packSigned(node.splitval)); contexts?.push(1, 0); queue.push(node.left, node.right); continue; }
    node.context = leaves.length; leaves.push(node);
    const mulLog = node.multiplier === 1 ? 0 : 31 - Math.clz32(node.multiplier & -node.multiplier);
    tokens.push(0, node.predictor, packSigned(node.offset), mulLog, (node.multiplier >> mulLog) - 1);
    contexts?.push(1, 2, 3, 3, 3);
  }
  const freqs = new Uint32Array(64);
  for (const value of tokens) countToken(RESIDUAL_CONFIG, value, freqs);
  const code = buildCode(freqs);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && contexts) {
    writeContextTree(w, tokens, contexts, code);
    return leaves;
  }
  writeHistograms(w, {contextMap: new Uint8Array(6), histograms: [{config: RESIDUAL_CONFIG, code}]});
  for (const value of tokens) writeHybrid(w, code, RESIDUAL_CONFIG, value);
  return leaves;
}

const TREE_CONFIGS = /* @__PURE__ */ [[0], [1], [2], [3], [4], [4, 1, 1], [4, 2, 0], [4, 1, 2], [5, 1, 1], [2, 0, 1], [3, 0, 1]].map(a => uintConfig(...a));
const TREE_MAP = /* @__PURE__ */ Uint8Array.of(0, 1, 2, 3, 3, 3), TREE_ONE = /* @__PURE__ */ new Uint8Array(6), ONE_CONTEXT = /* @__PURE__ */ new Uint8Array(1);
function treeHeader(histograms, contextMap) {
  const header = new BitWriter(256);
  writeHistograms(header, {contextMap, histograms});
  return header;
}
function treeDataBits(values, code, config) {
  const token = [0, 0, 0];
  let bits = 0;
  for (const [value, count] of values) {
    hybridToken(config, value, token);
    bits += count * (code.lengths[token[0]] + token[1]);
  }
  return bits;
}
function writeContextTree(w, tokens, contexts, oldCode) {
  const values = Array.from({length: 4}, () => new Map()), whole = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i], counts = values[contexts[i]];
    counts.set(value, (counts.get(value) ?? 0) + 1);
    whole.set(value, (whole.get(value) ?? 0) + 1);
  }
  let header = treeHeader([{config: RESIDUAL_CONFIG, code: oldCode}], TREE_ONE);
  const originalBits = header.bitLength + treeDataBits(whole, oldCode, RESIDUAL_CONFIG);
  const histograms = values.map(counts => {
    let best = null;
    for (const config of TREE_CONFIGS) {
      const freqs = new Uint32Array(256), token = [0, 0, 0];
      let valid = true;
      for (const [value, count] of counts) {
        hybridToken(config, value, token);
        if (token[0] >= freqs.length) { valid = false; break; }
        freqs[token[0]] += count;
      }
      if (!valid) continue;
      const code = priceCode(freqs), dataBits = treeDataBits(counts, code, config);
      const bits = treeHeader([{config, code}], ONE_CONTEXT).bitLength + dataBits;
      if (!best || bits < best.bits) best = {config, code, dataBits, bits};
      if (!counts.size || counts.size === 1 && counts.has(0)) break;
    }
    return best;
  });
  const splitHeader = treeHeader(histograms, TREE_MAP);
  const splitBits = splitHeader.bitLength + histograms.reduce((n, h) => n + h.dataBits, 0);
  const split = splitBits < originalBits;
  if (split) { header = splitHeader; for (const h of histograms) h.code.codes = canonicalCodes(h.code.lengths); }
  const single = {code: oldCode, config: RESIDUAL_CONFIG};
  w.append(header);
  for (let i = 0; i < tokens.length; i++) {
    const h = split ? histograms[contexts[i]] : single;
    writeHybrid(w, h.code, h.config, tokens[i]);
  }
}

export function writeTransform(w, transform) {
  const beginC = [[3, 0], [6, 8], [10, 72], [13, 1096]];
  if (transform.type === 'rct') { w.write(2, 0); w.writeU32(beginC, transform.beginC); w.writeU32([[0, 6], [2, 0], [4, 2], [6, 10]], transform.rctType ?? 6); }
  else if (transform.type === 'palette') {
    w.write(2, 1); w.writeU32(beginC, transform.beginC);
    w.writeU32([[0, 1], [0, 3], [0, 4], [13, 1]], transform.numC);
    w.writeU32([[8, 0], [10, 256], [12, 1280], [16, 5376]], transform.nbColors);
    w.writeU32([[0, 0], [8, 1], [10, 257], [16, 1281]], transform.nbDeltas ?? 0);
    w.write(4, transform.predictor ?? 0);
  } else if (transform.type === 'squeeze') {
    w.write(2, 2);
    const params = transform.params ?? [];
    w.writeU32([[0, 0], [4, 1], [6, 9], [8, 41]], params.length);
    for (const p of params) {
      w.write(1, p.horizontal ? 1 : 0); w.write(1, p.inPlace ? 1 : 0);
      w.writeU32(beginC, p.beginC); w.writeU32([[0, 1], [0, 2], [0, 3], [4, 4]], p.numC);
    }
  } else throw fault('JXL_INTERNAL', 'modular:transform ' + transform.type);
}

export function writeModularHeader(w, {useGlobalTree = true, transforms = [], weighted = null} = {}) {
  w.write(1, useGlobalTree ? 1 : 0);
  w.write(1, (typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && weighted ? 0 : 1);
  if ((typeof __RAPIER_JXL_EFFORT_TEN__ === 'undefined' || __RAPIER_JXL_EFFORT_TEN__ === true) && weighted) weighted.forEach((value, i) => w.write(i < 7 ? 5 : 4, value));
  w.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], transforms.length);
  for (const transform of transforms) writeTransform(w, transform);
}

export function streamTree(sections) { return intervals(1, sections.slice(0, -1).map(s => s.streamId), i => sections[i].tree); }

export function writeChannelHistograms(w, orderedLeaves, freqs, histogramOf = leaf => leaf.context, configOf = () => RESIDUAL_CONFIG) {
  const contextMap = new Uint8Array(orderedLeaves.length + 1);
  for (const leaf of orderedLeaves) {
    const h = histogramOf(leaf) + 1;
    if (h > 255) throw fault('JXL_INTERNAL', 'modular:histograms');
    contextMap[leaf.context] = h;
  }
  const distance = new Uint32Array(2); distance[1] = 1;
  const histograms = [{config: RESIDUAL_CONFIG, code: buildCode(distance)}];
  const count = Math.max(...contextMap);
  for (let i = 0; i < count; i++) histograms.push({config: configOf(i), code: buildCode(freqs[i])});
  writeHistograms(w, {lz77: LZ77, contextMap, histograms});
  return histograms;
}
