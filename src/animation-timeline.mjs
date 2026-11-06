// SPDX-License-Identifier: MIT
export function displayedAnimationFrames(reference) {
  const frames = reference.frames.filter(frame => frame.duration > 0);
  return frames.length ? frames : reference.frames.slice(-1);
}

const FAILURES = {
  missing: ['JXL_TARGET', 'Animation loop count or timeline is missing.'],
  empty: ['JXL_TARGET', 'The animation has no displayed frame.'],
  duration: ['JXL_UNSUPPORTED', 'The animation duration was rounded; exact timeline verification is unavailable.'],
  terminal: ['JXL_TARGET', 'The animation timeline differs from the source.'],
};
export function animationTimelineFailure(kind) {
  const [code, message] = FAILURES[kind];
  return {kind, code, message};
}

export function* animationTimelinePairs(reference, decoded) {
  if (!decoded.animation || (reference.loops ?? 0) !== decoded.animation.loops)
    return animationTimelineFailure('missing');
  const frames = displayedAnimationFrames(reference), outputs = decoded.frames;
  if (!frames.length || !outputs?.length) return animationTimelineFailure('empty');
  const total = frames.reduce((sum, frame) => sum + frame.duration, 0),
    actualTotal = outputs.reduce((sum, frame) => sum + frame.durationSeconds * 1000, 0);
  if (Math.abs(total - actualTotal) > 1e-6 * Math.max(frames.length, outputs.length))
    return animationTimelineFailure('duration');
  let i = 0, j = 0, left = frames[0].duration, right = outputs[0].durationSeconds * 1000;
  while (i < frames.length && j < outputs.length) {
    yield {source: frames[i], output: outputs[j], sourceIndex: i, outputIndex: j};
    const elapsed = Math.min(left, right); left -= elapsed; right -= elapsed;
    if (left <= 1e-6) { i++; if (i < frames.length) left = frames[i].duration; }
    if (right <= 1e-6) { j++; if (j < outputs.length) right = outputs[j].durationSeconds * 1000; }
  }
  return i === frames.length && j === outputs.length ? null : animationTimelineFailure('terminal');
}
