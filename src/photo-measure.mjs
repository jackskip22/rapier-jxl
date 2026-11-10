// SPDX-License-Identifier: MIT
import {smallPicture} from './photo-v6-settings.mjs';
import {blockDistances, cellSums} from './photo-distance-cells.mjs';
import {toRGBA} from './rgb8-output.mjs';
import {butteraugli, butteraugliReference} from './butteraugli.mjs';
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {nativeOutputScores} from './photo-native-scores.mjs';
import {s2Dimensions, s2Samples, s2Planes} from './ssimulacra2-input.mjs';
import {s2CellSums, s2CellMap} from './s2-cells.mjs';


export function cpuMeasure(rgba, width, height, {reconstruct, bandedRGBA, rgbaOutputs = null, streamedScores = null, native = false, reference = null, cacheBytes = 0, immutable = false, distanceDetails = true, maps = 'butteraugli'}) {
  const s2Maps = maps === 's2' || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true);
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
  let currentReference = null, rgbaReference = null, ba = null, destroyed = false, busy = false;
  const rawReference = () => {
    if (currentReference === null) {
      const raw = typeof reference === 'function' ? reference() : reference ?? photo;
      s2Samples(raw, n); currentReference = raw; rgbaReference ??= !!raw.rgba;
    }
    return currentReference;
  };
  let s2 = ssimulacra2Reference(rawReference, width, height, {cacheBytes, immutable: true});
  const maskCacheBytes = cacheBytes - s2.reservedBytes;
  let cellRef = null;
  const cellReference = () => {
    if (cellRef) return cellRef;
    const raw = rawReference();
    return cellRef = raw.rgba ? (raw === photo ? photo : {rgba: raw.rgba}) : {rgba: toRGBA(raw, width, height)};
  };
  const cellMaps = (out, rgba) => {
    const {cells} = s2CellMap(s2CellSums(cellReference(), {rgba}, width, height), width, height);
    out.cells = cells; out.blocks = cells.slice();
  };
  const wants = want => {
    const wantMaps = s2Maps && (want.p !== undefined || want.margin !== undefined);
    const wantBa = s2Maps ? want.butteraugli === true : want.butteraugli ?? true;
    if (wantBa && (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) throw new Error('This measurer has no Butteraugli.');
    return {wantMaps, wantBa};
  };
  const outputScore = (out, outputs) => {
    const scores = nativeOutputScores(outputs, null, width, height, {reference: s2});
    out.ssimulacra2 = scores.minimum;
    if (scores.package !== null && scores.native !== null) out.nativeScores = scores;
  };
  const measure = (image, want = {}) => {
    const {p = 3, margin = 2, ssimulacra2: wantS2 = false} = want, {wantMaps, wantBa} = wants(want);
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    let lin = null;
    try {
      const lazyOutput = native && rgbaOutputs && wantS2 && !wantBa && !wantMaps;
      if (!lazyOutput) lin = s2Planes(reconstruct(image, {banded: false}), n);
      const out = {};
      if (wantMaps) cellMaps(out, toRGBA(lin, width, height));
      if (wantBa && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) {
        let r = butteraugli(ba ??= butteraugliReference(rawReference(), width, height, {cacheBytes: maskCacheBytes}), lin);
        Object.assign(out, {butteraugli: r.score, butteraugli3: r.pnorm3,
          ...(distanceDetails && {cells: cellSums(r.map, width, height, p), blocks: blockDistances({map: r.map, width, height}, margin)})});
        r = null;
      }
      if (wantS2) {
        if (native) {
          const output = lazyOutput ? {banded: false, get linear() { return lin ??= s2Planes(reconstruct(image, {banded: false}), n); }}
            : {linear: lin, banded: false};
          const outputs = rgbaOutputs ? rgbaOutputs(image, output) : [toRGBA(lin, width, height)];
          if (!lazyOutput) lin = null;
          outputScore(out, outputs);
        }
        else {
          const rounded = smallPicture(width, height) && (rgbaReference ?? !!rawReference().rgba);
          out.ssimulacra2 = ssimulacra2(s2, rounded ? {rgba: toRGBA(lin, width, height)} : lin, width, height).score;
        }
      }
      return out;
    } finally {
      lin = null; currentReference = null; busy = false;
    }
  };
  measure.banded = (image, want = {}, measureBa) => {
    const {ssimulacra2: wantS2 = false} = want, {wantMaps, wantBa} = wants(want);
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    let lin = null;
    try {
      const out = {};
      const streamed = wantS2 && native ? streamedScores?.(image) ?? null : null;
      if (streamed) { out.ssimulacra2 = streamed.minimum; out.nativeScores = streamed; }
      else if (wantS2 && native) outputScore(out, rgbaOutputs ? rgbaOutputs(image, {banded: true}) : [bandedRGBA(image)]);
      else if (wantS2) { lin = s2Planes(reconstruct(image, {banded: true}), n); out.ssimulacra2 = ssimulacra2(s2, lin, width, height).score; }
      lin = null;
      if (wantMaps) cellMaps(out, bandedRGBA(image));
      if (wantBa && !(typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) Object.assign(out, measureBa(rawReference(), image, want));
      return out;
    } finally {
      lin = null; currentReference = null; busy = false;
    }
  };
  measure.withReference = consume => {
    if (destroyed) throw new Error('CPU measurer is destroyed.');
    if (busy) throw new Error('CPU measurer is already in use.');
    busy = true;
    try { return consume(rawReference()); }
    finally { currentReference = null; busy = false; }
  };
  Object.defineProperties(measure, {
    cacheBytes: {get: () => (s2?.cacheBytes ?? 0) + (ba?.cacheBytes ?? 0)},
    cacheAllowanceBytes: {value: cacheBytes},
    referenceBytes: {get: () => ba?.referenceBytes ?? 0},
    inputBytes: {get: () => inputBytes},
  });
  measure.destroy = () => {
    if (busy) throw new Error('CPU measurer is already in use.');
    s2?.release();
    destroyed = true; cellRef = null; photo = null; inputBytes = 0; reference = null; currentReference = null; s2 = null; ba = null;
    reconstruct = null; bandedRGBA = null; rgbaOutputs = null; streamedScores = null;
  };
  return measure;
}
