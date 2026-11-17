// SPDX-License-Identifier: MIT
import {photoAnimationMeasure} from '../photo-animation-measure.mjs';
import {preparePictureMeasure} from '../photo-picture-measure.mjs';
import {rebuildPicture, rebuildable} from '../photo-rebuild.mjs';
import {power} from '../color-transform.mjs';
import {check, fail} from './primitives.mjs';
import {measuredFileSearch} from './measured-search.mjs';
import {photoOutputMeasurements} from '../photo-output-policy.mjs';
import {exactFiles, quickFiles} from '../animation-frames.mjs';

const SRGB_TO_P3 = [0.8224619687, 0.1775380313, 0, 0.0331941988, 0.9668058012, 0, 0.0170826307, 0.0723974407, 0.9105199286];
const oetfByte = v => {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * power(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
};

function p3RGBA(picture, linear) {
  const n = picture.width * picture.height, out = new Uint8Array(n * 4);
  const [R, G, B] = linear;
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    out[i * 4] = oetfByte(SRGB_TO_P3[0] * r + SRGB_TO_P3[1] * g + SRGB_TO_P3[2] * b);
    out[i * 4 + 1] = oetfByte(SRGB_TO_P3[3] * r + SRGB_TO_P3[4] * g + SRGB_TO_P3[5] * b);
    out[i * 4 + 2] = oetfByte(SRGB_TO_P3[6] * r + SRGB_TO_P3[7] * g + SRGB_TO_P3[8] * b);
    out[i * 4 + 3] = picture.alpha ? picture.alpha[i * 4 + 3] : 255;
  }
  return out;
}

function rebuildInSpace(picture, isP3) {
  if (!rebuildable(picture)) return null;
  const gamma = !!picture.ycbcr, {width, height} = picture;
  const made = rebuildPicture(picture, {rgba: !isP3 || gamma, linear: !gamma, gamma});
  return {width, height, kind: gamma ? 'gamma' : 'linear', planes: gamma ? made.gamma : made.linear,
    rgba: isP3 && !gamma ? p3RGBA(picture, made.linear) : made.rgba};
}

export async function measuredAnimation(animation, target, encodeAt, {start = 90, probes = 8, signal, onProgress, maxPixels, preview} = {}) {
  check(signal);
  await preparePictureMeasure(); check(signal);
  const metric = photoAnimationMeasure(animation, {signal, maxPixels});
  if (!metric) return null;
  const isP3 = animation.colorSpace === 'display-p3';
  const want = {ssimulacra2: target.ssimulacra2 !== undefined, butteraugli: false};
  const probe = async (quality, progress) => {
    let result = null, observer = null;
    const prepare = () => {
      result = null;
      observer = metric.observe(picture => rebuildInSpace(picture, isP3), {want, native: !isP3});
      const finish = observer.finish;
      observer.finish = bytes => {
        const completed = finish(bytes);
        if (completed) result = completed;
        return completed;
      };
      return observer;
    };
    try {
      const bytes = await encodeAt(quality, progress, true, prepare);
      check(signal);
      if (!(bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', "animation-search:output");
      return {quality, bytes, scores: result?.bytes === bytes ? result.scores : null};
    } finally { observer?.destroy(); }
  };
  try {
    const selected = await measuredFileSearch(target, probe, metric.measure, {start, probes: Math.min(probes, 8), signal,
      onProgress: onProgress ? f => onProgress(f * 0.92) : undefined,
      exact: progress => encodeAt(100, progress), preview, width: animation.width, height: animation.height});
    if (!selected || selected.exact || !quickFiles.has(selected.bytes)) return selected;
    let finalResult = null, finalObs = null;
    const prepFinal = () => {
      finalResult = null;
      finalObs = metric.observe(picture => rebuildInSpace(picture, isP3), {want, native: !isP3});
      const fin = finalObs.finish;
      finalObs.finish = b => { const c = fin(b); if (c) finalResult = c; return c; };
      return finalObs;
    };
    for (const qTry of [selected.quality, Math.min(99.99, selected.quality + 1.2)]) {
      try {
        const fullBytes = await encodeAt(qTry, undefined, false, prepFinal);
        check(signal);
        if (fullBytes instanceof Uint8Array && fullBytes.length <= selected.bytes.length) {
          if (exactFiles.has(fullBytes)) return {bytes: fullBytes, quality: 100, exact: true, measurements: []};
          if (finalResult?.bytes === fullBytes && (target.ssimulacra2 === undefined || finalResult.scores.ssimulacra2 >= target.ssimulacra2))
            return {...selected, quality: qTry, bytes: fullBytes, measurements: photoOutputMeasurements(target, finalResult.scores, 'decoded-output')};
        }
      } finally { finalObs?.destroy(); }
    }
    return selected;
  } finally { metric.destroy(); }
}
