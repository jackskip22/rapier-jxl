// SPDX-License-Identifier: MIT
import {kernelHooks} from './kernel-hooks.mjs';
import {BitWriter, packSigned} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {MIN_RUN_SYMBOL, MIN_RUN_LENGTH, RUN_CONFIG, RESIDUAL_CONFIG, GRADIENT_PREDICTOR, ALPHABET, leaf, split, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';


function codeGradient(w, target, plane, width, height, config, raw, visit) {
  const lengthConfig = RUN_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (visit) visit(value, tokenConfig, base);
    else if (w) writeHybrid(w, target, tokenConfig, value, base);
    else if (raw && !base) target[value]++;
    else countToken(tokenConfig, value, target, raw ? target.length - 33 : base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) { emit(0); emit(run - MIN_RUN_LENGTH - 1, lengthConfig, MIN_RUN_SYMBOL); }
    else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) {
    for (let x = 0; x < width; x++, index++) {
      let pred = 0;
      if (x | y) {
        const left = x ? plane[index - 1] : plane[index - width];
        const top = y ? plane[index - width] : left;
        const nw = x && y ? plane[index - width - 1] : left, grad = left + top - nw;
        const lo = left < top ? left : top, hi = left < top ? top : left;
        pred = grad < lo ? lo : grad > hi ? hi : grad;
      }
      const r = (plane[index] - pred) | 0;
      if (!r) run++;
      else { flush(); emit(r >= 0 ? r + r : -r - r - 1); }
    }
  }
  flush();
}

export function codeChannel(w, target, plane, width, height, leaf, raw = false, visit, residuals, beginY = 0) {
  if (!visit && !residuals && kernelHooks.channel?.(w, target, plane, width, height, leaf, raw)) return;
  const predictor = leaf.predictor, offset = leaf.offset, multiplier = leaf.multiplier;
  if (!residuals && beginY === 0 && predictor === GRADIENT_PREDICTOR && multiplier === 1 && offset === 0)
    return codeGradient(w, target, plane, width, height, leaf.config || RESIDUAL_CONFIG, raw, visit);
  const config = leaf.config || RESIDUAL_CONFIG, lengthConfig = RUN_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (visit) visit(value, tokenConfig, base);
    else if (w) writeHybrid(w, target, tokenConfig, value, base);
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
    if (residuals) { residuals[index] = r; return; }
    if (r === 0) { run++; return; }
    flush();
    emit(packSigned(r));
  };
  for (let y = beginY, index = beginY * width; y < height; y++) {
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

function codeUniformRows(w, target, width, height, rowValues, leafNode) {
  const predictor = leafNode.predictor, config = leafNode.config || RESIDUAL_CONFIG;
  let run = 0;
  const emit = (value, tokenConfig = config, base = 0) => {
    if (w) writeHybrid(w, target, tokenConfig, value, base);
    else countToken(tokenConfig, value, target, base);
  };
  const flush = () => {
    if (!run) return;
    if (run >= MIN_RUN_LENGTH + 1) { emit(0); emit(run - MIN_RUN_LENGTH - 1, RUN_CONFIG, MIN_RUN_SYMBOL); }
    else for (let i = 0; i < run; i++) emit(0);
    run = 0;
  };
  const gradient = predictor === GRADIENT_PREDICTOR;
  if (width > 0) for (let y = 0; y < height; y++) {
    const r = (rowValues[y] - (gradient && y ? rowValues[y - 1] : 0)) | 0;
    if (!r) { run += width; continue; }
    flush();
    for (let x = 0, packed = r >= 0 ? r + r : -r - r - 1; x < (gradient ? 1 : width); x++) emit(packed);
    if (gradient) run += width - 1;
  }
  flush();
}

export const codeMetadataPlane = (w, target, p, leafNode) => p.rowValues
  ? codeUniformRows(w, target, p.w, p.h, p.rowValues, leafNode)
  : codeChannel(w, target, p.data, p.w, p.h, leafNode);

export function writeModularStream(w, planes, predictor, multiplier = 1) {
  const leaves = planes.map(() => leaf(predictor, 0, multiplier)), coded = planes.map(() => leaf(predictor));
  const freqs = leaves.map(() => new Uint32Array(ALPHABET));
  planes.forEach((p, i) => codeMetadataPlane(null, freqs[i], p, coded[i]));
  writeModularHeader(w, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(w, channelTree(leaves));
  const histograms = writeChannelHistograms(w, ordered, freqs, l => leaves.indexOf(l));
  planes.forEach((p, i) => codeMetadataPlane(w, histograms[i + 1].code, p, coded[i]));
}

export function writeSmallerModularStream(w, planes, predictor) {
  const apart = new BitWriter(256), together = new BitWriter(256), one = leaf(predictor), freqs = [new Uint32Array(ALPHABET)];
  writeModularStream(apart, planes, predictor);
  for (const p of planes) codeMetadataPlane(null, freqs[0], p, one);
  writeModularHeader(together, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(together, one), histograms = writeChannelHistograms(together, ordered, freqs, () => 0);
  for (const p of planes) codeMetadataPlane(together, histograms[1].code, p, one);
  w.append(together.bitLength < apart.bitLength ? together : apart);
}

const LOCAL = [-7, -1, 0, 6], SIDE = LOCAL.length + 1;
const bucket = v => { let b = 0; while (b < LOCAL.length && v > LOCAL[b]) b++; return b; };
export function writeLocalModularStream(w, planes) {
  const leaves = planes.map(() => Array.from({length: SIDE * SIDE}, () => leaf(GRADIENT_PREDICTOR)));
  const over = (property, lo, hi, at) => lo === hi ? at(lo) : split(property, LOCAL[(lo + hi) >> 1], over(property, ((lo + hi) >> 1) + 1, hi, at), over(property, lo, (lo + hi) >> 1, at));
  const roots = leaves.map(list => over(10, 0, SIDE - 1, a => over(11, 0, SIDE - 1, b => list[a * SIDE + b])));
  const freqs = leaves.map(list => list.map(() => new Uint32Array(ALPHABET)));
  planes.forEach((p, i) => codeLocal(null, freqs[i], p.data, p.w, p.h));
  writeModularHeader(w, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(w, channelTree(roots)), at = new Map();
  leaves.forEach((list, i) => list.forEach((l, k) => at.set(l, freqs[i][k])));
  const histograms = writeChannelHistograms(w, ordered, ordered.map(l => at.get(l)));
  planes.forEach((p, i) => codeLocal(w, leaves[i].map(l => histograms[l.context + 1].code), p.data, p.w, p.h));
}
function codeLocal(w, target, plane, width, height) {
  const emit = (k, value, config = RESIDUAL_CONFIG, base = 0) => w ? writeHybrid(w, target[k], config, value, base) : countToken(config, value, target[k], base);
  const pending = new Int32Array(MIN_RUN_LENGTH + 1);
  let run = 0;
  const flush = () => {
    if (run >= MIN_RUN_LENGTH + 1) { emit(pending[0], 0); emit(pending[1], run - MIN_RUN_LENGTH - 1, RUN_CONFIG, MIN_RUN_SYMBOL); }
    else for (let i = 0; i < run; i++) emit(pending[i], 0);
    run = 0;
  };
  for (let y = 0, index = 0; y < height; y++) for (let x = 0; x < width; x++, index++) {
    const left = x ? plane[index - 1] : y ? plane[index - width] : 0, top = y ? plane[index - width] : left;
    const nw = x && y ? plane[index - width - 1] : left, grad = left + top - nw, lo = left < top ? left : top, hi = left < top ? top : left;
    const k = bucket(left - nw) * SIDE + bucket(nw - top), r = (plane[index] - (grad < lo ? lo : grad > hi ? hi : grad)) | 0;
    if (!r) { if (run <= MIN_RUN_LENGTH) pending[run] = k; run++; continue; }
    flush(); emit(k, r >= 0 ? r + r : -r - r - 1);
  }
  flush();
}
