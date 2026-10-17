// Rapier's JPEG XL encoder: the modular sub-bitstream. MIT (LICENSE).
import {kernelHooks} from './kernel-hooks.mjs';
import {packSigned} from './bits.mjs';
import {buildCode, writeHistograms, uintConfig, countToken, writeHybrid} from './prefix.mjs';

export const ZERO_PREDICTOR = 0, AVERAGE_PREDICTOR = 3, GRADIENT_PREDICTOR = 5;
export const PREDICTOR = /*#__PURE__*/ Object.freeze({zero: ZERO_PREDICTOR, left: 1, top: 2, average0: AVERAGE_PREDICTOR, select: 4, gradient: GRADIENT_PREDICTOR, weighted: 6,
  topRight: 7, topLeft: 8, leftLeft: 9, average1: 10, average2: 11, average3: 12, average4: 13});

const MIN_RUN_SYMBOL = 224, MIN_RUN_LENGTH = 7, RUN_CONFIG = uintConfig(4);
export const LZ77 = Object.freeze({minSymbol: MIN_RUN_SYMBOL, minLength: MIN_RUN_LENGTH, lengthConfig: RUN_CONFIG});
export const RESIDUAL_CONFIG = uintConfig(0);
export const ALPHABET = MIN_RUN_SYMBOL + 33;

export function leaf(predictor, offset = 0, multiplier = 1) { return {predictor, offset, multiplier, context: -1}; }
export function split(property, splitval, left, right) { return {property, splitval, left, right}; }

function propertyTree(items, property) {
  const build = (lo, hi) => {
    if (lo === hi) return property ? items[lo].tree : items[lo];
    const mid = (lo + hi) >> 1;
    return split(property, property ? items[mid].streamId : mid, build(mid + 1, hi), build(lo, mid));
  };
  return build(0, items.length - 1);
}
export function channelTree(leaves) { return propertyTree(leaves, 0); }

export function writeTree(w, root) {
  const queue = [root], tokens = [], leaves = [];
  for (const node of queue) {
    if (node.left) { tokens.push(node.property + 1, packSigned(node.splitval)); queue.push(node.left, node.right); continue; }
    node.context = leaves.length; leaves.push(node);
    const mulLog = node.multiplier === 1 ? 0 : 31 - Math.clz32(node.multiplier & -node.multiplier);
    tokens.push(0, node.predictor, packSigned(node.offset), mulLog, (node.multiplier >> mulLog) - 1);
  }
  const freqs = new Uint32Array(64);
  for (const value of tokens) countToken(RESIDUAL_CONFIG, value, freqs);
  const code = buildCode(freqs);
  writeHistograms(w, {contextMap: new Uint8Array(6), histograms: [{config: RESIDUAL_CONFIG, code}]});
  for (const value of tokens) writeHybrid(w, code, RESIDUAL_CONFIG, value);
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

export function writeModularHeader(w, {useGlobalTree = true, transforms = []} = {}) {
  w.write(1, useGlobalTree ? 1 : 0);
  w.write(1, 1);
  w.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], transforms.length);
  for (const transform of transforms) writeTransform(w, transform);
}

export function streamTree(sections) { return propertyTree(sections, 1); }

export function writeChannelHistograms(w, orderedLeaves, freqs, histogramOf = leaf => leaf.context, configOf = () => RESIDUAL_CONFIG) {
  const contextMap = new Uint8Array(orderedLeaves.length + 1);
  for (const leaf of orderedLeaves) contextMap[leaf.context] = histogramOf(leaf) + 1;
  const distance = new Uint32Array(2); distance[1] = 1;
  const histograms = [{config: RESIDUAL_CONFIG, code: buildCode(distance)}];
  const count = Math.max(...contextMap);
  for (let i = 0; i < count; i++) histograms.push({config: configOf(i), code: buildCode(freqs[i])});
  writeHistograms(w, {lz77: LZ77, contextMap, histograms});
  return histograms;
}

export function codeChannel(w, target, plane, width, height, leaf, raw = false) {
  if (kernelHooks.channel?.(w, target, plane, width, height, leaf, raw)) return;
  const predictor = leaf.predictor, offset = leaf.offset, multiplier = leaf.multiplier;
  const config = leaf.config || RESIDUAL_CONFIG, lengthConfig = RUN_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (w) writeHybrid(w, target, tokenConfig, value, base);
    else if (raw && !base) target[value]++;
    else countToken(tokenConfig, value, target, raw ? target.length - 33 : base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) {
      emit(0);
      const count = run - MIN_RUN_LENGTH - 1;
      emit(count, lengthConfig, MIN_RUN_SYMBOL);
    } else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  const residual = (index, pred) => {
    const value = plane[index];
    let r;
    if (multiplier === 1) r = (value - pred - offset) | 0;
    else { r = Math.round((value - pred - offset) / multiplier); plane[index] = pred + offset + r * multiplier; }
    if (r === 0) { run++; return; }
    flush();
    emit(packSigned(r));
  };
  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      let pred;
      if (predictor === 0) pred = 0;
      else {
        const left = x ? plane[index - 1] : y ? plane[index - width] : 0;
        const top = y ? plane[index - width] : left;
        if (predictor === 1) pred = left;
        else if (predictor === 2) pred = top;
        else if (predictor === 3) pred = ((left + top) / 2) | 0;
        else {
          const topleft = x && y ? plane[index - width - 1] : left, grad = left + top - topleft;
          if (predictor === 5) {
            const lo = left < top ? left : top, hi = left < top ? top : left;
            pred = grad < lo ? lo : grad > hi ? hi : grad;
          } else if (predictor === 4) pred = Math.abs(grad - left) < Math.abs(grad - top) ? left : top;
          else throw new Error('predictor ' + predictor + ' is not coded here');
        }
      }
      residual(index, pred);
    }
  }
  flush();
}
