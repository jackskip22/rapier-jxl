// SPDX-License-Identifier: MIT
export function displayedAnimationFrames(reference) {
  return displayedFrameIndices(reference).map(i => reference.frames[i]);
}
export function displayedFrameIndices(reference) {
  const last = reference.frames.length - 1, ends = (reference.loops ?? 0) > 0, shown = [];
  reference.frames.forEach((frame, i) => { if (frame.duration > 0 || ends && i === last) shown.push(i); });
  return shown.length ? shown : [last];
}

export const VIDEO_RATES = [[24, 1], [25, 1], [30, 1], [24000, 1001], [30000, 1001], [48, 1], [50, 1], [60, 1], [60000, 1001], [120, 1], [240, 1], [100, 1]];
const roundedRate = (numerator, denominator) => numerator === 1000 && denominator === 1 ||
  VIDEO_RATES.some(([n, d]) => n === numerator && d === denominator);
function displayedOutputs(decoded) {
  const frames = decoded.frames, last = frames.length - 1, ends = (decoded.animation.loops ?? 0) > 0;
  const shown = frames.filter((frame, i) => frame.durationSeconds > 0 || ends && i === last);
  return shown.length ? shown : frames.slice(-1);
}

const FAILURES = {
  missing: ['JXL_TARGET', 'timeline: missing'],
  empty: ['JXL_TARGET', 'frames: none displayed'],
  duration: ['JXL_UNSUPPORTED', 'duration rounded: exact timeline unavailable'],
  terminal: ['JXL_TARGET', 'timeline: mismatch'],
};
export function animationTimelineFailure(kind) {
  const [code, message] = FAILURES[kind];
  return {kind, code, message};
}

export function* animationTimelinePairs(reference, decoded) {
  if (!decoded.animation || (reference.loops ?? 0) !== decoded.animation.loops)
    return animationTimelineFailure('missing');
  const frames = displayedAnimationFrames(reference), outputs = decoded.frames?.length ? displayedOutputs(decoded) : [];
  if (!frames.length || !outputs.length) return animationTimelineFailure('empty');
  const total = frames.reduce((sum, frame) => sum + frame.duration, 0),
    actualTotal = outputs.reduce((sum, frame) => sum + frame.durationSeconds * 1000, 0);
  if (Math.abs(total - actualTotal) > 1e-6 * Math.max(frames.length, outputs.length))
    return yield* roundedPairs(frames, outputs, decoded.animation, Math.abs(total - actualTotal));
  let i = 0, j = 0, left = frames[0].duration, right = outputs[0].durationSeconds * 1000;
  while (i < frames.length && j < outputs.length) {
    yield {source: frames[i], output: outputs[j], sourceIndex: i, outputIndex: j};
    const elapsed = Math.min(left, right); left -= elapsed; right -= elapsed;
    if (left <= 1e-6) { i++; if (i < frames.length) left = frames[i].duration; }
    if (right <= 1e-6) { j++; if (j < outputs.length) right = outputs[j].durationSeconds * 1000; }
  }
  return i === frames.length && j === outputs.length ? null : animationTimelineFailure('terminal');
}

function* roundedPairs(frames, outputs, {numerator, denominator}, difference) {
  if (!roundedRate(numerator, denominator)) return animationTimelineFailure('duration');
  const slack = 500 * denominator / numerator;
  if (difference > slack) return animationTimelineFailure('duration');
  let i = 0, j = 0, sourceEnd = frames[0].duration, outputEnd = outputs[0].durationSeconds * 1000;
  while (i < frames.length && j < outputs.length) {
    yield {source: frames[i], output: outputs[j], sourceIndex: i, outputIndex: j};
    const together = Math.abs(sourceEnd - outputEnd) <= slack, sourceFirst = together || sourceEnd < outputEnd;
    if (!sourceFirst) return animationTimelineFailure('terminal');
    if (sourceFirst) { i++; if (i < frames.length) sourceEnd += frames[i].duration; }
    if (together || !sourceFirst) { j++; if (j < outputs.length) outputEnd += outputs[j].durationSeconds * 1000; }
  }
  return i === frames.length && j === outputs.length ? null : animationTimelineFailure('terminal');
}
