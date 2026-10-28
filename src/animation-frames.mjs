// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {BitWriter, part, complete} from './bits.mjs';
import {fault, guard, admitOptions, admitPixels, admitSize} from './admit.mjs';
import {admitSampleFormat} from './admit-samples.mjs';
import {admitEffort} from './effort-level.mjs';
import {job} from './admit.mjs';
import {effortJob} from './effort-job.mjs';
import {inspectPixels, shapeFloors} from './lossless.mjs';
import {photoXYBSteps, preferXYB} from './photo-xyb.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {admitPhotoFilter} from './photo-job.mjs';
import {readStill, metadataKey, writeAnimatedImageHeader, writeAnimatedFrame, BLEND_MODES} from './framing.mjs';
import {checkSignal} from './async-job.mjs';

export const ANIMATION_LIMITS = Object.freeze({pixels: LIMITS.pixels, edge: LIMITS.edge, frames: 1048576});
const CANVAS = 2;

export function admitAnimation(animation, options) {
  if (animation === null || typeof animation !== 'object') throw fault('JXL_INPUT', 'An animation is {width, height, loops, frames}.');
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object.');
  const {width, height, loops = 0, frames} = animation;
  admitSize(width, height);
  if (!Number.isInteger(loops) || loops < 0 || loops > 0xFFFFFFFF) throw fault('JXL_INPUT', 'Loops is a whole number; 0 plays forever.');
  if (!Array.isArray(frames) || !frames.length) throw fault('JXL_INPUT', 'An animation has at least one frame.');
  if (frames.length > ANIMATION_LIMITS.frames) throw fault('JXL_DIMENSIONS', 'An animation has at most ' + ANIMATION_LIMITS.frames + ' frames.');
  const kind = frames[0]?.data?.constructor;
  for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') throw fault('JXL_INPUT', 'A frame is {data, duration}.');
    admitPixels(frame.data, width, height);
    if (frame.data.constructor !== kind) throw fault('JXL_INPUT', 'Every frame uses the same sample array type.');
    if (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF)
      throw fault('JXL_INPUT', 'A frame duration is a number of milliseconds, 0 or more.');
  }
  if (options.lossless !== undefined && typeof options.lossless !== 'boolean') throw fault('JXL_INPUT', 'lossless is a boolean.');
  const {quality, colorSpace} = admitOptions(options.lossless ? {...options, quality: 100} : options);
  const effort = admitEffort(options), filter = admitPhotoFilter(options);
  const samples = admitSampleFormat(frames[0].data, options);
  if (options.photo !== undefined && typeof options.photo !== 'boolean') throw fault('JXL_INPUT', 'photo is a boolean.');
  checkSignal(options.signal);
  const {progress, signal, lossless, photo, ...still} = options;
  return {width, height, loops, frames, quality, colorSpace, effort, filter, samples, photo, signal, still: {...still, quality, effort}};
}

export function* animationSteps(a, shared = null) {
  const {width, height, frames, samples, quality} = a;
  let first = frames.findIndex(frame => frame.duration > 0);
  if (first < 0) first = frames.length - 1;
  const mode = yield* frameMode(a, frames[first].data);
  const shown = [];
  let previous = null, source = null;
  const tolerance = mode === 'modular' ? null : toleranceOf(quality);
  for (let i = 0; i < frames.length; i++) {
    const {data, duration} = frames[i];
    if (!duration && (i < frames.length - 1 || shown.length)) continue;
    const rects = !previous ? [[0, 0, width, height]] : tolerance ? lossyChanges(source, data, width, height, tolerance) : changes(previous, data, width, height);
    if (!rects) { shown.at(-1).duration += duration; shown.at(-1).upTo = i; continue; }
    shown.push({data, duration, rects, upTo: i});
    previous = data;
    if (tolerance) {
      source ||= new Uint8Array(data.length);
      for (const [x, y, w, h] of rects) for (let row = y; row < y + h; row++) source.set(data.subarray((row * width + x) * 4, (row * width + x + w) * 4), (row * width + x) * 4);
    }
    if (i % 16 === 15) yield 0.01 * (i + 1) / frames.length;
  }
  shown.at(-1).upTo = frames.length - 1;
  const timing = ticks(shown.map(frame => frame.duration));
  const floor = {colour: 1, alpha: false};
  if (mode !== 'xyb') for (const {data} of shown) {
    const shape = inspectPixels(data, width, height, {palette: false, samples: samples.native8 ? undefined : samples});
    if (shape.colour === 3) floor.colour = 3;
    if (shape.alpha) floor.alpha = true;
  } else for (const {data} of shown) if (!floor.alpha) for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { floor.alpha = true; break; }

  const parts = shown.flatMap((frame, k) => frame.rects.map((rect, r) => ({frame: k, data: frame.data, previous: k ? shown[k - 1].data : null, rect, shows: r === frame.rects.length - 1})));
  const maskable = mode === 'modular' && samples.native8 && !floor.alpha;
  for (const part of parts) part.candidates = [false];
  if (maskable) {
    const eligible = parts.filter(part => part.previous && (part.kept = unchangedShare(part.previous, part.data, width, part.rect)) >= MASK_SHARE);
    const trial = eligible.reduce((best, part) => !best || part.kept * part.rect[2] * part.rect[3] > best.kept * best.rect[2] * best.rect[3] ? part : best, null);
    if (trial) {
      const [, , w, h] = trial.rect, code = (masked, alpha) => complete(partSteps(coderOf(a, mode, {...floor, alpha}), pixelsOf({...trial, masked}, width), w, h)).length;
      const fill = inspectPixels(shown[0].data, width, height).palette ? 'zero' : 'up';
      for (const part of eligible) part.fill = fill;
      if (code(true, true) < 0.97 * code(false, false)) {
        floor.alpha = true;
        for (const part of eligible) part.candidates = a.effort >= 2 ? [false, true] : [true];
      }
      yield 0.02;
    }
  }
  const jobs = parts.flatMap(part => part.candidates.map(masked => ({part, masked, rect: part.rect, data: part.data, previous: part.previous, fill: part.fill})));
  const byFrame = Array.from({length: shown.length}, () => []);
  for (const job of jobs) byFrame[job.part.frame].push(job);
  for (let k = 0, from = 0; k < shown.length; k++) {
    const own = byFrame[k], area = own.reduce((n, {rect}) => n + rect[2] * rect[3], 0), to = (shown[k].upTo + 1) / frames.length;
    let at = from;
    for (const job of own) { const next = at + (to - from) * job.rect[2] * job.rect[3] / area; job.span = [at, next]; at = next; }
    from = to;
  }
  const coder = coderOf(a, mode, floor), progress = done => 0.02 + 0.97 * done;
  for (const job of jobs) {
    const [, , w, h] = job.rect, [from, to] = job.span;
    const steps = shared ? shared.partSteps(coder, pixelsOf(job, width), w, h, job) : partSteps(coder, pixelsOf(job, width), w, h);
    let step, reply;
    while (!(step = steps.next(reply)).done) reply = yield progress(from + (to - from) * step.value);
    job.bytes = step.value;
  }
  for (const job of jobs) if (!job.part.still || job.bytes.length < job.part.bytes) Object.assign(job.part, {still: job.bytes, bytes: job.bytes.length, masked: job.masked});
  for (const part of parts) part.still = readStill(part.still);
  const key = metadataKey(parts[0].still);
  if (parts.some(({still}) => metadataKey(still) !== key)) throw fault('JXL_FRAMING', 'The frames of the animation need different image headers.');
  const out = new BitWriter(1 << 16);
  writeAnimatedImageHeader(out, parts[0].still, {width, height, ...timing, loops: a.loops}, parts.every(({still}) => still.image.modular16));
  const canvas = {width, height, extraChannels: parts[0].still.image.extraChannels};
  shared?.writeReferences(out, canvas, key);
  parts.forEach(({frame: k, rect: [x0, y0], shows, still, masked}, p) => {
    const next = parts[p + 1], last = !next;
    const keep = !last && !(next.rect[2] === width && next.rect[3] === height && !next.masked);
    still.frames.forEach((frame, f) => {
      writeAnimatedFrame(out, still, frame, f === still.frames.length - 1
        ? {canvas, x0, y0, duration: shows ? timing.durations[k] : 0, last, reference: keep ? CANVAS : 0, source: CANVAS, mode: masked ? BLEND_MODES.blend : BLEND_MODES.replace}
        : {canvas, reference: CANVAS});
    });
  });
  const codestream = out.finish();
  return parts.some(({still}) => still.level === 10) ? levelTen(codestream) : codestream;
}

let measuredSearch;
export function useMeasuredSearch(search) { measuredSearch = search; }
const frameEncodeSteps = (data, width, height, options) => job(effortJob(data, width, height, options, false, undefined, measuredSearch));

function* frameMode(a, first) {
  const {width, height, quality, samples, photo, colorSpace} = a;
  if (quality >= 100 || !samples.native8 || photo === false) return 'modular';
  const dct = colorSpace === 'srgb' && preferXYB(first, width, height) ? 'xyb' : 'ycbcr';
  if (photo === true || !inspectPixels(first, width, height).palette) return dct;
  let alpha = false;
  for (let i = 3; i < first.length && !alpha; i += 4) alpha = first[i] !== 255;
  const shrink = steps => (function* () { let step, reply; while (!(step = steps.next(reply)).done) reply = yield 0.01 + 0.01 * step.value; return step.value; })();
  const exact = yield* shrink(part(frameEncodeSteps(first, width, height, {...a.still, quality: 100, effort: 1}), 0, 2));
  const lossy = yield* shrink(part(frameSteps(a, dct, first, width, height, {alpha}), 1, 2));
  return exact.length <= lossy.length ? 'modular' : dct;
}

function coderOf({quality, filter, colorSpace, effort, still}, mode, floor) { return {mode, quality, filter, colorSpace, effort, still, floor}; }

export function* partSteps(coder, crop, w, h) {
  shapeFloors.set(crop, coder.floor);
  return yield* frameSteps(coder, coder.mode, crop, w, h, coder.floor);
}

function* frameSteps(a, mode, crop, w, h, floor) {
  if (mode === 'modular') return yield* frameEncodeSteps(crop, w, h, a.still);
  const coefficients = yield* part(mode === 'xyb' ? photoXYBSteps(crop, w, h, a.quality, {filter: a.filter})
    : photoCoefficientSteps(crop, w, h, a.quality, a.colorSpace), 0, 2);
  coefficients.alpha = floor.alpha ? crop : null;
  return yield* part(coefficientAnsSteps(coefficients, a.effort), 1, 2);
}

const SEPARATE = 4096, TILE = 16, MOST = 16;

function changes(before, after, width, height) {
  if (before instanceof Float32Array) { before = new Uint32Array(before.buffer, before.byteOffset, before.length); after = new Uint32Array(after.buffer, after.byteOffset, after.length); }
  const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE), tiles = tilesX * tilesY;
  const bounds = new Int32Array(tiles * 4).fill(-1), row = width * 4;
  let any = false;
  for (let y = 0; y < height; y++) {
    const start = y * row, ty = (y / TILE | 0) * tilesX;
    for (let i = start, end = start + row; i < end; i++) {
      if (before[i] === after[i]) continue;
      const x = (i - start) >> 2, t = (ty + (x / TILE | 0)) * 4;
      if (bounds[t] < 0) { bounds[t] = bounds[t + 2] = x; bounds[t + 1] = bounds[t + 3] = y; }
      else { if (x < bounds[t]) bounds[t] = x; if (x > bounds[t + 2]) bounds[t + 2] = x; bounds[t + 3] = y; }
      any = true;
      i = start + x * 4 + 3;
    }
  }
  return any ? regions(bounds, tilesX, tilesY, width, height, 1) : null;
}

function regions(bounds, tilesX, tilesY, width, height, block) {
  const tiles = tilesX * tilesY;
  const label = new Uint8Array(tiles), rects = [], stack = [];
  for (let t = 0; t < tiles; t++) {
    if (bounds[t * 4] < 0 || label[t]) continue;
    const r = [width, height, 0, 0];
    label[t] = 1; stack.push(t);
    while (stack.length) {
      const u = stack.pop(), ux = u % tilesX, uy = u / tilesX | 0;
      r[0] = Math.min(r[0], bounds[u * 4]); r[1] = Math.min(r[1], bounds[u * 4 + 1]);
      r[2] = Math.max(r[2], bounds[u * 4 + 2] + 1); r[3] = Math.max(r[3], bounds[u * 4 + 3] + 1);
      for (let vy = Math.max(0, uy - 1); vy <= Math.min(tilesY - 1, uy + 1); vy++) for (let vx = Math.max(0, ux - 1); vx <= Math.min(tilesX - 1, ux + 1); vx++) {
        const v = vy * tilesX + vx;
        if (bounds[v * 4] >= 0 && !label[v]) { label[v] = 1; stack.push(v); }
      }
    }
    rects.push([Math.floor(r[0] / block) * block, Math.floor(r[1] / block) * block, Math.min(width, Math.ceil(r[2] / block) * block), Math.min(height, Math.ceil(r[3] / block) * block)]);
  }
  const size = r => (r[2] - r[0]) * (r[3] - r[1]);
  const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  for (;;) {
    let best = null, waste = Infinity;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const extra = size(union(rects[i], rects[j])) - size(rects[i]) - size(rects[j]);
      if (extra < waste) { waste = extra; best = [i, j]; }
    }
    if (!best || waste >= SEPARATE && rects.length <= MOST) break;
    rects[best[0]] = union(rects[best[0]], rects[best[1]]); rects.splice(best[1], 1);
  }
  return rects.map(([x0, y0, x1, y1]) => [x0, y0, x1 - x0, y1 - y0]);
}

const TOLERANCE = {mean: 1.25, most: 7};
function toleranceOf(quality) {
  const distance = quality >= 30 ? 0.1 + (100 - quality) * 0.09 : 53 / 3000 * quality * quality - 23 / 20 * quality + 25;
  return {mean: TOLERANCE.mean * distance, most: TOLERANCE.most * distance};
}

function lossyChanges(source, after, width, height, {mean, most}) {
  const tilesX = Math.ceil(width / TILE), tilesY = Math.ceil(height / TILE), bounds = new Int32Array(tilesX * tilesY * 4).fill(-1);
  let any = false;
  for (let y0 = 0; y0 < height; y0 += 8) for (let x0 = 0; x0 < width; x0 += 8) {
    const y1 = Math.min(height, y0 + 8), x1 = Math.min(width, x0 + 8);
    let sum = 0, peak = 0;
    for (let y = y0; y < y1; y++) for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
      const d = after[i + 3] !== source[i + 3] ? 255 : Math.max(Math.abs(after[i] - source[i]), Math.abs(after[i + 1] - source[i + 1]), Math.abs(after[i + 2] - source[i + 2]));
      sum += d; if (d > peak) peak = d;
    }
    if (sum <= mean * (x1 - x0) * (y1 - y0) && peak <= most) continue;
    const t = ((y0 / TILE | 0) * tilesX + (x0 / TILE | 0)) * 4;
    if (bounds[t] < 0) { bounds[t] = x0; bounds[t + 1] = y0; bounds[t + 2] = x1 - 1; bounds[t + 3] = y1 - 1; }
    else { bounds[t] = Math.min(bounds[t], x0); bounds[t + 1] = Math.min(bounds[t + 1], y0); bounds[t + 2] = Math.max(bounds[t + 2], x1 - 1); bounds[t + 3] = Math.max(bounds[t + 3], y1 - 1); }
    any = true;
  }
  return any ? regions(bounds, tilesX, tilesY, width, height, 8) : null;
}

const MASK_SHARE = 0.25;

function unchangedShare(before, after, width, [x0, y0, w, h]) {
  let kept = 0;
  for (let y = y0; y < y0 + h; y++) for (let i = (y * width + x0) * 4, end = i + w * 4; i < end; i += 4)
    if (before[i] === after[i] && before[i + 1] === after[i + 1] && before[i + 2] === after[i + 2] && before[i + 3] === after[i + 3]) kept++;
  return kept / (w * h);
}

export function pixelsOf({data, previous, rect: [x, y, w, h], masked, fill}, width) {
  const crop = cropOf(data, width, x, y, w, h);
  if (!masked) return crop;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const at = (row * w + col) * 4, from = ((y + row) * width + x + col) * 4;
    if (previous[from] !== data[from] || previous[from + 1] !== data[from + 1] || previous[from + 2] !== data[from + 2] || previous[from + 3] !== data[from + 3]) continue;
    const source = fill === 'zero' ? -1 : row ? at - w * 4 : col ? at - 4 : -1;
    crop[at] = source < 0 ? 0 : crop[source]; crop[at + 1] = source < 0 ? 0 : crop[source + 1]; crop[at + 2] = source < 0 ? 0 : crop[source + 2]; crop[at + 3] = 0;
  }
  return crop;
}

export function cropOf(data, width, x, y, w, h) {
  if (x === 0 && y === 0 && w === width && h * width * 4 === data.length) return data.slice();
  const out = new data.constructor(w * h * 4);
  for (let row = 0; row < h; row++) out.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
  return out;
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function fraction(value) {
  let [p0, q0, p1, q1] = [0, 1, 1, 0], x = value;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x), p = a * p1 + p0, q = a * q1 + q0;
    if (q > 100000) break;
    [p0, q0, p1, q1] = [p1, q1, p, q];
    if (Math.abs(p / q - value) <= 1e-6) return [p, q];
    if (x === a) break;
    x = 1 / (x - a);
  }
  return null;
}

function ticks(durations) {
  const parts = durations.map(fraction);
  if (parts.every(Boolean)) {
    const lcm = parts.reduce((l, [, q]) => l / gcd(l, q) * q, 1);
    const counts = parts.map(([p, q]) => p * (lcm / q));
    const common = counts.reduce(gcd, 0) || 1;
    const n = 1000 * lcm, g = gcd(n, common), numerator = n / g, denominator = common / g;
    if (Number.isSafeInteger(lcm) && numerator <= 1073741824 && denominator <= 1024 && counts.every(c => c / common <= 0xFFFFFFFF))
      return {numerator, denominator, durations: counts.map(c => c / common)};
  }
  let best = [1000, 1], least = 0.05;
  for (const [numerator, denominator] of VIDEO_RATES) {
    const tick = 1000 * denominator / numerator;
    const error = durations.reduce((most, d) => Math.max(most, d / tick < 0.5 ? Infinity : Math.abs(d / tick - Math.round(d / tick)) * tick), 0);
    if (error < least) { least = error; best = [numerator, denominator]; }
  }
  return carried(durations, ...best);
}

const VIDEO_RATES = [[24, 1], [25, 1], [30, 1], [24000, 1001], [30000, 1001], [48, 1], [50, 1], [60, 1], [60000, 1001], [120, 1], [240, 1], [100, 1]];

function carried(durations, numerator, denominator) {
  let total = 0, at = 0;
  return {numerator, denominator, durations: durations.map(d => { total += d * numerator / (1000 * denominator); const next = Math.round(total), ticks = next - at; at = next; return ticks; })};
}

function levelTen(codestream) {
  const out = new Uint8Array(49 + codestream.length);
  out.set([0,0,0,12,74,88,76,32,13,10,135,10, 0,0,0,20,102,116,121,112,106,120,108,32,0,0,0,0,106,120,108,32,
    0,0,0,9,106,120,108,108,10, 0,0,0,0,106,120,108,99]);
  new DataView(out.buffer).setUint32(41, codestream.length + 8);
  out.set(codestream, 49);
  return out;
}
