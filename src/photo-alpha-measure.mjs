// SPDX-License-Identifier: MIT
import {cpuMeasure} from './photo-measure.mjs';
import {bandedRGBA, bandedOutputs} from './photo-reconstruct-bands.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {linearFromTransform, codedBytesFromLinear} from './color-bytes.mjs';
import {materialize} from './varblock-core.mjs';
import {reconstruct} from './reconstruct.mjs';
import {nativeRGBA} from './photo-output.mjs';
import {wholeRebuildMeasure, selectedYCbCrRGBA, selectedYCbCrLinear} from './photo-whole-rebuild.mjs';
import {captureComposeOver} from './capture-kernels.mjs';
import {fault} from './fault.mjs';
import {offloading, offloadWorkers} from './offload.mjs';

const ROWS = 256, BACKGROUNDS = [255, 0];

function worse(a, b) {
  const out = {...a, ssimulacra2: Math.min(a.ssimulacra2, b.ssimulacra2)};
  if (a.nativeScores && b.nativeScores) {
    const low = key => Math.min(a.nativeScores[key], b.nativeScores[key]);
    out.nativeScores = {package: low('package'), native: low('native'), minimum: low('minimum')};
  }
  for (const key of ['cells', 'blocks']) if (a[key] && b[key]) out[key] = a[key].map((value, i) => Math.max(value, b[key][i]));
  return out;
}

export function alphaRebuildMeasure(data, width, height, color, signal, plan) {
  const n = width * height, check = () => { if (signal?.aborted) throw signal.reason; };
  const over = (rgba, background) => {
    if (!captureComposeOver(rgba, data, width, height, background)) throw fault('JXL_WASM', 'WebAssembly SIMD required');
    return rgba;
  };
  const nativeBand = (linear, from, count, out, at, y = at / width) => out.set(nativeRGBA(
    linear.map(p => p.subarray(from, from + count)), width, count / width, {y}), at * 4);
  const cacheBytes = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, width * height * 64));
  const transform = color?.transform;
  const rgbaOf = image => transform ? codedBytesFromLinear(image.ycbcr ? selectedYCbCrLinear(image, color, signal) : reconstruct(materialize(image)), n, transform)
    : image.ycbcr ? selectedYCbCrRGBA(image, color, signal) : bandedRGBA(image, ROWS);
  const linear = rgba => transform ? linearFromTransform(rgba, n, transform) : linearFromRGBA(rgba, n);
  let shared = null, zoneReader = null;
  const once = (image, key, make) => {
    if (shared?.image !== image) shared = {image};
    return shared[key] ??= make();
  };
  const rgbaOnce = image => once(image, 'rgba', () => rgbaOf(image));
  const outputsOnce = image => once(image, 'outputs', () => image.ycbcr
    ? {package: selectedYCbCrRGBA(image, color, signal), native: selectedYCbCrRGBA(image, color, signal, true)}
    : bandedOutputs(image, ROWS, nativeBand));
  const looks = BACKGROUNDS.map(background => cpuMeasure(over(new Uint8Array(data.subarray(0, n * 4)), background), width, height, {
    native: !transform, immutable: true, cacheBytes,
    ...(transform && {reference: () => linear(over(new Uint8Array(data.subarray(0, n * 4)), background))}),
    reconstruct: image => linear(over(rgbaOnce(image).slice(), background)),
    bandedRGBA: image => over(rgbaOnce(image).slice(), background),
    *rgbaOutputs(image) {
      check();
      const outputs = outputsOnce(image);
      yield {kind: 'package', rgba: over(outputs.package.slice(), background)};
      yield {kind: 'native', rgba: over(outputs.native.slice(), background)};
    },
  }));
  const measure = (image, want = {}) => {
    const asked = {...want, butteraugli: false}, banded = !transform && (plan?.banded || image.coefficientRows || image.ycbcr);
    try { return worse(...looks.map(look => banded ? look.banded(image, asked) : look(image, asked))); }
    finally { shared = null; }
  };
  return {
    measure,
    *measureSteps(image, want) { return measure(image, want); },
    *zoneSteps(image) {
      if (transform || !offloading('score-band') || offloadWorkers() < 2) return null;
      zoneReader ??= wholeRebuildMeasure(data, width, height, color, signal, plan);
      return yield* zoneReader.zoneSteps(image);
    },
    destroy() { shared = null; zoneReader?.destroy(); for (const look of looks) look.destroy(); },
  };
}
