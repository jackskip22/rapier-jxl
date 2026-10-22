// SPDX-License-Identifier: MIT
import {fault} from './admit.mjs';
import {channelPowers} from './planar-input.mjs';
import {leaf, channelTree, writeTree, writeChannelHistograms, codeChannel, ALPHABET} from './modular.mjs';
import {buildCode} from './prefix.mjs';
import {codeCustomWeighted} from './weighted-custom.mjs';

export function channelPiece(channel, x, y, size) {
  const horizontal = channelPowers[channel.hshift ?? channel.shift], vertical = channelPowers[channel.vshift ?? channel.shift];
  const left = Math.floor(x / horizontal), top = Math.floor(y / vertical);
  const width = Math.max(0, Math.min(channel.width - left, size / horizontal));
  const height = Math.max(0, Math.min(channel.height - top, size / vertical));
  return {channel, left, top, width, height};
}

function plane(piece) {
  const {channel, left, top, width, height} = piece, data = new Int32Array(width * height);
  for (let y = 0; y < height; y++) data.set(channel.data.subarray((top + y) * channel.width + left, (top + y) * channel.width + left + width), y * width);
  return data;
}

function selectedPredictor(data, width, height, forced) {
  if (forced >= 0) return forced;
  let selected = 0, cost = Infinity;
  for (const predictor of [0, 1, 2, 3, 5]) {
    const counts = new Uint32Array(ALPHABET), h = Math.min(height, Math.max(1, Math.floor(4096 / width)));
    codeChannel(null, counts, data, width, h, leaf(predictor));
    const code = buildCode(counts);
    let bits = 0; for (let s = 0; s < counts.length; s++) bits += counts[s] * (code.lengths[s] + Math.max(0, s < 224 ? s - 1 : s - 236));
    if (bits < cost) { cost = bits; selected = predictor; }
  }
  return selected;
}

export function writePlanarPlanes(writer, pieces, predictor, afterModel, weighted, maxTreeNodes = Infinity) {
  if (!pieces.length) return;
  if (2 * pieces.length - 1 > maxTreeNodes) throw fault('JXL_INPUT', 'The authored Modular channel tree exceeds its sample-dependent decoder limit.');
  const leaves = [], histograms = Array.from({length: Math.min(pieces.length, 254)}, () => new Uint32Array(ALPHABET));
  pieces.forEach((item, c) => {
    const data = plane(item), model = leaf(selectedPredictor(data, item.width, item.height, predictor)); leaves.push(model);
    if (weighted) codeCustomWeighted(null, histograms[Math.min(c, 253)], data, item.width, item.height, weighted);
    else codeChannel(null, histograms[Math.min(c, 253)], data, item.width, item.height, model);
  });
  const ordered = writeTree(writer, channelTree(leaves));
  const codes = writeChannelHistograms(writer, ordered, histograms, model => Math.min(leaves.indexOf(model), 253));
  if (afterModel) afterModel();
  pieces.forEach((item, c) => {
    if (weighted) codeCustomWeighted(writer, codes[Math.min(c, 253) + 1].code, plane(item), item.width, item.height, weighted);
    else codeChannel(writer, codes[Math.min(c, 253) + 1].code, plane(item), item.width, item.height, leaves[c]);
  });
}
