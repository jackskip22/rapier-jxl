// SPDX-License-Identifier: MIT
import {photoAnimationMeasure} from '../photo-animation-measure.mjs';
import {preparePictureMeasure} from '../photo-picture-measure.mjs';
import {rebuildPicture, rebuildable} from '../photo-rebuild.mjs';
import {power} from '../color-transform.mjs';
import {check, fail} from './primitives.mjs';
import {measuredFileSearch} from './measured-search.mjs';
import {photoOutputMeasurements} from '../photo-output-policy.mjs';
import {exactFiles, quickFiles} from '../animation-frames.mjs';
import {LIBJXL_BOUND} from '../photo-whole-search.mjs';
import {displayedFrameIndices} from '../animation-timeline.mjs';

const FINAL_TRIES = 4;
const TOOL_GAP = [{pixels: 2.1e6, gaps: [0.68, 1.37, 1.37]}, {pixels: 8.3e6, gaps: [1.77, 3.4, 6.7]}];
const toolNeeded = (bound, pixels) => {
  const row = TOOL_GAP.find(r => pixels <= r.pixels);
  return meter => !row || meter - row.gaps[meter < 80 ? 0 : meter < 86 ? 1 : 2] < bound;
};

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

export function rebuildInSpace(picture, isP3) {
  if (!rebuildable(picture)) return null;
  const gamma = !!picture.ycbcr, {width, height} = picture;
  const made = rebuildPicture(picture, {rgba: !isP3 || gamma, linear: !gamma, gamma, xyb: !gamma && !isP3});
  return {width, height, kind: gamma ? 'gamma' : 'linear', planes: gamma ? made.gamma : made.linear,
    ...(made.xyb && {xyb: made.xyb}),
    rgba: isP3 && !gamma ? p3RGBA(picture, made.linear) : made.rgba};
}

export async function measuredAnimation(animation, target, encodeAt, {start = 90, probes = 8, signal, onProgress, maxPixels, preview, toolBound = LIBJXL_BOUND} = {}) {
  check(signal);
  await preparePictureMeasure(); check(signal);
  const metric = photoAnimationMeasure(animation, {signal, maxPixels});
  if (!metric) return null;
  const isP3 = animation.colorSpace === 'display-p3';
  const want = {ssimulacra2: target.ssimulacra2 !== undefined, butteraugli: false},
    bound = target.ssimulacra2 - toolBound, check2 = {...want, libjxl: toolNeeded(bound, animation.width * animation.height)};
  const probe = async (quality, progress) => {
    const watch = watched(metric, want, isP3);
    try {
      const bytes = await encodeAt(quality, progress, true, watch.prepare);
      check(signal);
      if (!(bytes instanceof Uint8Array)) throw fail('JXL_INTERNAL', "animation-search:output");
      return {quality, bytes, scores: watch.scores(bytes)};
    } finally { watch.destroy(); }
  };
  try {
    const selected = await measuredFileSearch(target, probe, metric.measure, {start, probes: Math.min(probes, 8), signal,
      onProgress: onProgress ? f => onProgress(f * 0.92) : undefined,
      exact: progress => encodeAt(100, progress), preview, width: animation.width, height: animation.height});
    if (!selected || selected.exact) return selected;
    const quick = quickFiles.has(selected.bytes);
    let toolShort = false, short = [];
    for (let step = 0; step < FINAL_TRIES; step++) {
      const qTry = Math.min(99.99, selected.quality + 1.2 * step), watch = watched(metric, check2, isP3);
      try {
        const fullBytes = await encodeAt(qTry, undefined, false, watch.prepare);
        check(signal);
        if (!(fullBytes instanceof Uint8Array)) continue;
        if (exactFiles.has(fullBytes)) return {bytes: fullBytes, quality: 100, exact: true, measurements: []};
        const scores = watch.scores(fullBytes);
        if (!scores || target.ssimulacra2 !== undefined && scores.ssimulacra2 < target.ssimulacra2) { if (step && !toolShort) break; continue; }
        if (target.ssimulacra2 !== undefined && !(scores.libjxl >= bound)) { toolShort = true; short = shortFrames(scores, bound); continue; }
        if (quick && !toolShort && fullBytes.length > selected.bytes.length) continue;
        return {...selected, quality: qTry, bytes: fullBytes, measurements: photoOutputMeasurements(target, scores, 'decoded-output')};
      } finally { watch.destroy(); }
      if (qTry >= 99.99) break;
    }
    if (!toolShort) return selected;
    const inputs = displayedFrameIndices(animation);
    const watch = watched(metric, check2, isP3);
    try {
      const top = await encodeAt(99.99, undefined, false, watch.prepare); check(signal);
      const scores = top instanceof Uint8Array ? watch.scores(top) : null;
      if (scores && scores.ssimulacra2 >= target.ssimulacra2 && scores.libjxl >= bound)
        return {...selected, quality: 99.99, bytes: top, measurements: photoOutputMeasurements(target, scores, 'decoded-output'),
          unproved: short.map(frame => ({frame: inputs[frame], done: 'raised'}))};
    } finally { watch.destroy(); }
    const bytes = await encodeAt(100); check(signal);
    return {bytes, quality: 100, exact: true, measurements: [], unproved: short.map(frame => ({frame: inputs[frame], done: 'exact file'}))};
  } finally { metric.destroy(); }
}

const shortFrames = (scores, bound) => [...new Set((scores.tool ?? []).filter(([, tool]) => !(tool >= bound)).map(([frame]) => frame))].sort((a, b) => a - b);

function watched(metric, want, isP3) {
  let result = null, observer = null;
  return {
    prepare: () => {
      result = null;
      observer = metric.observe(picture => rebuildInSpace(picture, isP3), {want, native: !isP3});
      const finish = observer.finish;
      observer.finish = bytes => { const completed = finish(bytes); if (completed) result = completed; return completed; };
      return observer;
    },
    scores: bytes => {
      const scores = result?.bytes === bytes ? result.scores : null;
      if (want.ssimulacra2 && scores && !Number.isFinite(scores.ssimulacra2)) throw fail('JXL_INPUT', 'score: finite number');
      return scores;
    },
    destroy: () => observer?.destroy(),
  };
}

export async function checkedFile(animation, target, encodeOnce, {signal, maxPixels} = {}) {
  check(signal);
  await preparePictureMeasure(); check(signal);
  const metric = photoAnimationMeasure(animation, {signal, maxPixels});
  if (!metric) return null;
  const watch = watched(metric, {ssimulacra2: true, butteraugli: false, libjxl: toolNeeded(target.ssimulacra2 - LIBJXL_BOUND, animation.width * animation.height)},
    animation.colorSpace === 'display-p3');
  try {
    const bytes = await encodeOnce(watch.prepare); check(signal);
    const scores = bytes instanceof Uint8Array ? watch.scores(bytes) : null;
    return scores && scores.ssimulacra2 >= target.ssimulacra2 && scores.libjxl >= target.ssimulacra2 - LIBJXL_BOUND
      ? {bytes, measurements: photoOutputMeasurements(target, scores, 'decoded-output')} : null;
  } finally { watch.destroy(); metric.destroy(); }
}
