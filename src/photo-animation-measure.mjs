// SPDX-License-Identifier: MIT
import {pictureMeasure} from './photo-picture-measure.mjs';
import {displayedAnimationFrames, animationTimelinePairs, animationTimelineFailure} from './animation-timeline.mjs';
import {fault} from './fault.mjs';
import {s2Dimensions} from './ssimulacra2-input.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const refuse = failure => { throw fault(failure.code, failure.message); };

export function composeTimeline({width, height, loops, durations, parts}, pictures) {
  const canvas = new Uint8Array(width * height * 4), frames = [];
  for (const {frame, rect: [x0, y0, w, h], shows, file} of parts) {
    const rgba = pictures.get(file);
    if (!rgba) return null;
    for (let y = 0; y < h; y++) canvas.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * width + x0) * 4);
    if (shows) frames.push({rgba: canvas.slice(), durationSeconds: durations[frame]});
  }
  return {width, height, animation: {loops}, frames};
}

export function photoAnimationMeasure(source, {cacheBytes = 0, signal, maxPixels} = {}) {
  check(signal);
  const first = displayedAnimationFrames(source)[0];
  if (!first) refuse(animationTimelineFailure('empty'));
  s2Dimensions(source.width, source.height);
  const probe = pictureMeasure({...source, frames: undefined, data: first.data}, {signal, maxPixels});
  if (!probe) return null;
  probe.destroy();
  let current = null, closed = false;
  const release = () => { const held = current; current = null; held?.destroy(); };
  return {
    domain: 'decoded-output',
    measure(shown, want) {
      if (closed) throw fault('JXL_INTERNAL', 'The animation measurement is closed.');
      check(signal);
      const pairs = animationTimelinePairs(source, shown), worst = {};
      let step, sourceIndex = -1;
      try {
        while (!(step = pairs.next()).done) {
          check(signal);
          const pair = step.value;
          if (pair.sourceIndex !== sourceIndex) {
            release();
            current = pictureMeasure({...source, frames: undefined, data: pair.source.data}, {cacheBytes, signal, maxPixels});
            sourceIndex = pair.sourceIndex;
          }
          const scores = current.measure({width: source.width, height: source.height, rgba: pair.output.rgba}, want);
          for (const name of ['ssimulacra2', 'butteraugli', 'butteraugli3']) if (scores[name] !== undefined)
            worst[name] = worst[name] === undefined ? scores[name]
              : name === 'ssimulacra2' ? Math.min(worst[name], scores[name]) : Math.max(worst[name], scores[name]);
        }
        if (step.value) refuse(step.value);
        check(signal);
        return worst;
      } finally { pairs.return(); release(); }
    },
    destroy() { if (closed) return; closed = true; source = null; release(); },
  };
}
