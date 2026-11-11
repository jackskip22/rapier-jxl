// SPDX-License-Identifier: MIT
import {cpuMeasure} from './photo-measure.mjs';
import {materialize} from './varblock-core.mjs';
import {reconstruct, reconstructYCbCr, toRGBA} from './reconstruct.mjs';
import {bandedRGBA, bandedOutputs, exactScores, deviceBandedScores, subImage, RECON_MARGIN, BAND_ROWS} from './photo-reconstruct-bands.mjs';
import {rebuildable, rebuildPicture} from './photo-rebuild.mjs';
import {linearFromRGBA} from './ssimulacra2.mjs';
import {linearFromTransformPlanes} from './color-transform.mjs';
import {photoReference} from './photo-reference.mjs';
import {nativeRGBA, nativeGammaRGBA, nativeTables, nativeByte} from './photo-output.mjs';
const NATIVE = {nativeTables, nativeByte};
import {rebuildKernels} from './rebuild-kernels.mjs';
import {xybKernelConstants} from './vardct-render.mjs';
import {DEFAULT_OPSIN} from './opsin.mjs';
import {gaussianCoefficients, s2DeviceTables, bandsAtSpeed} from './ssimulacra2-arithmetic.mjs';
import {GAUSS} from './ssimulacra2-constants.mjs';
import {s2Interval} from './gpu-s2-score.mjs';
import {s2Stream} from './photo-s2-stream.mjs';
import {journaling, carried, unit, readAll, PASSED} from './step-journal.mjs';
import {s2CellStream, s2CellMap} from './s2-cells.mjs';
import {memoryPlan} from './memory-plan.mjs';

const check = signal => { if (signal?.aborted) throw signal.reason; };
const ROWS = 256, STEP = 512;

function selectedYCbCrRGBA(image, color, signal, native = false) {
  if (!native && !color.transform && rebuildable(image)) return bandedRGBA(image, ROWS);
  const {width, height} = image, stride = image.components[0].stride, rows = image.components[0].rows;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += ROWS) {
    check(signal);
    const sub = subImage(image, 0, y / 8, stride, Math.min(rows, (y + ROWS) / 8));
    const gamma = color.transform || native ? reconstructYCbCr(sub, {planes: true}) : null;
    const rgba = color.transform ? (native ? nativeRGBA : toRGBA)(linearFromTransformPlanes(gamma,
      sub.width * sub.height, color.transform), sub.width, sub.height, {y})
      : native ? nativeGammaRGBA(gamma, sub.width, sub.height, {y}) : reconstructYCbCr(sub);
    out.set(rgba, y * width * 4);
  }
  return out;
}

const s2Scores = (lo, hi) => ({ssimulacra2: (lo + hi) / 2, doubt: {ssimulacra2: (hi - lo) / 2 * (1 + 1e-12) + 1e-12}});

export function wholeRebuildMeasure(data, width, height, color, signal, plan) {
  const reference = color.transform ? () => photoReference(data, width, height, color.transform) : null;
  const nativeBand = (linear, from, count, out, at, y = at / width) => out.set(nativeRGBA(
    linear.map(p => p.subarray(from, from + count)), width, count / width, {y}), at * 4);
  const cacheBytes = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, width * height * 64));
  let cpu = null, device = null, constants = null, s2Tables = null, audits = 0, refused = false, baLooks = 0, baNone = false;
  const rebuildHeld = {}, s2Held = {}, s2Ok = !color.transform && width >= 8 && height >= 8 && ArrayBuffer.isView(data) && data.BYTES_PER_ELEMENT === 1;
  let s2Checked = false, s2Refused = false;
  const auditRows = () => {
    const g0 = (audits++ * 7919 % Math.ceil(height / 64)) * 64, g1 = Math.min(height, g0 + 64), y0 = g0 + 24 < g1 ? g0 + 24 : g0;
    return [y0, Math.min(g1, y0 + 16)];
  };
  const expect = (image, [y0, y1]) => {
    const stride = image.components[0].stride, blockRows = image.components[0].rows;
    const by0 = Math.max(0, Math.floor((y0 - RECON_MARGIN) / 64) * 8), by1 = Math.min(blockRows, Math.ceil((y1 + RECON_MARGIN) / 64) * 8);
    const made = rebuildPicture(subImage(image, 0, by0, stride, by1), {rgba: true, linear: true}), skip = (y0 - by0 * 8) * width, count = (y1 - y0) * width;
    return {y0, skip, count, rgba: made.rgba, own: nativeRGBA(made.linear.map(p => p.subarray(skip, skip + count)), width, y1 - y0, {y: y0})};
  };
  const audit = (pictures, {y0, skip, count, rgba: made, own}) => {
    const at = pictures.band ? 0 : y0 * width * 4, rgba = pictures.band?.rgba ?? pictures.rgba, native = pictures.band?.native ?? pictures.native;
    for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++)
      if (made[(skip + i) * 4 + c] !== rgba[at + i * 4 + c] || own[i * 4 + c] !== native[at + i * 4 + c]) return Infinity;
    return 0;
  };
  const reconstruction = () => cpu ??= cpuMeasure(data, width, height, {native: true, immutable: true, maps: 's2', reference, cacheBytes,
    reconstruct: image => image.ycbcr ? linearFromRGBA(selectedYCbCrRGBA(image, color, signal), width * height)
      : reconstruct(materialize(image)),
    bandedRGBA: image => image.ycbcr ? selectedYCbCrRGBA(image, color, signal) : bandedRGBA(image, ROWS),
    streamedScores(image) {
      if (device || image.ycbcr || color.transform || width < 8 || height < 8 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
        || !bandsAtSpeed() || width * height * 36 <= cacheBytes) return null;
      const stream = s2Stream({rgba: data}, width, height, 2);
      try {
        bandedOutputs(image, ROWS, nativeBand, (y0, rows, pack, own) => { check(signal); stream.push(y0, rows, [pack, own]); });
        const [pack, own] = stream.finish();
        return {package: pack, native: own, minimum: Math.min(pack, own)};
      } finally { stream.release(); }
    },
    *rgbaOutputs(image, {linear, banded}) {
      if (device) {
        yield {kind: 'package', rgba: device.rgba};
        yield {kind: 'native', rgba: device.native};
        return;
      }
      if (image.ycbcr) {
        yield {kind: 'package', rgba: selectedYCbCrRGBA(image, color, signal)};
        yield {kind: 'native', rgba: selectedYCbCrRGBA(image, color, signal, true)};
      } else if (banded) {
        const outputs = bandedOutputs(image, ROWS, nativeBand);
        yield {kind: 'package', rgba: outputs.package};
        yield {kind: 'native', rgba: outputs.native};
      } else {
        yield {kind: 'package', rgba: toRGBA(linear, width, height)};
        yield {kind: 'native', rgba: nativeRGBA(linear, width, height)};
      }
    },
  });
  const cpuScores = (image, want) => image.coefficientRows || image.ycbcr ? reconstruction().banded(image, {...want, butteraugli: false})
    : exactScores(reconstruction(), null, width, height, image, want, plan);
  const baScores = function* (image, want) {
    let s2 = null;
    const ba = yield* deviceBandedScores({rgba: data}, width, height, image, {...want, rows: Math.max(plan.bandRows ?? BAND_ROWS, 256)}, baLooks++,
      () => { refused = true; }, baLooks > 1 ? () => s2 = cpuScores(image, {...want, butteraugli: false}) : null);
    if (!ba) {
      if (refused) yield {gpu: {kind: 'refuse'}}; else if (baLooks === 1) baNone = true;
      return cpuScores(image, want);
    }
    const {during, ...scores} = ba;
    return {...(s2 ?? cpuScores(image, {...want, butteraugli: false})), ...scores};
  };
  const baDevice = (image, want) => !refused && !baNone && !image.ycbcr && !image.coefficientRows && !color.transform
    && width >= 8 && height >= 8 && ArrayBuffer.isView(data) && want?.butteraugli === true;
  const streamsInJournal = (image, want) => !refused && !image.ycbcr && !color.transform && !!want?.ssimulacra2 && !want.butteraugli &&
    want.p === undefined && want.margin === undefined && width >= 8 && height >= 8 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
    (plan ?? memoryPlan(width * height, {width, height})).banded && bandsAtSpeed() && width * height * 36 > cacheBytes;
  function* streamedSteps(image) {
    let stream = null, place = null;
    try {
      for (let y0 = 0; y0 < height; y0 += STEP) {
        const saved = yield* carried('score-band', () => {
          if (!stream) { stream = s2Stream({rgba: data}, width, height, 2, true); if (place) stream.restore(place); }
          if (stream.rows !== y0) throw new Error('A scored band is out of order.');
          bandedOutputs(image, STEP, nativeBand, (y, rows, pack, own) => { check(signal); stream.push(y, rows, [pack, own]); }, y0, y0 + STEP);
          return stream.save();
        });
        if (saved !== PASSED && !stream) place = saved;
      }
      if (!stream) { stream = s2Stream({rgba: data}, width, height, 2, true); stream.restore(place); }
      const [pack, own] = stream.finish();
      return {ssimulacra2: Math.min(pack, own), nativeScores: {package: pack, native: own, minimum: Math.min(pack, own)}};
    } finally { stream?.release(); }
  }
  const mapsInJournal = (image, want) => !image.ycbcr && !color.transform && (want?.p !== undefined || want?.margin !== undefined) &&
    !want.ssimulacra2 && !want.butteraugli && width >= 8 && height >= 8 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
    (plan ?? memoryPlan(width * height, {width, height})).banded;
  function* mapSteps(image) {
    let stream = null, place = null;
    const parts = [], open = () => { stream = s2CellStream({rgba: data}, width, height); if (place) stream.restore(place); };
    for (let y0 = 0; y0 < height; y0 += ROWS) {
      parts.push(yield* unit('map-band', () => {
        if (!stream) open();
        check(signal);
        return stream.push(y0, Math.min(ROWS, height - y0), bandedRGBA(image, ROWS, undefined, y0, y0 + ROWS));
      }, undefined, false, true));
      const saved = yield* carried('map-place', () => stream.save(), undefined, true);
      if (saved !== PASSED && !stream) place = saved;
    }
    readAll(parts.flatMap(part => part.flatMap(({sums}) => sums)));
    if (!stream) open();
    const {cells} = s2CellMap(stream.finish(parts), width, height);
    return {cells, blocks: cells.slice()};
  }
  return {
    *measureSteps(image, want) {
      if (journaling() && streamsInJournal(image, want)) return yield* streamedSteps(image);
      if (journaling() && mapsInJournal(image, want)) return yield* mapSteps(image);
      const value = this.measure(image, want);
      return typeof value?.next === 'function' ? yield* value : value;
    },
    measure: (image, want) => refused || image.ycbcr || color.transform || !want?.ssimulacra2 || want.butteraugli || want.p !== undefined || want.margin !== undefined
      ? (baDevice(image, want) ? baScores(image, want) : cpuScores(image, want)) : (function* () {
        const kernels = rebuildKernels();
        constants ??= xybKernelConstants(DEFAULT_OPSIN.inverseMatrix.map(Math.fround), DEFAULT_OPSIN.opsinBiases, 255);
        const s2 = (want.doubt || !s2Checked) && s2Ok && !s2Refused ? {held: s2Held, tables: s2Tables ??= s2DeviceTables(gaussianCoefficients(GAUSS)), reference: data, width, height} : null;
        const rows = auditRows(), keep = !!(want.doubt && s2 && s2Checked);
        let submitted;
        const request = {kind: 'photo-rebuild', image, rebuild: rebuildPicture, kernels, constants, native: NATIVE,
          held: rebuildHeld, band: rows, keep, ...(s2 && {s2}), submitted: new Promise(done => { submitted = done; })};
        request.onSubmit = submitted;
        const pending = yield {gpu: request, later: true};
        if (!pending) return cpuScores(image, want);
        const answer = Promise.resolve(pending);
        yield {await: Promise.race([request.submitted, answer.then(() => {}, () => {})])};
        const expected = expect(image, rows);
        let pictures = yield {await: answer};
        if (!pictures?.rgba && !pictures?.px) return cpuScores(image, want);
        if (!(audit(pictures, expected) <= 1)) { refused = true; yield {gpu: {kind: 'refuse'}}; return cpuScores(image, want); }
        const range = (answer, o) => answer && !answer.flagged && answer.sums[o] ? s2Interval(answer.sums[o], answer.sizes) : null;
        let scores = null;
        if (s2) {
          const ranges = [0, 1].map(o => range(pictures.s2, o));
          if (ranges.every(Boolean)) scores = s2Scores(Math.min(...ranges.map(r => r[0])), Math.min(...ranges.map(r => r[1])));
        }
        if (scores && want.doubt && s2Checked) return scores;
        if (!pictures.rgba) pictures = yield {await: pictures.readAll()};
        device = pictures;
        try {
          const exact = cpuScores(image, want);
          if (scores) {
            s2Checked = true;
            if (!(Math.abs(exact.ssimulacra2 - scores.ssimulacra2) <= scores.doubt.ssimulacra2)) s2Refused = true;
          }
          return exact;
        } finally { device = null; }
      })(),
    destroy() { cpu?.destroy(); cpu = null; s2Held.state?.release(); rebuildHeld.release?.(); },
  };
}
