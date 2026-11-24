// SPDX-License-Identifier: MIT
import {declined} from './kernel-hooks.mjs';
import {BitWriter} from './bits.mjs';
import {countToken, writeHybrid} from './prefix.mjs';
import {MIN_RUN_SYMBOL, MIN_RUN_LENGTH, RUN_CONFIG, RESIDUAL_CONFIG, GRADIENT_PREDICTOR, ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms} from './modular.mjs';
import {captureChannelCode} from './capture-kernels.mjs';

const CHANNEL_CONFIGS = {residual: RESIDUAL_CONFIG, run: RUN_CONFIG, minSymbol: MIN_RUN_SYMBOL, minLength: MIN_RUN_LENGTH};


export function codeChannel(w, target, plane, width, height, leaf, raw = false, residuals, beginY = 0) {
  if (!width || !height) return;

  if (!captureChannelCode(w, target, plane, width, height, leaf, raw, residuals, beginY, CHANNEL_CONFIGS)) throw declined('channel');
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

