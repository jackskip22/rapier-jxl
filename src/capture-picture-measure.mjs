// SPDX-License-Identifier: MIT
import {captureDomain} from './capture-domain.mjs';
import {admitSize, fault} from './admit.mjs';
import {EDGE} from './limits.mjs';
import {s2Dimensions, s2RGBA} from './ssimulacra2-input.mjs';
import {linearFromTransform} from './color-bytes.mjs';
import {P3_TRANSFORM} from './color-transform.mjs';

import {cpuMeasure} from './photo-measure.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {compileKernels} from './kernel-runtime.mjs';
import {djxlResidual} from './photo-browser-margin.mjs';
import {padPhotoCrop, photoRegionTarget} from './photo-region-score.mjs';
import {measuredLook} from './photo-quality-table.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
export const prepareCapturePictureMeasure = () => compileKernels();

export function capturePictureMeasure(source, {cacheBytes = 0, signal, maxPixels, crops = []} = {}) {
  check(signal); captureDomain(source);
  const {width, height, colorSpace = 'srgb'} = source;
  if (maxPixels !== undefined) {
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1)
      throw fault('JXL_INPUT', 'maxPixels: positive integer');
    admitSize(width, height, {pixels: maxPixels, edge: EDGE});
  }
  const pixels = s2Dimensions(width, height), native = colorSpace === 'srgb';
  let referencePixels = s2RGBA(source.data, pixels, true), closed = false;
  const linear = data => native ? linearFromRGBA(data, pixels)
    : linearFromTransform(data, pixels, P3_TRANSFORM);
  const measure = cpuMeasure(null, width, height, {
    reference: native ? {rgba: referencePixels} : linear(referencePixels), immutable: true, native, cacheBytes,
    reconstruct: image => linear(image.data),
    rgbaOutputs: native ? image => [{kind: 'native', rgba: image.data}] : null,
  });
  const cut = (rgba, r) => { const out = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) out.set(rgba.subarray(((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x + r.width) * 4), y * r.width * 4);
    return out; };
  const seen = new Set();
  const parts = crops.map(c => { const x = Math.max(0, c.x), y = Math.max(0, c.y); return {x, y, width: Math.min(width, c.x + c.width) - x, height: Math.min(height, c.y + c.height) - y, look: c.look}; })
    .filter(r => r.width >= 8 && r.height >= 8 && (r.width < width || r.height < height) && !seen.has(`${r.x},${r.y},${r.width},${r.height}`) && seen.add(`${r.x},${r.y},${r.width},${r.height}`))
    .map(r => {
      const pad = r.look !== undefined, lift = pad ? photoRegionTarget(r.look, Math.min(r.width, r.height), true) - measuredLook(r.look) : 0;
      const padded = rgba => pad ? padPhotoCrop(rgba, r.width, r.height) : {rgba, width: r.width, height: r.height};
      const ref = padded(cut(referencePixels, r)), reference = ref.rgba, n = s2Dimensions(ref.width, ref.height);
      return {r, lift, padded, measure: cpuMeasure(null, ref.width, ref.height, {reference: native ? {rgba: reference} : linearFromTransform(reference, n, P3_TRANSFORM),
        immutable: true, native, reconstruct: image => native ? linearFromRGBA(image.data, n) : linearFromTransform(image.data, n, P3_TRANSFORM),
        rgbaOutputs: native ? image => [{kind: 'native', rgba: image.data}] : null})}; });
  source = null;
  return {
    format: 'rgba-unorm8',
    domain: 'decoded-output',
    measure(picture, want) {
      if (closed) throw fault('JXL_INTERNAL', 'capture-picture-measure:closed');
      check(signal);
      if (picture.width !== width || picture.height !== height)
        throw fault('JXL_DIMENSIONS', 'decoded size mismatch');
      captureDomain(picture);
      if ((picture.colorSpace ?? 'srgb') !== colorSpace)
        throw fault('JXL_PLATFORM', 'readback: colorSpace mismatch');
      const data = s2RGBA(picture.data, pixels, true);
      for (let y = 0; y < height; y++) {
        check(signal);
        for (let at = y * width * 4 + 3, end = (y + 1) * width * 4; at < end; at += 4)
          if (referencePixels[at] !== data[at])
            throw fault('JXL_PLATFORM', 'readback: alpha mismatch');
      }
      let scores = measure({data}, want); check(signal);
      const nat = picture.native && native && Number.isFinite(scores?.ssimulacra2) ? s2RGBA(picture.native, pixels, true) : null;
      if (nat) {
        const djxl = measure({data: nat}, want); check(signal);
        const shown = djxl.ssimulacra2 - djxlResidual(djxl.ssimulacra2, width * height);
        if (shown < scores.ssimulacra2) scores = {...djxl, ssimulacra2: shown};
      }
      if (!parts.length || !want?.ssimulacra2 || typeof scores?.ssimulacra2 !== 'number') return scores;
      let least = scores.ssimulacra2;
      for (const part of parts) {
        const only = {ssimulacra2: true, butteraugli: false};
        let own = part.measure({data: part.padded(cut(data, part.r)).rgba}, only).ssimulacra2; check(signal);
        if (nat) {
          const read = part.measure({data: part.padded(cut(nat, part.r)).rgba}, only).ssimulacra2; check(signal);
          const shown = read - djxlResidual(read, part.r.width * part.r.height);
          if (shown < own) own = shown;
        }
        own -= part.lift;
        if (own < least) least = own;
      }
      return {...scores, ssimulacra2: least};
    },
    destroy() {
      if (closed) return;
      closed = true; referencePixels = null; measure.destroy();
      for (const part of parts) part.measure.destroy();
    },
  };
}
