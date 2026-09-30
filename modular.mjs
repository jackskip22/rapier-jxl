// Rapier's JPEG XL encoder: the modular sub-bitstream. MIT (LICENSE).
// Trees, transforms and channel residuals as the specification's modular decoder reads them. A channel is coded
// through the tree leaf it lands on: prediction, then `PackSigned(residual)` as a hybrid-integer token; runs of
// zero residuals of eight or more become one zero and an LZ77 copy of length run-1 at distance 1.
import {packSigned, floorLog2} from './bits.mjs';
import {buildCode, writeHistograms, uintConfig, countToken, hybridToken} from './prefix.mjs';

export const PREDICTOR = Object.freeze({zero: 0, left: 1, top: 2, average0: 3, select: 4, gradient: 5, weighted: 6,
  topRight: 7, topLeft: 8, leftLeft: 9, average1: 10, average2: 11, average3: 12, average4: 13});

export const LZ77 = Object.freeze({minSymbol: 224, minLength: 7, lengthConfig: uintConfig(4)});
export const RESIDUAL_CONFIG = uintConfig(0);
export const ALPHABET = LZ77.minSymbol + 33;

export function leaf(predictor, offset = 0, multiplier = 1) { return {predictor, offset, multiplier, context: -1}; }
export function split(property, splitval, left, right) { return {property, splitval, left, right}; }

// One leaf per channel, split on the channel property (0): channels above the split value go left.
export function channelTree(leaves) {
  const build = (lo, hi) => {
    if (lo === hi) return leaves[lo];
    const mid = (lo + hi) >> 1;
    return split(0, mid, build(mid + 1, hi), build(lo, mid));
  };
  return build(0, leaves.length - 1);
}

// Writes the tree with its own histogram bundle (six contexts, one histogram) and numbers the leaves in the
// decoder's order. Returns the leaves in that order.
export function writeTree(w, root) {
  const queue = [root], tokens = [], leaves = [];
  while (queue.length) {
    const node = queue.shift();
    if (node.left) { tokens.push(node.property + 1, packSigned(node.splitval)); queue.push(node.left, node.right); continue; }
    node.context = leaves.length; leaves.push(node);
    const mulLog = node.multiplier === 1 ? 0 : 31 - Math.clz32(node.multiplier & -node.multiplier);
    tokens.push(0, node.predictor, packSigned(node.offset), mulLog, (node.multiplier >> mulLog) - 1);
  }
  const freqs = new Uint32Array(64);
  for (const value of tokens) countToken(RESIDUAL_CONFIG, value, freqs);
  const code = buildCode(freqs);
  writeHistograms(w, {contextMap: new Uint8Array(6), histograms: [{config: RESIDUAL_CONFIG, code}]});
  const t = [0, 0, 0];
  for (const value of tokens) { hybridToken(RESIDUAL_CONFIG, value, t); w.write(code.lengths[t[0]], code.codes[t[0]]); if (t[1]) w.write(t[1], t[2]); }
  return leaves;
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
  } else throw new Error('unknown transform ' + transform.type);
}

// The group header: whether the global tree applies, the (default) weighted predictor header, the transforms.
export function writeModularHeader(w, {useGlobalTree = true, transforms = []} = {}) {
  w.write(1, useGlobalTree ? 1 : 0);
  w.write(1, 1);
  w.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], transforms.length);
  for (const transform of transforms) writeTransform(w, transform);
}

// Splits on the stream property (1): one subtree per section, for sections whose channels differ. `sections` are
// {streamId, tree} sorted by stream id; a stream above the split value goes left.
export function streamTree(sections) {
  const build = (lo, hi) => {
    if (lo === hi) return sections[lo].tree;
    const mid = (lo + hi) >> 1;
    return split(1, sections[mid].streamId, build(mid + 1, hi), build(lo, mid));
  };
  return build(0, sections.length - 1);
}

// The channel histogram bundle after a tree: histogram 0 holds the LZ77 distance (one symbol, 1: distance one);
// histogram i+1 is `freqs[i]`, and every ordered leaf names its histogram through `histogramOf(leaf)`.
export function writeChannelHistograms(w, orderedLeaves, freqs, histogramOf = leaf => leaf.context) {
  const contextMap = new Uint8Array(orderedLeaves.length + 1);
  for (const leaf of orderedLeaves) contextMap[leaf.context] = histogramOf(leaf) + 1;
  const distance = new Uint32Array(2); distance[1] = 1;
  const histograms = [{config: RESIDUAL_CONFIG, code: buildCode(distance)}];
  for (const f of freqs) histograms.push({config: RESIDUAL_CONFIG, code: buildCode(f)});
  writeHistograms(w, {lz77: LZ77, contextMap, histograms});
  return histograms;
}

// Codes one channel plane (Int32Array, width*height) through `leaf`. Counting when `w` is null: `target` is the
// leaf's token histogram (Uint32Array(ALPHABET)). Writing otherwise: `target` is the leaf's prefix code. Lossy
// leaves (multiplier above one) replace the plane's values by the decoder's reconstruction as they go.
export function codeChannel(w, target, plane, width, height, leaf) {
  const predictor = leaf.predictor, offset = leaf.offset, multiplier = leaf.multiplier;
  const config = RESIDUAL_CONFIG, lengthConfig = LZ77.lengthConfig, t = [0, 0, 0];
  const lengths = w ? target.lengths : null, codes = w ? target.codes : null;
  let run = 0;
  const emit = value => {
    if (!w) { countToken(config, value, target); return; }
    hybridToken(config, value, t);
    w.write(lengths[t[0]], codes[t[0]]);
    if (t[1]) w.write(t[1], t[2]);
  };
  const flush = () => {
    if (!run) return;
    if (run >= LZ77.minLength + 1) {
      emit(0);
      const count = run - LZ77.minLength - 1;
      if (!w) countToken(lengthConfig, count, target, LZ77.minSymbol);
      else { hybridToken(lengthConfig, count, t); const symbol = LZ77.minSymbol + t[0]; w.write(lengths[symbol], codes[symbol]); if (t[1]) w.write(t[1], t[2]); }
    } else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  const residual = (index, pred) => {
    const value = plane[index];
    let r;
    if (multiplier === 1) r = value - pred - offset;
    else { r = Math.round((value - pred - offset) / multiplier); plane[index] = pred + offset + r * multiplier; }
    if (r === 0) { run++; return; }
    flush();
    emit(packSigned(r));
  };
  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      let pred;
      if (predictor === 5) {
        const left = x ? plane[index - 1] : y ? plane[index - width] : 0;
        const top = y ? plane[index - width] : left;
        const topleft = x && y ? plane[index - width - 1] : left;
        const grad = left + top - topleft, lo = left < top ? left : top, hi = left < top ? top : left;
        pred = grad < lo ? lo : grad > hi ? hi : grad;
      } else if (predictor === 0) pred = 0;
      else if (predictor === 1) pred = x ? plane[index - 1] : y ? plane[index - width] : 0;
      else if (predictor === 2) pred = y ? plane[index - width] : x ? plane[index - 1] : 0;
      else if (predictor === 3) {
        const left = x ? plane[index - 1] : y ? plane[index - width] : 0, top = y ? plane[index - width] : left;
        pred = ((left + top) / 2) | 0;
      } else if (predictor === 4) {
        const left = x ? plane[index - 1] : y ? plane[index - width] : 0, top = y ? plane[index - width] : left;
        const topleft = x && y ? plane[index - width - 1] : left, p = left + top - topleft;
        pred = Math.abs(p - left) < Math.abs(p - top) ? left : top;
      } else throw new Error('predictor ' + predictor + ' is not coded here');
      residual(index, pred);
    }
  }
  flush();
}
