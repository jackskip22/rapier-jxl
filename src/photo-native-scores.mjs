// SPDX-License-Identifier: MIT
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {toRGBA} from './rgb8-output.mjs';
import {gammaRGBA, nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {s2Dimensions, s2Planes, s2RGBA} from './ssimulacra2-input.mjs';
import {fault} from './fault.mjs';

const dimensions = s2Dimensions;

export function nativeOutputScores(outputs, source, width, height, {reference = null, cacheBytes = 0} = {}) {
  dimensions(width, height);
  const prepared = reference ?? ssimulacra2Reference(source, width, height, {immutable: true, cacheBytes});
  const scores = {package: null, native: null, minimum: Infinity};
  let count = 0;
  try {
  for (const output of outputs) {
    let rgba = ArrayBuffer.isView(output) ? output : output?.rgba;
    const kind = ArrayBuffer.isView(output) ? null : output?.kind ?? null;
    if (kind !== null && kind !== 'package' && kind !== 'native') throw fault('JXL_INPUT', 'Unknown photographic output kind.');
    try { rgba = s2RGBA(rgba, width * height, true); }
    catch { throw fault('JXL_INPUT', 'A photographic score needs one complete RGB8 output.'); }
    if (kind !== null && scores[kind] !== null) throw fault('JXL_INPUT', 'A photographic output kind was supplied twice.');
    const score = ssimulacra2(prepared, {rgba}, width, height).score;
    if (kind !== null) scores[kind] = score;
    scores.minimum = Math.min(scores.minimum, score); count++;
  }
  } finally { if (!reference) prepared.release(); }
  if (!count) throw fault('JXL_INPUT', 'A native photo measure needs an output representation.');
  return scores;
}

function* reconstructedOutputs(picture, width, height, origin) {
  if (picture.linear) {
    const linear = s2Planes(picture.linear, width * height);
    yield {kind: 'package', rgba: toRGBA(linear, width, height)};
    yield {kind: 'native', rgba: nativeRGBA(linear, width, height, origin)};
  } else {
    const gamma = s2Planes(picture.gamma, width * height);
    yield {kind: 'package', rgba: gammaRGBA(gamma, width, height)};
    yield {kind: 'native', rgba: nativeGammaRGBA(gamma, width, height, origin)};
  }
}

export function photoNativeScores(picture, source, width, height, {origin = {x: 0, y: 0}, reference = null, cacheBytes = 0} = {}) {
  dimensions(width, height);
  if (!picture || ['linear', 'gamma', 'outputs'].filter(key => picture[key] !== undefined).length !== 1)
    throw fault('JXL_INPUT', 'A photographic score needs one explicit reconstruction domain or output provider.');
  const outputs = picture.outputs === undefined ? reconstructedOutputs(picture, width, height, origin)
    : typeof picture.outputs === 'function' ? picture.outputs() : picture.outputs;
  const scores = nativeOutputScores(outputs, source, width, height, {reference, cacheBytes});
  if (!Number.isFinite(scores.package) || !Number.isFinite(scores.native))
    throw fault('JXL_INPUT', 'A photographic score needs both named package and native outputs.');
  return scores;
}
