// SPDX-License-Identifier: MIT
import {smallPicture} from './photo-v6-settings.mjs';
import {captureLinearRGBA} from './capture-kernels.mjs';
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {nativeOutputScores} from './photo-native-scores.mjs';
import {s2Dimensions, s2Samples, s2Planes} from './ssimulacra2-input.mjs';
import {s2CellSums, s2CellMap} from './s2-cells.mjs';
import {fault} from './fault.mjs';


export function cpuMeasure(rgba, width, height, {reconstruct, bandedRGBA, rgbaOutputs = null, streamedScores = null, native = false, reference = null, cacheBytes = 0, immutable = false}) {
  const n = s2Dimensions(width, height);
  let photo = null, inputBytes = 0, supplied = typeof reference === 'function' ? null : reference ?? {rgba};
  if (supplied) {
    const admitted = s2Samples(supplied, n);
    if (immutable) photo = supplied;
    else if (admitted.rgba) {
      photo = {rgba: new Uint8Array(admitted.rgba)};
      inputBytes = photo.rgba.byteLength;
    } else {
      photo = admitted.map(plane => Float64Array.from(plane));
      inputBytes = photo.reduce((sum, plane) => sum + plane.byteLength, 0);
    }
  }
  supplied = null; rgba = null;
  if (typeof reference !== 'function') reference = null;
  let currentReference = null, rgbaReference = null, destroyed = false, busy = false;
  const rawReference = () => {
    if (currentReference === null) {
      const raw = typeof reference === 'function' ? reference() : reference ?? photo;
      s2Samples(raw, n); currentReference = raw; rgbaReference ??= !!raw.rgba;
    }
    return currentReference;
  };
  let s2 = ssimulacra2Reference(rawReference, width, height, {cacheBytes, immutable: true});
  let s2libjxl = null;
  const s2Of = want => {
    const arithmetic = want.arithmetic ?? 'binary64';
    if (arithmetic === 'binary64') return s2;
    if (arithmetic !== 'libjxl') throw new Error('arithmetic: binary64 or libjxl');
    return s2libjxl ??= ssimulacra2Reference(rawReference, width, height, {cacheBytes: 0, immutable: true, arithmetic});
  };
  let cellRef = null;
  const cellReference = () => {
    if (cellRef) return cellRef;
    const raw = rawReference();
    return cellRef = raw.rgba ? (raw === photo ? photo : {rgba: raw.rgba}) : {rgba: captureLinearRGBA(raw, width, height)};
  };
  const cellMaps = (out, rgba) => {
    const {cells} = s2CellMap(s2CellSums(cellReference(), {rgba}, width, height), width, height);
    out.cells = cells; out.blocks = cells.slice();
  };
  const wants = want => {
    const wantMaps = want.p !== undefined || want.margin !== undefined;
    if (want.butteraugli === true) throw fault('JXL_INTERNAL', 'photo-measure:butteraugli');
    return {wantMaps};
  };
  const bounded = (want, score) => want.minScore !== undefined && !(score >= want.minScore);
  const outputScore = (out, outputs, reference = s2, want = {}) => {
    const scores = nativeOutputScores(outputs, null, width, height, {reference, minScore: want.minScore});
    out.ssimulacra2 = scores.minimum;
    if (scores.package !== null && scores.native !== null && !bounded(want, scores.minimum)) out.nativeScores = scores;
  };
  const measure = (image, want = {}) => {
    const {ssimulacra2: wantS2 = false} = want, {wantMaps} = wants(want);
    if (destroyed) throw fault('JXL_INTERNAL', 'photo-measure:destroyed-1');
    if (busy) throw fault('JXL_INTERNAL', 'photo-measure:busy-1');
    busy = true;
    let lin = null;
    try {
      const lazyOutput = native && rgbaOutputs && wantS2 && !wantMaps;
      if (!lazyOutput) lin = s2Planes(reconstruct(image, {banded: false}), n);
      const out = {};
      if (wantMaps) cellMaps(out, captureLinearRGBA(lin, width, height));
      if (wantS2) {
        if (native) {
          const output = lazyOutput ? {banded: false, get linear() { return lin ??= s2Planes(reconstruct(image, {banded: false}), n); }}
            : {linear: lin, banded: false};
          const outputs = rgbaOutputs ? rgbaOutputs(image, output) : [captureLinearRGBA(lin, width, height)];
          if (!lazyOutput) lin = null;
          outputScore(out, outputs, s2Of(want), want);
        }
        else {
          const rounded = smallPicture(width, height) && (rgbaReference ?? !!rawReference().rgba);
          out.ssimulacra2 = ssimulacra2(s2Of(want), rounded ? {rgba: captureLinearRGBA(lin, width, height)} : lin, width, height).score;
        }
      }
      return out;
    } finally {
      lin = null; currentReference = null; busy = false;
    }
  };
  measure.banded = (image, want = {}) => {
    const {ssimulacra2: wantS2 = false} = want, {wantMaps} = wants(want);
    if (destroyed) throw fault('JXL_INTERNAL', 'photo-measure:destroyed-2');
    if (busy) throw fault('JXL_INTERNAL', 'photo-measure:busy-2');
    busy = true;
    let lin = null;
    try {
      const out = {};
      const streamed = wantS2 && native && (want.arithmetic ?? 'binary64') === 'binary64' ? streamedScores?.(image, want) ?? null : null;
      if (streamed) { out.ssimulacra2 = streamed.minimum; if (!bounded(want, streamed.minimum)) out.nativeScores = streamed; }
      else if (wantS2 && native) outputScore(out, rgbaOutputs ? rgbaOutputs(image, {banded: true}) : [bandedRGBA(image)], s2Of(want), want);
      else if (wantS2) { lin = s2Planes(reconstruct(image, {banded: true}), n); out.ssimulacra2 = ssimulacra2(s2Of(want), lin, width, height).score; }
      lin = null;
      if (wantMaps) cellMaps(out, bandedRGBA(image));
      return out;
    } finally {
      lin = null; currentReference = null; busy = false;
    }
  };
  measure.withReference = consume => {
    if (destroyed) throw fault('JXL_INTERNAL', 'photo-measure:destroyed-3');
    if (busy) throw fault('JXL_INTERNAL', 'photo-measure:busy-3');
    busy = true;
    try { return consume(rawReference()); }
    finally { currentReference = null; busy = false; }
  };
  Object.defineProperties(measure, {
    cacheBytes: {get: () => (s2?.cacheBytes ?? 0) + (s2libjxl?.cacheBytes ?? 0)},
    cacheAllowanceBytes: {value: cacheBytes},
    referenceBytes: {value: 0},
    inputBytes: {get: () => inputBytes},
  });
  measure.destroy = () => {
    if (busy) throw fault('JXL_INTERNAL', 'photo-measure:busy-4');
    s2?.release(); s2libjxl?.release(); s2libjxl = null;
    destroyed = true; cellRef = null; photo = null; inputBytes = 0; reference = null; currentReference = null; s2 = null;
    reconstruct = null; bandedRGBA = null; rgbaOutputs = null; streamedScores = null;
  };
  return measure;
}
