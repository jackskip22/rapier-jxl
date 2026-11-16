// SPDX-License-Identifier: MIT
import {pictureMeasure} from './photo-picture-measure.mjs';
import {displayedAnimationFrames, animationTimelinePairs, animationTimelineFailure} from './animation-timeline.mjs';
import {watchShown} from './photo-shown.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {fault} from './fault.mjs';
import {s2Dimensions} from './ssimulacra2-input.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const refuse = failure => { throw fault(failure.code, failure.message); };
const internal = message => fault('JXL_INTERNAL', message);

function copyRect(into, source, x, y, w, h, sx = 0, sy = 0) {
  if (into.planes && source.kind !== into.kind) return false;
  if (![x, y, w, h, sx, sy].every(Number.isSafeInteger) || w < 1 || h < 1 || x < 0 || y < 0 || sx < 0 || sy < 0 ||
      x + w > into.width || y + h > into.height || sx + w > source.width || sy + h > source.height)
    throw internal('An animation measurement copy exceeds its source or canvas.');
  for (let row = 0; row < h; row++) {
    const from = (sy + row) * source.width + sx, to = (y + row) * into.width + x;
    into.rgba.set(source.rgba.subarray(from * 4, (from + w) * 4), to * 4);
    if (into.planes) for (let c = 0; c < 3; c++) into.planes[c].set(source.planes[c].subarray(from, from + w), to);
  }
  return true;
}

const canvasOf = (width, height, kind = null) => ({width, height, rgba: new Uint8Array(width * height * 4),
  ...(kind && {kind, planes: Array.from({length: 3}, () => new Float32Array(width * height))})});

function alphaOf(rgba, width, height, alpha, scratch) {
  kernelHooks.ensure?.();
  const rows = Math.max(1, Math.min(height, Math.floor(65536 / width)));
  for (let y = 0; y < height; y += rows) {
    const count = Math.min(rows, height - y), from = y * width, length = count * width;
    if (!kernelHooks.fill?.(rgba, width, 0, y, width, count, 2, [scratch, alpha.subarray(from, from + length)]))
      throw wasmRequired();
  }
  return alpha;
}

export function photoAnimationMeasure(source, {cacheBytes = 0, signal, maxPixels} = {}) {
  check(signal);
  const first = displayedAnimationFrames(source)[0];
  if (!first) refuse(animationTimelineFailure('empty'));
  s2Dimensions(source.width, source.height);
  const probe = pictureMeasure({...source, frames: undefined, data: first.data}, {signal, maxPixels});
  if (!probe) return null;
  probe.destroy();
  let closed = false, active = null;

  function stream(timeline, want) {
    const outputs = {width: timeline.width, height: timeline.height,
      animation: {loops: timeline.loops, numerator: timeline.numerator, denominator: timeline.denominator},
      frames: timeline.durations.map(durationSeconds => ({durationSeconds}))};
    const pairs = animationTimelinePairs(source, outputs), worst = {};
    let step = pairs.next(), current = null, sourceIndex = -1, outputIndex = 0, stopped = false;
    const release = () => { const held = current; current = null; held?.destroy(); };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      try { pairs.return(); } finally { release(); }
    };
    return {
      frame(index, picture) {
        if (stopped || index !== outputIndex++) throw internal('Animation measurement frames must finish in order.');
        check(signal);
        if (picture.width !== source.width || picture.height !== source.height)
          throw fault('JXL_DIMENSIONS', 'The shown animation differs from its measurement reference.');
        while (!step.done && step.value.outputIndex === index) {
          const pair = step.value;
          check(signal);
          if (pair.sourceIndex !== sourceIndex) {
            release();
            current = pictureMeasure({...source, frames: undefined, data: pair.source.data}, {cacheBytes, signal, maxPixels});
            sourceIndex = pair.sourceIndex;
          }
          const scores = current.measure(picture, want);
          if (scores.ssimulacra2 !== undefined)
            worst.ssimulacra2 = worst.ssimulacra2 === undefined ? scores.ssimulacra2 : Math.min(worst.ssimulacra2, scores.ssimulacra2);
          step = pairs.next();
        }
      },
      finish() {
        try {
          check(signal);
          if (step.done && step.value) refuse(step.value);
          if (outputIndex !== outputs.frames.length || !step.done) refuse(animationTimelineFailure('terminal'));
          return worst;
        } finally { finish(); }
      },
      destroy: finish,
    };
  }

  return {
    domain: 'decoded-output',
    measure(shown, want) {
      if (closed) throw internal('The animation measurement is closed.');
      check(signal);
      const read = stream({...shown, ...shown.animation, durations: shown.frames.map(frame => frame.durationSeconds)}, want);
      try {
        shown.frames.forEach((picture, index) => read.frame(index, {width: source.width, height: source.height,
          rgba: picture.rgba, native: picture.native}));
        return read.finish();
      } finally { read.destroy(); }
    },
    observe(rebuild, {want, native = true} = {}) {
      if (closed) throw internal('The animation measurement is closed.');
      active?.destroy();
      let timeline = null, read = null, canvas = null, slots = [null, null, null, null], scope = null;
      let pending = new Map(), rebuilt = new Map(), failed = false, retired = false, nextFrame = 0, opened = false, alpha = null, scratch = null;
      const lose = () => { pending?.clear(); rebuilt?.clear(); scope = null; };
      const release = () => {
        try { read?.destroy(); }
        finally { lose(); read = canvas = slots = alpha = scratch = null; }
      };
      const unavailable = () => { failed = true; release(); return false; };
      const usable = () => { check(signal); return !retired && !failed; };
      const hold = entry => {
        if (!canvas) {
          canvas = canvasOf(timeline.width, timeline.height, timeline.patches ? entry.kind : null);
          if (native && !timeline.patches) canvas.native = canvasOf(timeline.width, timeline.height);
        }
        return !canvas.planes || canvas.kind === entry.kind;
      };
      const render = (entry, x = 0, y = 0) => {
        const {width, height} = entry, pixels = width * height;
        let opacity = null;
        if (timeline.alpha) {
          if (!alpha || alpha.length < pixels) alpha = new Uint8Array(pixels);
          scratch ??= new Int32Array(65536);
          opacity = alphaOf(entry.rgba, width, height, alpha.subarray(0, pixels), scratch);
        }
        return (entry.kind === 'gamma' ? nativeGammaRGBA : nativeRGBA)(entry.planes, width, height, {x, y, alpha: opacity});
      };
      const observer = {
        begin(description) {
          if (!usable()) return false;
          if (timeline) throw internal('An animation measurement begins once per encoder instance.');
          if (description.width !== source.width || description.height !== source.height)
            throw fault('JXL_DIMENSIONS', 'The shown animation differs from its measurement reference.');
          const {width, height, loops, numerator, denominator, durations, patches, alpha} = description;
          timeline = {width, height, loops, numerator, denominator, durations: durations.slice(), patches, alpha};
          read = stream(timeline, want);
          return true;
        },
        next(part, steps, reply) {
          if (!usable()) return steps.next(reply);
          if (scope !== part) { lose(); scope = part; }
          const stop = watchShown((bytes, picture) => {
            let entry = rebuilt.get(picture);
            if (entry === undefined) rebuilt.set(picture, entry = rebuild(picture));
            if (entry) pending.set(bytes, entry);
          });
          try { return steps.next(reply); } finally { stop(); }
        },
        settlePart({scope: part, file, rect, saveSlot}) {
          if (!usable()) return false;
          if (!timeline) throw internal('An animation measurement needs its timeline before its parts.');
          const entry = scope === part ? pending.get(file) : null;
          if (!entry) return unavailable();
          lose();
          if (entry.width !== rect[2] || entry.height !== rect[3])
            throw internal('The chosen animation rebuild differs from its coded rectangle.');
          if (saveSlot !== undefined && saveSlot !== null) {
            if (saveSlot !== 0 && saveSlot !== 3) throw internal('An animation part cannot replace its canvas or internal dictionary reference.');
            slots[saveSlot] = entry;
          } else {
            if (!hold(entry)) return unavailable();
            if (!opened && timeline.patches && slots[2] && !copyRect(canvas, slots[2], 0, 0, timeline.width, timeline.height)) return unavailable();
            opened = true;
            if (!copyRect(canvas, entry, rect[0], rect[1], rect[2], rect[3])) return unavailable();
            if (canvas.native) copyRect(canvas.native, {width: entry.width, height: entry.height, rgba: render(entry, rect[0], rect[1])},
              rect[0], rect[1], rect[2], rect[3]);
          }
          return true;
        },
        finishFrame(index, groups = null) {
          if (!usable()) return false;
          if (!timeline || index !== nextFrame++) throw internal('Animation measurement frames must finish in order.');
          if (groups) {
            for (const group of groups) {
              const entry = slots[group.reference];
              if (!entry) throw internal('An animation view reads an unavailable reference slot.');
              if (!hold(entry)) return unavailable();
              for (const position of group.positions) {
                if (!position.blending?.length || position.blending.some(blend => blend.mode !== 1)) return unavailable();
                if (!copyRect(canvas, entry, position.x, position.y, group.w, group.h, group.sx, group.sy)) return unavailable();
              }
            }
          }
          if (!canvas) return unavailable();
          let own = native ? canvas.native?.rgba ?? render(canvas) : null;
          read.frame(index, {width: timeline.width, height: timeline.height, rgba: canvas.rgba, ...(own && {native: own})});
          own = null;
          if (timeline.patches) {
            const previous = slots[2]; slots[2] = canvas; canvas = previous;
          }
          lose(); opened = false;
          return true;
        },
        finish(bytes) {
          if (retired) return null;
          try {
            check(signal);
            if (!(bytes instanceof Uint8Array)) throw internal('An animation producer must return complete bytes.');
            return failed || !bytes.length || !read ? null : {bytes, scores: read.finish()};
          } finally { observer.destroy(); }
        },
        destroy() {
          if (retired) return;
          retired = true;
          try { release(); }
          finally {
            pending = rebuilt = timeline = rebuild = null;
            if (active === observer) active = null;
          }
        },
      };
      return active = observer;
    },
    destroy() { if (closed) return; closed = true; active?.destroy(); active = null; source = null; },
  };
}
