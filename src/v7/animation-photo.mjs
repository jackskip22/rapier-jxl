// SPDX-License-Identifier: MIT
import {admitAnimation, ANIMATION_OBSERVER, ANIMATION_FORM, ANIMATION_DIFFS, ANIMATION_FLOOR, ANIMATION_PLAIN, exactFiles, unprovedFrames, additiveFiles, additiveBytes} from '../animation-frames.mjs';
import {WINDOW_BYTES} from './frame-source.mjs';
import {displayedAnimationFrames} from '../animation-timeline.mjs';
import {ordinaryStillReader} from './ordinary-still-policy.mjs';
import {described} from './describe.mjs';
import {check} from './primitives.mjs';
import {measuredAnimation, checkedFile, rebuildInSpace} from './animation-search.mjs';
import {pictureMeasure} from '../photo-picture-measure.mjs';
import {nativeRGBA, nativeGammaRGBA} from '../photo-output.mjs';
import {askedLook} from '../photo-quality-table.mjs';
import {measuredTarget, djxlResidual} from '../photo-browser-margin.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';

const LADDER = 3;
import {pagePicture, pageWithoutPhotograph} from './page-route.mjs';
import {screenPhotoRegions} from '../screen-photo-regions.mjs';
import {unchangedShare} from '../animation-diff.mjs';

const SCENE_KEPT = 0.5;
function pageScene(frames, {width, height, colorSpace}, codec) {
  const settings = {...codec, quality: Math.min(codec.quality, 99), colorSpace};
  return frames.some(({data}, k) => (k === 0 || unchangedShare(frames[k - 1].data, data, width, [0, 0, width, height]) < SCENE_KEPT &&
    pageWithoutPhotograph(data, width, height)) && pagePicture(data, width, height, settings) && !screenPhotoRegions(data, width, height).length);
}

export async function animationPhoto(animation, settings, encodeAt, {signal, maxPixels, onProgress, preview} = {}) {
  const {qualityIntent, ...codec} = settings;
  const diffs = new WeakMap();
  if (!codec[ANIMATION_PLAIN] && codec.effort >= 8 && codec.quality < 100) {
    const planes = additiveBytes(animation.width, animation.height);
    if (planes > WINDOW_BYTES / 2 || animation.frames.length * animation.width * animation.height * 4 + planes > WINDOW_BYTES) codec[ANIMATION_PLAIN] = true;
  }
  const encode = (quality, progress = onProgress, probe = false, prepare, keep, plain = false, effort = codec.effort) => encodeAt({...codec, effort, quality, [ANIMATION_DIFFS]: diffs,
    ...(probe && {probe}), ...(prepare && {[ANIMATION_OBSERVER]: prepare}), ...(keep && {[ANIMATION_FLOOR]: keep}), ...(plain && {[ANIMATION_PLAIN]: true})}, progress);
  const fixed = async (quality, keep) => {
    const bytes = await encode(quality, onProgress, false, undefined, keep); check(signal);
    return {bytes, quality, exact: quality === 100 || exactFiles.has(bytes), measurements: [],
      ...(unprovedFrames.has(bytes) && {unproved: unprovedFrames.get(bytes)})};
  };
  check(signal);
  if (qualityIntent === undefined) return fixed(codec.quality);
  admitAnimation(animation, codec);
  if (codec[ANIMATION_FORM]?.page !== false && pageScene(displayedAnimationFrames(animation), animation, codec)) return fixed(100);
  const look = measuredTarget(askedLook(qualityIntent)), target = look + djxlResidual(look, animation.width * animation.height);
  const keep = frameFloor(animation, target, {signal, maxPixels});
  if (codec.effort >= MEASURED_EFFORT && animation.width >= 8 && animation.height >= 8) {
    const search = coder => measuredAnimation(animation, {ssimulacra2: target}, coder, {start: codec.quality, signal, onProgress, maxPixels, preview});
    let answer = await search(encode);
    if (answer && additiveFiles.has(answer.bytes)) {
      const plain = await search((quality, progress, probe, prepare) => encode(quality, progress, probe, prepare, undefined, true));
      if (plain && plain.bytes.length < answer.bytes.length) answer = plain;
    }
    if (answer && codec.effort >= 8) {
      const seven = await search((quality, progress, probe, prepare) => encode(quality, progress, probe, prepare, undefined, false, 7));
      if (seven && seven.bytes.length <= answer.bytes.length) answer = seven;
    }
    if (answer) {
      if (answer.exact) return answer;
      const ladder = {...codec, effort: LADDER, quality: await predicted({...settings, effort: LADDER}), [ANIMATION_FLOOR]: keep};
      const lower = await encodeAt(ladder); check(signal);
      if (!(lower instanceof Uint8Array) || lower.length >= answer.bytes.length || exactFiles.has(lower)) return answer;
      const checked = await checkedFile(animation, {ssimulacra2: target}, prepare => encodeAt({...ladder, [ANIMATION_OBSERVER]: prepare}), {signal, maxPixels});
      return checked ? {...answer, ...checked, quality: ladder.quality, unproved: unprovedFrames.get(checked.bytes)} : answer;
    }
  }
  return fixed(await predicted(settings), keep);

  async function predicted(settings) {
    const reader = ordinaryStillReader({signal, maxPixels, filteredStill: false});
    let quality = 1;
    try {
      const description = described(animation), {width, height} = animation;
      for (const frame of displayedAnimationFrames(animation)) {
        check(signal);
        const picture = {...description, data: frame.data, width, height};
        const decision = reader.read(settings, picture) ?? await reader.project(settings, picture);
        quality = Math.max(quality, decision.quality);
      }
    } finally { reader.destroy(); }
    return quality;
  }
}

function frameFloor(animation, floor, {signal, maxPixels}) {
  const {width, height} = animation, first = displayedAnimationFrames(animation)[0];
  if (width < 8 || height < 8 || !first) return undefined;
  const reader = data => pictureMeasure({...animation, frames: undefined, data}, {signal, maxPixels});
  const probe = reader(first.data);
  if (!probe) return undefined;
  probe.destroy();
  const isP3 = animation.colorSpace === 'display-p3';
  return {floor,
    render(picture, x, y) {
      const entry = rebuildInSpace(picture, isP3);
      if (!entry) return null;
      if (isP3) return entry.rgba;
      const out = (entry.kind === 'gamma' ? nativeGammaRGBA : nativeRGBA)(entry.planes, entry.width, entry.height, {x, y});
      if (picture.alpha) for (let at = 3; at < out.length; at += 4) out[at] = entry.rgba[at];
      return out;
    },
    reader(data) {
      const measure = reader(data);
      return {score: rgba => measure.measure({width, height, rgba}, {ssimulacra2: true, butteraugli: false}).ssimulacra2, destroy: () => measure.destroy()};
    }};
}
