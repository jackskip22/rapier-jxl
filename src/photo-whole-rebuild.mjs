// SPDX-License-Identifier: MIT
import {cpuMeasure} from './photo-measure.mjs';
import {materialize} from './varblock-core.mjs';
import {reconstruct, reconstructYCbCr, toRGBA} from './reconstruct.mjs';
import {bandedRGBA, bandedOutputs, exactScores, subImage} from './photo-reconstruct-bands.mjs';
import {rebuildable} from './photo-rebuild.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const ROWS = 256;

function selectedYCbCrRGBA(image, color, signal, native = false) {
  if (!native && !color.transform && rebuildable(image)) return bandedRGBA(image, ROWS);
  const {width, height} = image, stride = image.components[0].stride, rows = image.components[0].rows;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += ROWS) {
    check(signal);
    const sub = subImage(image, 0, y / 8, stride, Math.min(rows, (y + ROWS) / 8));
    const gamma = color.transform || native ? reconstructYCbCr(sub, {planes: true}) : null;
    const rgba = color.transform ? (native ? nativeRGBA : toRGBA)(linearFromTransformPlanes(gamma,
      sub.width * sub.height, color.transform), sub.width, sub.height, {y})
      : native ? nativeGammaRGBA(gamma, sub.width, sub.height, {y}) : reconstructYCbCr(sub);
    out.set(rgba, y * width * 4);
  }
  return out;
}

export function wholeRebuildMeasure(data, width, height, color, signal, plan) {
  const reference = color.transform ? () => photoReference(data, width, height, color.transform) : null;
  const nativeBand = (linear, from, count, out, at) => out.set(nativeRGBA(
    linear.map(p => p.subarray(from, from + count)), width, count / width, {y: at / width}), at * 4);
  const cacheBytes = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, width * height * 64));
  let cpu = null;
  const reconstruction = () => cpu ??= cpuMeasure(data, width, height, {native: true, immutable: true, reference, cacheBytes,
    reconstruct: image => image.ycbcr ? linearFromRGBA(selectedYCbCrRGBA(image, color, signal), width * height)
      : reconstruct(materialize(image)),
    bandedRGBA: image => image.ycbcr ? selectedYCbCrRGBA(image, color, signal) : bandedRGBA(image, ROWS),
    *rgbaOutputs(image, {linear, banded}) {
      if (image.ycbcr) {
        yield {kind: 'package', rgba: selectedYCbCrRGBA(image, color, signal)};
        yield {kind: 'native', rgba: selectedYCbCrRGBA(image, color, signal, true)};
      } else if (banded) {
        const outputs = bandedOutputs(image, ROWS, nativeBand);
        yield {kind: 'package', rgba: outputs.package};
        yield {kind: 'native', rgba: outputs.native};
      } else {
        yield {kind: 'package', rgba: toRGBA(linear, width, height)};
        yield {kind: 'native', rgba: nativeRGBA(linear, width, height)};
      }
    },
  });
  return {
    measure: (image, want) => image.coefficientRows || image.ycbcr ? reconstruction().banded(image, {...want, butteraugli: false})
      : exactScores(reconstruction(), null, width, height, image, want, plan),
    destroy() { cpu?.destroy(); cpu = null; },
  };
}
