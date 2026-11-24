// SPDX-License-Identifier: MIT
import {ssimulacra2Score, ssimulacra2Pair, ssimulacra2Reference} from './ssimulacra2.mjs';
import {captureLinearRGBA as toRGBA} from './capture-kernels.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {colorPixels} from './color-band.mjs';
import {s2Dimensions, s2Planes, s2RGBA} from './ssimulacra2-input.mjs';
import {fault} from './fault.mjs';

const dimensions = s2Dimensions;

export function nativeOutputScores(outputs, source, width, height, {reference = null, cacheBytes = 0, arithmetic, minScore} = {}) {
  dimensions(width, height);
  const prepared = reference ?? ssimulacra2Reference(source, width, height, {immutable: true, cacheBytes, arithmetic});
  const scores = {package: null, native: null, minimum: Infinity};
  let count = 0;
  try {
    if (Array.isArray(outputs) && outputs.length === 2) {
      const items = outputs.map(output => {
        let rgba = ArrayBuffer.isView(output) ? output : output?.rgba;
        const kind = ArrayBuffer.isView(output) ? null : output?.kind ?? null;
        if (kind !== null && kind !== 'package' && kind !== 'native') throw fault('JXL_INPUT', 'kind: package or native');
        try { rgba = s2RGBA(rgba, width * height, true); }
        catch { throw fault('JXL_INPUT', 'output: complete RGB8'); }
        return {kind, rgba};
      });
      if (items[0].kind !== null && items[0].kind === items[1].kind) throw fault('JXL_INPUT', 'duplicate output kind');
      const pair = ssimulacra2Pair(prepared, {rgba: items[0].rgba}, {rgba: items[1].rgba}, width, height, {arithmetic, minScore});
      for (let i = 0; i < 2; i++) {
        const score = pair[i].score;
        if (items[i].kind !== null) scores[items[i].kind] = score;
        scores.minimum = Math.min(scores.minimum, score); count++;
      }
    } else for (const output of outputs) {
      let rgba = ArrayBuffer.isView(output) ? output : output?.rgba;
      const kind = ArrayBuffer.isView(output) ? null : output?.kind ?? null;
      if (kind !== null && kind !== 'package' && kind !== 'native') throw fault('JXL_INPUT', 'kind: package or native');
      try { rgba = s2RGBA(rgba, width * height, true); }
      catch { throw fault('JXL_INPUT', 'output: complete RGB8'); }
      if (kind !== null && scores[kind] !== null) throw fault('JXL_INPUT', 'duplicate output kind');
      const score = ssimulacra2Score(prepared, {rgba}, width, height, arithmetic, minScore !== undefined ? {minScore} : null).score;
      if (kind !== null) scores[kind] = score;
      scores.minimum = Math.min(scores.minimum, score); count++;
    }
  } finally { if (!reference) prepared.release(); }
  if (!count) throw fault('JXL_INPUT', 'outputs: empty');
  return scores;
}

function reconstructedOutputs(picture, width, height, origin) {
  if (picture.linear) {
    const linear = s2Planes(picture.linear, width * height);
    return [{kind: 'package', rgba: toRGBA(linear, width, height)}, {kind: 'native', rgba: nativeRGBA(linear, width, height, origin)}];
  }
  const gamma = s2Planes(picture.gamma, width * height);
  return [{kind: 'package', rgba: colorPixels(gamma, width, height, width, 0)}, {kind: 'native', rgba: nativeGammaRGBA(gamma, width, height, origin)}];
}

export function photoNativeScores(picture, source, width, height, {origin = {x: 0, y: 0}, reference = null, cacheBytes = 0} = {}) {
  dimensions(width, height);
  if (!picture || ['linear', 'gamma', 'outputs'].filter(key => picture[key] !== undefined).length !== 1)
    throw fault('JXL_INPUT', 'picture: needs domain or outputs');
  const outputs = picture.outputs === undefined ? reconstructedOutputs(picture, width, height, origin)
    : typeof picture.outputs === 'function' ? picture.outputs() : picture.outputs;
  const scores = nativeOutputScores(outputs, source, width, height, {reference, cacheBytes});
  if (!Number.isFinite(scores.package) || !Number.isFinite(scores.native))
    throw fault('JXL_INPUT', 'outputs: needs package and native');
  return scores;
}
