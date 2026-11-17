// SPDX-License-Identifier: MIT
import {photoXYBSteps, gaborishXYB, signedRoot, XYB_TABLES} from './photo-xyb.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {V6, GABORISH} from './photo-v6-settings.mjs';
import {float16Sample as half} from './sample-values.mjs';
import {float16Bits} from './bits.mjs';
import {reconstruct} from './reconstruct.mjs';
import {ssimulacra2} from './ssimulacra2.mjs';
import {qualityTarget, measuredLook} from './photo-quality-table.mjs';
import {measuredTarget} from './photo-browser-margin.mjs';
import {hdrSpace, hdrCurve, srgbLight, hdrNits, hdrViews, hdrDomain, pu21Levels} from './hdr-look.mjs';
import {toLinearSrgb, matrixTimes} from './xyb-space.mjs';
import {flatSamples, CAPTURE_FLAT} from './screen-samples.mjs';
import {captureDeepLeaves} from './capture-kernels.mjs';

const {mix: MIX, bias: BIAS, rootBias: ROOT_BIAS} = XYB_TABLES;
const spaceOf = hdrSpace, curveOf = hdrCurve;

export const hdrRoute = (data, samples, quality) => quality < 100 && hdrDomain(data, samples);

export function* hdrSteps(data, width, height, quality, effort, samples, exact, report) {
  let facts = null;
  const lossy = yield* hdrLossySteps(data, width, height, quality, effort, samples, found => { facts = found; });
  if (!lossy) { const file = yield* exact(effort); report?.({kept: 'pixels', measurements: []}); return file; }
  const cheap = yield* exact(1);
  if (cheap.length <= lossy.length) {
    const own = effort > 1 ? yield* exact(effort) : cheap;
    report?.({kept: 'pixels', measurements: []});
    return own.length < cheap.length ? own : cheap;
  }
  const small = effort >= 6 || width * height < SMALL_PIXELS;
  if (effort > 1 && (small || graphic(data, width, height))) {
    const own = yield* exact(effort);
    if (own.length < lossy.length) { report?.({kept: 'pixels', measurements: []}); return own; }
  }
  if (facts) report?.(facts);
  return lossy;
}

const SMALL_PIXELS = 16384;
function graphic(data, width, height) {
  if (flatSamples(data, width, height, CAPTURE_FLAT) >= CAPTURE_FLAT) return true;
  if (width < 2 || height < 3) return false;
  return captureDeepLeaves(data, width, height);
}

const BOOSTS = [[60, 15], [75, 12], [85, 9], [92, 8]];
function boostFor(quality) {
  if (quality <= BOOSTS[0][0]) return BOOSTS[0][1];
  for (let i = 1; i < BOOSTS.length; i++) if (quality <= BOOSTS[i][0]) {
    const [q0, b0] = BOOSTS[i - 1], [q1, b1] = BOOSTS[i];
    return Math.min(100 - quality, Math.round(b0 + (b1 - b0) * (quality - q0) / (q1 - q0)));
  }
  return Math.max(0, Math.min(100 - quality, 8));
}

const PREDICTION = [[50, 63.9, 29.1], [60, 68.7, 27.9], [70, 73.5, 27.2], [75, 76.1, 27.1], [80, 83.1, 17.4], [85, 89.6, 7.8], [90, 95.9, 2.2], [92, 100, 0]];
function predictedQuality(quality, reading) {
  const r = Math.min(1.4, Math.max(0.55, reading)) - 0.8, last = PREDICTION.length - 1;
  let at;
  if (quality <= PREDICTION[0][0]) at = PREDICTION[0][1] + PREDICTION[0][2] * r + quality - PREDICTION[0][0];
  else if (quality >= PREDICTION[last][0]) at = PREDICTION[last][1] + PREDICTION[last][2] * r + quality - PREDICTION[last][0];
  else for (let i = 1; i <= last; i++) if (quality <= PREDICTION[i][0]) {
    const [q0, a0, b0] = PREDICTION[i - 1], [q1, a1, b1] = PREDICTION[i], t = (quality - q0) / (q1 - q0);
    at = a0 + t * (a1 - a0) + (b0 + t * (b1 - b0)) * r;
    break;
  }
  return Math.max(1, Math.min(100, Math.round(at)));
}
const INTEGER = [[40, 70], [50, 75], [55, 77], [60, 78], [65, 80], [70, 82], [75, 84], [80, 88], [85, 91], [90, 95], [92, 97], [95, 98]];
function integerQuality(quality) {
  const last = INTEGER.length - 1;
  if (quality <= INTEGER[0][0]) return Math.max(1, Math.round(INTEGER[0][1] - INTEGER[0][0] + quality));
  if (quality >= INTEGER[last][0]) return Math.min(100, Math.round(INTEGER[last][1] - INTEGER[last][0] + quality));
  for (let i = 1; i <= last; i++) if (quality <= INTEGER[i][0]) {
    const [q0, c0] = INTEGER[i - 1], [q1, c1] = INTEGER[i];
    return Math.round(c0 + (c1 - c0) * (quality - q0) / (q1 - q0));
  }
}
let WEIGHTS = null;
function lumaWeights() {
  if (WEIGHTS) return WEIGHTS;
  const nits = luma => Math.max(0, (luma / 255 + ROOT_BIAS) ** 3 - BIAS) * 255, root = v => Math.cbrt(v + BIAS);
  WEIGHTS = new Float64Array(1024);
  const edges = Float64Array.from({length: 2048}, (_, i) => i & 1 ? nits((i >> 1) + 0.5) : nits(Math.max((i >> 1) - 0.5, 0))), levels = pu21Levels(edges);
  for (let k = 0; k < 1024; k++) {
    const a = edges[2 * k], b = edges[2 * k + 1];
    WEIGHTS[k] = (root(levels[2 * k + 1]) - root(levels[2 * k])) / (root(b / 203) - root(a / 203));
  }
  return WEIGHTS;
}

export function* hdrLossySteps(data, width, height, quality, effort, samples, note) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8, space = spaceOf(samples), toSrgb = toLinearSrgb(space), mix = matrixTimes(MIX, toSrgb);
  const planes = [0, 1, 2].map(() => new Float64Array(W * H)), [X, Y, B] = planes;
  const curve = samples.exponentBits ? null : srgbLight(samples.bitDepth);
  const value = curve ? i => curve[data[i]] : samples.exponentBits === 5 ? i => half(data[i]) : i => data[i];
  const measuring = effort >= 6, measured = (measuring || width * height <= SMALL_PIXELS) && !!note;
  const nits = measured ? hdrNits(data, samples, width, height) : null;
  const target = samples.intensityTarget ?? 255, lift = target === 255 ? 1 : half(float16Bits(target)) / 255;
  let clear = false;
  for (let i = 3; i < data.length; i += 4) if (value(i) !== 1) { clear = true; break; }
  const words = clear ? (data instanceof Float32Array ? new Int32Array(data.buffer, data.byteOffset, data.length) : data) : null;
  const weights = !measuring && !clear && samples.exponentBits ? lumaWeights() : null;
  let reading = 0;
  for (let y = 0; y < height; y++) {
    const row = y * W;
    for (let x = 0, at = y * width * 4; x < width; x++, at += 4) {
      const r = value(at) * lift, g = value(at + 1) * lift, b = value(at + 2) * lift;
      const l = signedRoot(mix[0] * r + mix[1] * g + mix[2] * b + BIAS) - ROOT_BIAS;
      const m = signedRoot(mix[3] * r + mix[4] * g + mix[5] * b + BIAS) - ROOT_BIAS;
      const s = signedRoot(mix[6] * r + mix[7] * g + mix[8] * b + BIAS) - ROOT_BIAS;
      const luma = (l + m) * 127.5;
      X[row + x] = (l - m) * 127.5; Y[row + x] = luma; B[row + x] = s * 255 - luma;
      if (weights) reading += weights[luma <= 0 ? 0 : luma >= 1023 ? 1023 : Math.round(luma)];
    }
    for (const p of planes) p.fill(p[row + width - 1], row + width, row + W);
    if ((y & 63) === 63) yield 0;
  }
  for (const p of planes) for (let y = height; y < H; y++) p.copyWithin(y * W, (height - 1) * W, height * W);
  const options = {...V6, ...GABORISH, space: typeof space === 'string' ? space : 'srgb'};
  options.pre = gaborishXYB(planes, W, H, options.gaborish);
  const profile = {bitDepth: samples.bitDepth, exponentBits: samples.exponentBits, transferFunction: curve ? 'srgb' : 'linear', intensityTarget: target, ...(samples.colorEncoding ? {colorData: samples.colorData} : {colorSpace: samples.colorSpace ?? 'srgb'}), alphaPremultiplied: !!samples.alphaPremultiplied};
  const code = function* (q) {
    const candidate = yield* photoXYBSteps(OPAQUE, width, height, q, options);
    if (words) { candidate.alpha = words; candidate.alphaWords = true; }
    return candidate.components.some(({coeffs}) => coeffs.some(v => v === 32767 || v === -32768)) ? null : candidate;
  };
  const start = weights ? predictedQuality(quality, reading / (width * height))
    : curve && !measuring && !clear ? integerQuality(quality) : Math.min(100, quality + boostFor(quality));
  let image = null, quality0 = start;
  for (let q = start; !image; q -= 2) {
    image = yield* code(q);
    if (!image) { if (q - 2 < 8) break; quality0 = q - 2; }
  }
  if (!image) return null;
  if (!measured && quality0 < start) {
    const next = yield* code(quality0 + 1);
    if (next) { image = next; quality0++; }
  }
  let found = null;
  if (measured) {
    const floor = measuredLook(quality / 100), aim = measuredTarget(floor), count = width * height;
    const opacity = clear ? Float32Array.from({length: count}, (_, i) => Math.min(1, value(i * 4 + 3))) : null;
    const premultiplied = !!samples.alphaPremultiplied, references = hdrViews(nits, count, opacity, 1, premultiplied);
    const scored = function* (q, candidate) {
      yield 0;
      candidate.profile = profile;
      const views = hdrViews(reconstruct(candidate), count, opacity, 255, premultiplied);
      return {q, image: candidate, score: Math.min(...references.map((reference, k) => ssimulacra2(reference, views[k], width, height).score))};
    };
    const first = yield* scored(quality0, image);
    const limit = measuring ? 6 : 10;
    let pass = first.score >= aim ? first : null, fail = pass ? null : first, probes = 1;
    for (let q = quality0, step = 4, top = 101; !pass && probes < limit && q < 100; ) {
      const next = Math.min(100, q + step, top - 1);
      if (next <= q) break;
      const candidate = yield* code(next);
      if (!candidate) { top = next; step = Math.max(1, (next - q) >> 1); continue; }
      const probe = yield* scored(next, candidate); probes++;
      if (probe.score >= aim) pass = probe; else { fail = probe; q = next; step *= 2; }
    }
    if (pass && (measuring || fail)) {
      let low = fail ? fail.q : 0;
      while (probes < limit) {
        const q = low ? (low + pass.q) >> 1 : Math.max(7, pass.q - 12);
        if (q >= pass.q || q <= low) break;
        const candidate = yield* code(q);
        if (!candidate) { low = q; continue; }
        const probe = yield* scored(q, candidate); probes++;
        if (probe.score >= aim) pass = probe; else low = q;
      }
    }
    if (!pass) return null;
    image = pass.image;
    found = {kept: 'lossy', measurements: [{metric: 'ssimulacra2', score: pass.score, floor, domain: 'encoder-reconstruction', view: 'pu21'}]};
  }
  if (!measured && note && quality < 100) found = {kept: 'lossy', measurements: [{metric: 'ssimulacra2', domain: 'predicted', floor: qualityTarget(quality), view: 'pu21'}]};
  image.profile = profile;
  note?.(found);
  return yield* coefficientAnsSteps(image, effort);
}
const OPAQUE = new Uint8Array([0, 0, 0, 255]);

export const HDR = Object.freeze({route: hdrRoute, steps: hdrSteps, lossy: hdrLossySteps});
