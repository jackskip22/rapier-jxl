// SPDX-License-Identifier: MIT
import {pictureMeasure} from './photo-picture-measure.mjs';
import {displayedAnimationFrames, animationTimelinePairs, animationTimelineFailure} from './animation-timeline.mjs';
import {watchShown} from './photo-shown.mjs';
import {nativeRGBA, nativeGammaRGBA} from './photo-output.mjs';
import {xybToShown} from './photo-rebuild.mjs';
import {xybAddRect, blendPaste} from './animation-diff.mjs';
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
    throw internal('photo-animation-measure:copy');
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
        if (stopped || index !== outputIndex++) throw internal('photo-animation-measure:order-1');
        check(signal);
        if (picture.width !== source.width || picture.height !== source.height)
          throw fault('JXL_DIMENSIONS', 'shown animation: size mismatch');
        while (!step.done && step.value.outputIndex === index) {
          const pair = step.value;
          check(signal);
          if (pair.sourceIndex !== sourceIndex) {
            release();
            current = pictureMeasure({...source, frames: undefined, data: pair.source.data}, {cacheBytes, signal, maxPixels});
            sourceIndex = pair.sourceIndex;
          }
          const scores = current.measure(picture, want);
          if (want.libjxl) {
            worst.libjxl ??= Infinity; worst.tool ??= [];
            if (want.libjxl(scores.ssimulacra2)) {
              const tool = current.measure({width: picture.width, height: picture.height, rgba: picture.native ?? picture.rgba},
                {ssimulacra2: true, butteraugli: false, arithmetic: 'libjxl'}).ssimulacra2;
              worst.libjxl = Math.min(worst.libjxl, tool); worst.tool.push([pair.sourceIndex, tool]);
            }
          }
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
      if (closed) throw internal('photo-animation-measure:closed-1');
      check(signal);
      const read = stream({...shown, ...shown.animation, durations: shown.frames.map(frame => frame.durationSeconds)}, want);
      try {
        shown.frames.forEach((picture, index) => read.frame(index, {width: source.width, height: source.height,
          rgba: picture.rgba, native: picture.native}));
        return read.finish();
      } finally { read.destroy(); }
    },
    observe(rebuild, {want, native = true} = {}) {
      if (closed) throw internal('photo-animation-measure:closed-2');
      active?.destroy();
      let timeline = null, read = null, canvas = null, slots = [null, null, null, null], scope = null;
      let pending = new Map(), rebuilt = new Map(), failed = false, retired = false, nextFrame = 0, opened = false, alpha = null, scratch = null, additivePart = null;
      const lose = () => { pending?.clear(); rebuilt?.clear(); scope = null; };
      const release = () => {
        try { read?.destroy(); }
        finally { lose(); read = canvas = slots = alpha = scratch = additivePart = null; }
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
          if (timeline) throw internal('photo-animation-measure:restarted');
          if (description.width !== source.width || description.height !== source.height)
            throw fault('JXL_DIMENSIONS', 'shown animation: size mismatch');
          const {width, height, loops, numerator, denominator, durations, patches, alpha, additive} = description;
          timeline = {width, height, loops, numerator, denominator, durations: durations.slice(), patches, alpha, additive: Boolean(additive)};
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
        settlePart({scope: part, file, rect, saveSlot, masked = false}) {
          if (!usable()) return false;
          if (!timeline) throw internal('photo-animation-measure:timeline');
          const entry = scope === part ? pending.get(file) : null;
          if (!entry) return unavailable();
          lose();
          if (entry.width !== rect[2] || entry.height !== rect[3])
            throw internal('photo-animation-measure:rect');
          if (timeline.additive) {
            if (!entry.xyb || rect[0] || rect[1] || rect[2] !== timeline.width || rect[3] !== timeline.height) return unavailable();
            additivePart = entry; opened = true;
            return true;
          }
          if (saveSlot !== undefined && saveSlot !== null) {
            if (saveSlot !== 0 && saveSlot !== 3) throw internal('photo-animation-measure:slot');
            slots[saveSlot] = entry;
          } else {
            if (!hold(entry)) return unavailable();
            if (!opened && timeline.patches && slots[2] && !copyRect(canvas, slots[2], 0, 0, timeline.width, timeline.height)) return unavailable();
            opened = true;
            if (masked) {
              if (canvas.planes) return unavailable();
              blendPaste(canvas.rgba, timeline.width, entry.rgba, rect[0], rect[1], rect[2], rect[3], true);
              if (canvas.native) blendPaste(canvas.native.rgba, timeline.width, render(entry, rect[0], rect[1]), rect[0], rect[1], rect[2], rect[3], true);
            } else {
              if (!copyRect(canvas, entry, rect[0], rect[1], rect[2], rect[3])) return unavailable();
              if (canvas.native) copyRect(canvas.native, {width: entry.width, height: entry.height, rgba: render(entry, rect[0], rect[1])},
                rect[0], rect[1], rect[2], rect[3]);
            }
          }
          return true;
        },
        finishFrame(index, groups = null, saveSlot = 0, shown = null) {
          if (!usable()) return false;
          if (!timeline || index !== nextFrame++) throw internal('photo-animation-measure:order-2');
          if (timeline.additive) {
            if (!additivePart) return unavailable();
            const {width, height} = timeline, n = width * height;
            let composed = additivePart;
            additivePart = null; opened = false;
            if (groups?.length && shown) {
              const view = xybToShown(shown, width, height, true);
              composed = {width, height, kind: 'linear', xyb: shown, planes: view.linear, rgba: view.rgba};
            } else if (groups?.length) {
              const xyb = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
              xybAddRect(xyb, width, composed.xyb, width, 0, 0, width, height, 0, 0, 1);
              for (const group of groups) {
                const ref = slots[group.reference];
                if (!ref?.xyb) return unavailable();
                for (const position of group.positions) {
                  const mode = position.blending?.length === 1 ? position.blending[0].mode : 0;
                  if (mode !== 1 && mode !== 2) return unavailable();
                  xybAddRect(xyb, width, ref.xyb, ref.width, position.x, position.y, group.w, group.h, group.sx, group.sy, mode);
                }
              }
              const shown = xybToShown(xyb, width, height, true);
              composed = {width, height, kind: 'linear', xyb, planes: shown.linear, rgba: shown.rgba};
            }
            const own = native ? render(composed) : null;
            read.frame(index, {width, height, rgba: composed.rgba, ...(own && {native: own})});
            if (saveSlot && !shown) {
              if (saveSlot !== 2 && saveSlot !== 3) throw internal('photo-animation-measure:slot');
              slots[saveSlot] = {width, height, xyb: composed.xyb};
            }
            lose();
            return true;
          }
          if (groups) {
            for (const group of groups) {
              const entry = slots[group.reference];
              if (!entry) throw internal('photo-animation-measure:ref');
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
            if (!(bytes instanceof Uint8Array)) throw internal('photo-animation-measure:bytes');
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
