// SPDX-License-Identifier: MIT
import {complete} from '../bits.mjs';
import {call, captureWindowVulnerability as windowVulnerability} from '../capture-kernels.mjs';
import {into, out} from '../kernel-call.mjs';
import {AREA_FIELD, areaFieldQuality, areaFieldValue, photoCoefficientSteps, photoQualityStep, rgbCoefficientSteps, strengthOf} from '../photo-dct.mjs';
import {gammaPicture, padPhotoCrop, photoRegionTarget} from '../photo-region-score.mjs';
import {gammaRGBA} from '../photo-output.mjs';
import {ssimulacra2} from '../ssimulacra2.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {usesRegionalCalibration} from '../photo-quality-table.mjs';
import {PAGE_MARGIN} from './page-margin.mjs';

export const LOOK_FROM = 2;
const WINDOW = 128, TILE = 64, MIN_SIDE = 16, CEILING = 99.99, DZ_WEIGHT = 0.34;
const T80 = photoRegionTarget(0.8), T_SPAN = photoRegionTarget(0.92) - T80;
const A = [3.915, -0.4208, -4.735, -0.2311, -0.8905, 0.2038, -0.4545, -0.1007, 0.4095, -0.4763, 0.3165, 0.3825, -1.892, -0.578, -0.9284, -0.6515, 0.7811, 0.331, -0.1218, 0.06389];
const B = [-3.498, -1.396, 5.082, 1.518, -0.3863, 4.248, 0.5509, -0.05204, 1.572, 3.002, 0.301, 2.772, -1.48, 3.341, 0.6632, -1.861, -0.2463, -0.07299, -3.066, 0.3209];
const C = [-2.293, 0.2993];
const S = [0.00124, 0.09529, 0.4779, -0.6039, -0.08568, -0.6865, 0.2954, 0.01341, -0.2978, -0.1045, -0.1865, 0.2955, 0.2443, -0.00411, 0.04709, 0.2193, -0.07439, 0.008145, 0.4319, -0.001283];
const Z = [3.650, 3.850];
const SIGMA_FLOOR = 0.35, EXTRA = 0.5, SPAN = 3;
const MEASURED_FROM = 4, CS_FITTED = [0.24, 0.28], LOOK_PAD = 256, MEASURED_MARGIN = 1.3, CUSHION = 0.3, MEASURE_AREA = 1 << 18, D_GRID = 16, MEASURES = 2;
const FULL_MARGIN = 0.6, SMALL_MARGIN = 2.4, FULL_AREA = 1 << 20, FULL_MEASURES = 4;
const SAFE_SLOPE = [16, 6.7], SHALLOW = [3, 2];
const SLOPE_LOW = [5.4, 3.3], SLOPE_HIGH = [20.2, 9.4];
const SA_LEVEL = [1.7037, -0.4230, -0.6715], SA_SLOPE = [4.6013, -1.2823, 0.6468, 0.7837], SA_BEND = [-1.9731, 1.0265, -0.0285], SA_Z = [3.2, 2.5];
const SA6_LEVEL = [1.073, -0.7113], SA6_SLOPE = [5.981, -1.512, 0.4204], SA6_BEND = [-1.857, 0.8394], SA6_Z = [3.0, 2.5];
const effectiveStep = q => photoQualityStep(q, 'regions') * (1 + DZ_WEIGHT * strengthOf(q));

function probeSpectrum(image, coder, gx, gy, w, h) {
  const rgb = coder === 'rgb', {stride, coeffs} = image.components[+rgb], chA = image.components[rgb ? 0 : 1]?.coeffs;
  const bx0 = gx >> 3, by0 = gy >> 3, bx1 = gx + w + 7 >> 3, rows = (gy + h + 7 >> 3) - by0, total = (bx1 - bx0) * rows;
  const scan = c => call(k => k.probeSpectrum, [into(Int16Array, c.subarray(by0 * stride * 64), rows * stride * 64), stride, bx0, bx1, rows,
    out(Uint32Array, total), out(Int32Array, 5)]);
  const [, sums, [n1, nzLuma, nLow, nHigh, activeBlocks]] = scan(coeffs);
  let c1 = 0, cNz = 0;
  if (chA) for (const c of [chA, image.components[2].coeffs]) { const [one, nz] = scan(c)[2]; c1 += one; cNz += nz; }
  sums.sort();
  return {
    f1: (n1 + 0.5 * c1) / (nzLuma + 0.5 * cNz + 8),
    hf: nHigh / (nLow + nHigh + 4),
    cs: cNz / (nzLuma + cNz + 8),
    activeFrac: activeBlocks / Math.max(1, total),
    nzAct: nzLuma / Math.max(1, activeBlocks),
    skew: Math.min(4, Math.max(0, sums[Math.min(total - 1, Math.floor(total * 0.9))] / (sums[total >> 1] + 6) - 1.5)),
  };
}

function cut(data, width, height, r, exactRects) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const clipW = Math.min(width, r.x + r.width) - x0, clipH = Math.min(height, r.y + r.height) - y0;
  if (clipW <= 0 || clipH <= 0) return null;
  const overlaps = exactRects?.filter(e => e.x < x0 + clipW && e.x + e.width > x0 && e.y < y0 + clipH && e.y + e.height > y0);
  const activeOverlaps = overlaps?.length ? overlaps : null;
  let x = x0, y = y0, w = clipW, h = clipH;
  if (w > WINDOW || h > WINDOW) {
    const ww = Math.min(w, WINDOW), wh = Math.min(h, WINDOW);
    const maxDx = (w - ww) & ~7, maxDy = (h - wh) & ~7;
    x = x0 + (w > WINDOW ? (w - WINDOW) >> 4 << 3 : 0);
    y = y0 + (h > WINDOW ? (h - WINDOW) >> 4 << 3 : 0);
    const nx = maxDx >= 8 ? Math.min(4, (maxDx >> 3) + 1) : 1, ny = maxDy >= 8 ? Math.min(4, (maxDy >> 3) + 1) : 1;
    if (nx * ny > 1) {
      const center = windowVulnerability(data, width, x, y, ww, wh, activeOverlaps);
      let bestHits = center.hits, bestV = center.sum, bx = x, by = y;
      for (let iy = 0; iy < ny; iy++) {
        const cy = y0 + (ny > 1 ? Math.round(iy * (maxDy >> 3) / (ny - 1)) * 8 : 0);
        for (let ix = 0; ix < nx; ix++) {
          const cx = x0 + (nx > 1 ? Math.round(ix * (maxDx >> 3) / (nx - 1)) * 8 : 0);
          const cand = windowVulnerability(data, width, cx, cy, ww, wh, activeOverlaps);
          if (cand.hits < bestHits || cand.hits === bestHits && cand.sum > bestV) {
            bestHits = cand.hits; bestV = cand.sum; bx = cx; by = cy;
          }
        }
      }
      if (bestHits < center.hits || bestV > center.sum * 1.12) { x = bx; y = by; }
    }
    w = ww; h = wh;
  }
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) out.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
  const windowOverlaps = activeOverlaps?.filter(e => e.x < x + w && e.x + e.width > x && e.y < y + h && e.y + e.height > y) ?? null;
  return {pixels: out, x, y, width: w, height: h, full: w === clipW && h === clipH, replacing: windowOverlaps?.length ? windowOverlaps : null};
}

export function photoWindow(data, width, height, r = {x: 0, y: 0, width, height}, dx = 0, dy = 0, vulnerable = true, side = WINDOW) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), w = Math.min(width, r.x + r.width) - x0, h = Math.min(height, r.y + r.height) - y0;
  if (w <= side || h <= side) return null;
  const n = side / TILE, out = new Uint8Array(side * side * 4);
  const at = (o, span, i, d, f = 0.5) => Math.min(o + span - TILE, Math.max(o, ((o + Math.round((span - TILE) * (i + f) / n) + d + 4) & ~7) - d));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let tx = at(x0, w, i, dx), ty = at(y0, h, j, dy);
    if (vulnerable) {
      let most = -1;
      for (const fy of SPOTS) for (const fx of SPOTS) {
        const cx = at(x0, w, i, dx, fx), cy = at(y0, h, j, dy, fy), v = windowVulnerability(data, width, cx, cy, TILE, TILE, null).sum;
        if (v > most) { most = v; tx = cx; ty = cy; }
      }
    }
    for (let y = 0; y < TILE; y++) out.set(data.subarray(((ty + y) * width + tx) * 4, ((ty + y) * width + tx + TILE) * 4), ((j * TILE + y) * side + i * TILE) * 4);
  }
  return {pixels: out, x: x0, y: y0, width: side, height: side, full: false, mosaic: true, replacing: null};
}
const SPOTS = [0.1, 0.5, 0.9];

function frameDescriptor(frame) {
  return frame && (frame.coder === 'rgb' || frame.coder === 'ycbcr') && Number.isFinite(frame.frameQuality) ? frame : null;
}

function codedCrop(crop, data, pageW, pageH, reading, colorSpace, frame) {
  const {pixels, width: w, height: h} = crop;
  if (!frame) return {image: complete(photoCoefficientSteps(pixels, w, h, reading, colorSpace, false, true, null)), pixels, w, h, gx: 0, gy: 0, ox: crop.x, oy: crop.y};
  if (crop.mosaic) return {image: frameImage(pixels, w, h, 0, 0, w, h, reading, colorSpace, frame), pixels, w, h, gx: 0, gy: 0, ox: crop.x, oy: crop.y};
  const dx = frame.dx ?? 0, dy = frame.dy ?? 0;
  let bx0 = (crop.x + dx) >> 3, by0 = (crop.y + dy) >> 3;
  let bx1 = (crop.x + dx + w + 7) >> 3, by1 = (crop.y + dy + h + 7) >> 3;
  if (crop.full) { bx0 = bx0 >> 3 << 3; by0 = by0 >> 3 << 3; bx1 = Math.min((pageW + dx + 7) >> 3, (bx1 + 7) >> 3 << 3); by1 = Math.min((pageH + dy + 7) >> 3, (by1 + 7) >> 3 << 3); }
  const gx = crop.x + dx - bx0 * 8, gy = crop.y + dy - by0 * 8;
  const pw = (bx1 - bx0) * 8, ph = (by1 - by0) * 8;
  const ox = bx0 * 8 - dx, oy = by0 * 8 - dy;
  let src = pixels;
  if (gx || gy || pw !== w || ph !== h || crop.replacing) {
    src = new Uint8Array(pw * ph * 4);
    for (let y = 0; y < ph; y++) {
      const sy = Math.max(0, Math.min(pageH - 1, oy + y)) * pageW, dyRow = y * pw * 4;
      if (ox >= 0 && ox + pw <= pageW) src.set(data.subarray((sy + ox) * 4, (sy + ox + pw) * 4), dyRow);
      else for (let x = 0; x < pw; x++) {
        const sx = (sy + Math.max(0, Math.min(pageW - 1, ox + x))) * 4;
        src[dyRow + x * 4] = data[sx]; src[dyRow + x * 4 + 1] = data[sx + 1];
        src[dyRow + x * 4 + 2] = data[sx + 2]; src[dyRow + x * 4 + 3] = data[sx + 3];
      }
    }
    if (crop.replacing) for (const e of crop.replacing) {
      const ex0 = Math.max(0, e.x - ox), ex1 = Math.min(pw, e.x + e.width - ox);
      const ey0 = Math.max(0, e.y - oy), ey1 = Math.min(ph, e.y + e.height - oy);
      if (ex0 >= ex1 || ey0 >= ey1) continue;
      for (let y = ey0; y < ey1; y++) {
        const l = (y * pw + Math.max(0, ex0 - 1)) * 4, r = (y * pw + Math.min(pw - 1, ex1)) * 4;
        const span = Math.max(1, ex1 - ex0 + 1);
        for (let x = ex0; x < ex1; x++) {
          const t = (x - ex0 + 1) / span, at = (y * pw + x) * 4;
          for (let c = 0; c < 3; c++) src[at + c] = Math.round(src[l + c] + (src[r + c] - src[l + c]) * t);
        }
      }
    }
  }
  return {image: frameImage(src, pw, ph, gx, gy, w, h, reading, colorSpace, frame, crop.full), pixels: src, w: pw, h: ph, gx, gy, ox, oy};
}

function frameImage(src, pw, ph, gx, gy, w, h, reading, colorSpace, frame, tiled = false) {
  const snap = reading > frame.frameQuality, x0 = gx & ~7, y0 = gy & ~7;
  const area = !tiled ? snap ? {x: 0, y: 0, width: pw, height: ph} : {x: gx, y: gy, width: w, height: h}
    : snap ? {x: x0, y: y0, width: ((gx + w + 7) & ~7) - x0, height: ((gy + h + 7) & ~7) - y0} : {x: gx, y: gy, width: w, height: h};
  const areas = frame.frameQuality === reading ? null : [{...area, quality: reading}];
  return frame.coder === 'ycbcr'
    ? complete(photoCoefficientSteps(src, pw, ph, frame.frameQuality, colorSpace, false, true, areas))
    : complete(rgbCoefficientSteps(src, pw, ph, frame.frameQuality, colorSpace, areas));
}

function subCrop(rgba, pw, gx, gy, w, h) {
  if (!gx && !gy && rgba.length === w * h * 4) return rgba;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(((gy + y) * pw + gx) * 4, ((gy + y) * pw + gx + w) * 4), y * w * 4);
  return out;
}

function scoredCrop(crop, data, width, pageH, quality, colorSpace, frame, pad) {
  const {pixels, width: w, height: h} = crop;
  const refPad = padPhotoCrop(pixels, w, h, pad);
  const c = codedCrop(crop, data, width, pageH, quality, colorSpace, frame);
  const gamma = gammaPicture(c.image, {reference: c.pixels, exact: null, pixels: c.pixels, mask: false});
  if (crop.replacing) for (const e of crop.replacing) {
    const ex0 = Math.max(0, e.x - c.ox), ex1 = Math.min(c.w, e.x + e.width - c.ox);
    const ey0 = Math.max(0, e.y - c.oy), ey1 = Math.min(c.h, e.y + e.height - c.oy);
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
      const sx = Math.max(0, Math.min(width - 1, c.ox + x)), sy = Math.max(0, Math.min(pageH - 1, c.oy + y));
      const from = (sy * width + sx) * 4, into = y * c.w + x;
      for (let ch = 0; ch < 3; ch++) gamma[ch][into] = data[from + ch] / 255;
    }
  }
  const pkgCrop = padPhotoCrop(subCrop(gammaRGBA(gamma, c.w, c.h), c.w, c.gx, c.gy, w, h), w, h, pad);
  return {c, m: ssimulacra2({rgba: refPad.rgba}, {rgba: pkgCrop.rgba}, refPad.width, refPad.height)};
}

function wholeCrop(data, width, pageH, r, exactRects) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(width, r.x + r.width) - x, h = Math.min(pageH, r.y + r.height) - y;
  const pixels = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) pixels.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
  const replacing = exactRects?.filter(e => e.x < x + w && e.x + e.width > x && e.y < y + h && e.y + e.height > y);
  return {pixels, x, y, width: w, height: h, full: true, replacing: replacing?.length ? replacing : null};
}

function measuredLanding(need, reading, frame, from, measure, [steep, shallow], measures) {
  const steps = [];
  if (frame) {
    const fq = frame.frameQuality, base = photoQualityStep(fq, 'regions');
    const v0 = reading === fq ? AREA_FIELD : areaFieldValue(base, reading, 'regions', AREA_FIELD);
    const vLo = Math.max(1, Math.ceil(v0 / SPAN)), vHi = Math.max(vLo, Math.min(8 * AREA_FIELD, areaFieldValue(base, CEILING, 'regions', AREA_FIELD), Math.floor(v0 * SPAN)));
    for (let v = vLo; v <= vHi; v++) steps.push({d: Math.log2(v / v0), quality: v === AREA_FIELD ? fq : Math.min(CEILING, areaFieldQuality(base, v, 'regions', AREA_FIELD))});
  } else {
    const n = Math.ceil(Math.log2(SPAN) * D_GRID), step = effectiveStep(reading);
    for (let i = -n; i <= n; i++) steps.push({d: i / D_GRID, quality: i === 0 ? reading : quality(step * Math.pow(2, -i / D_GRID))});
  }
  const index = d => { const i = steps.findIndex(x => x.d >= d - 1e-9); return i < 0 ? steps.length - 1 : i; };
  const seen = new Map(), aim = need + CUSHION;
  const bracket = () => {
    const all = [...seen].sort((a, b) => a[0] - b[0]), clear = all.find(([, v]) => v >= need);
    return {all, clear, miss: clear ? all.filter(([i]) => i < clear[0]).pop() : all[all.length - 1]};
  };
  let next = index(from);
  for (let k = 0; k < measures && !seen.has(next); k++) {
    seen.set(next, measure(steps[next].quality));
    const {all, clear, miss} = bracket();
    if (clear && (clear[0] === 0 || miss && clear[0] - miss[0] <= 1) || !clear && miss[0] === steps.length - 1) break;
    if (clear && miss) {
      const per = (clear[1] - miss[1]) / (steps[clear[0]].d - steps[miss[0]].d);
      next = Math.max(miss[0] + 1, Math.min(clear[0] - 1, index(steps[miss[0]].d + (aim - miss[1]) / Math.max(per, 1e-6))));
    } else {
      const near = [...all].sort((a, b) => Math.abs(a[1] - aim) - Math.abs(b[1] - aim)), [i0, v0] = near[0];
      const per = near.length > 1 ? (near[0][1] - near[1][1]) / (steps[near[0][0]].d - steps[near[1][0]].d) : 0;
      next = index(steps[i0].d + (aim - v0) / (per > 0 ? Math.min(steep, Math.max(shallow, per)) : clear ? steep : shallow));
      if (next === i0 && v0 >= aim && i0 > 0) next = i0 - 1;
    }
  }
  const {all, clear} = bracket();
  if (clear) return steps[clear[0]].quality;
  const [fine, value] = all[all.length - 1];
  return steps[index(steps[fine].d + (need - value) / shallow)].quality;
}

function facts(q, t, f, s0, target, side, area, sR, full, octaves, mosaicked, coder, sum0, effort) {
  const mo = mosaicked ? 1 : 0;
  return [1, t, f.f1, f.hf, f.cs, f.activeFrac, Math.min(f.nzAct, 60) / 30, f.skew, full ? 1 : 0, octaves / 4,
    Math.log2(Math.max(side, 16) / 128), Math.min(sum0, 3), (s0 - target) / 5, sR, mo, mo * Math.log2(Math.max(area, 1) / 16384) / 4, mo * t,
    coder === 'ycbcr' ? 1 : 0, coder === 'standalone' ? 1 : 0, effort >= 4 ? 1 : 0];
}
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };

function lookReading(q, data, width, rect, reading, colorSpace = 'srgb', frame = null, {measureLarge = true, measured = false, onProbe = null, effort = 3, pageMargin = false, full = false, effortOne = null, offGrid = false} = {}) {
  frame = frameDescriptor(frame);
  if (q >= 1 || reading >= 100 || !measureLarge) return reading;
  const subject = rect.subject ?? rect;
  const side = Math.min(subject.width, subject.height);
  if (side < MIN_SIDE) return reading;
  const pageH = data.length / 4 / width;
  const dx = frame ? frame.dx ?? 0 : (8 - (Math.max(0, subject.x) & 7)) & 7, dy = frame ? frame.dy ?? 0 : (8 - (Math.max(0, subject.y) & 7)) & 7;
  const six = !frame && effort >= MEASURED_EFFORT;
  const crop = (!six && photoWindow(data, width, pageH, subject, dx, dy, !frame)) || cut(data, width, pageH, subject, frame?.exactRects);
  if (!crop || Math.min(crop.width, crop.height) < MIN_SIDE) return reading;
  const {pixels, width: w, height: h} = crop;
  const octaves = crop.full ? 0 : Math.log2(Math.max(1, subject.width * subject.height / (w * h)));
  const target = photoRegionTarget(q, side, measured);
  const tq = (photoRegionTarget(q, undefined, measured) - T80) / T_SPAN, t = Math.max(0, Math.min(1, tq)), u = Math.max(-1, Math.min(1, tq));
  const coder = frame ? frame.coder : 'standalone';
  const {c, m: m0} = scoredCrop(crop, data, width, pageH, reading, colorSpace, frame, WINDOW);
  const spectrum = probeSpectrum(c.image, coder, c.gx, c.gy, w, h), s0 = m0?.score;
  if (s0 === undefined || !Number.isFinite(s0)) return reading;
  onProbe?.(crop.full ? 'full' : 'window');
  const fq = frame?.frameQuality, base = frame ? photoQualityStep(fq, 'regions') : 0;
  const qOfV = v => v === AREA_FIELD ? fq : Math.min(CEILING, areaFieldQuality(base, v, 'regions', AREA_FIELD));
  const v0 = frame ? (reading === fq ? AREA_FIELD : areaFieldValue(base, reading, 'regions', AREA_FIELD)) : 0;
  const sR = strengthOf(frame ? qOfV(v0) : reading);
  const x = facts(q, t, spectrum, s0, target, side, subject.width * subject.height, sR, crop.full, octaves, crop.mosaic, coder, m0.sum, effort);
  const offset = dot(x, A) + (frame ? 0 : six ? SA6_LEVEL[0] + SA6_LEVEL[1] * t : SA_LEVEL[0] + SA_LEVEL[1] * u + SA_LEVEL[2] * u * u);
  const bend = frame ? C[0] + C[1] * t : six ? SA6_BEND[0] + SA6_BEND[1] * t : SA_BEND[0] + SA_BEND[1] * u + SA_BEND[2] * u * u;
  const slope = frame
    ? Math.min(SLOPE_HIGH[0] + (SLOPE_HIGH[1] - SLOPE_HIGH[0]) * t, Math.max(SLOPE_LOW[0] + (SLOPE_LOW[1] - SLOPE_LOW[0]) * t, dot(x, B)))
    : six ? SA6_SLOPE[0] + SA6_SLOPE[1] * t + SA6_SLOPE[2] * dot(x, B) : SA_SLOPE[0] + SA_SLOPE[1] * u + SA_SLOPE[2] * dot(x, B) + SA_SLOPE[3] * u * u;
  const z = frame || six && pageMargin ? Z : six ? SA6_Z : SA_Z, zt = frame || six ? t : Math.max(0, u);
  const monoGuard = usesRegionalCalibration(q) && spectrum.cs < 0.035 && q < 0.86 ? 2.8 * (0.86 - q) / 0.16 : 0;
  const margin = (z[0] + (z[1] - z[0]) * zt) * Math.max(SIGMA_FLOOR, Math.exp(dot(x, S)) - 0.25) + EXTRA + monoGuard;
  const top = bend < 0 ? -slope / (2 * bend) : Infinity;
  const clears = d => { const e = Math.min(d, top); return s0 + offset + e * slope + e * e * bend >= target + margin; };
  const [landed, d] = (() => {
    if (frame) {
      const maxV = Math.min(8 * AREA_FIELD, areaFieldValue(base, CEILING, 'regions', AREA_FIELD), Math.floor(v0 * SPAN));
      for (let v = Math.max(1, Math.ceil(v0 / SPAN)); v <= maxV; v++) if (clears(Math.log2(v / v0))) return [qOfV(v), Math.log2(v / v0)];
      return [qOfV(Math.max(v0, maxV)), Math.log2(Math.max(v0, maxV) / v0)];
    }
    let lo = -Math.log2(SPAN), hi = Math.log2(SPAN);
    if (!clears(hi)) return [Math.min(CEILING, Math.max(reading, quality(effectiveStep(reading) / SPAN))), Math.log2(SPAN)];
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) * 0.5; if (clears(mid)) hi = mid; else lo = mid; }
    return [quality(effectiveStep(reading) * Math.pow(2, -hi)), hi];
  })();
  const area = subject.width * subject.height;
  if (!measured && !full && effort < MEASURED_FROM && effortOne && area <= MEASURE_AREA &&
      spectrum.cs > CS_FITTED[0] + (CS_FITTED[1] - CS_FITTED[0]) * t) {
    const low = effortOne(data, width, rect, offGrid, colorSpace);
    const first = frame ? qOfV(areaFieldValue(base, low, 'regions', AREA_FIELD))
      : quality(effectiveStep(reading) * Math.pow(2, -Math.ceil(Math.log2(effectiveStep(reading) / effectiveStep(low)) * D_GRID) / D_GRID));
    const finer = frame ? areaFieldValue(base, landed, 'regions', AREA_FIELD) > areaFieldValue(base, first, 'regions', AREA_FIELD) : landed > first;
    if (finer && low < reading && landed <= reading) return first;
  }
  if (!measured && effort < MEASURED_EFFORT && (full ? area <= FULL_AREA
    : effort >= MEASURED_FROM && spectrum.cs > CS_FITTED[0] + (CS_FITTED[1] - CS_FITTED[0]) * t && area <= MEASURE_AREA)) {
    const whole = wholeCrop(data, width, pageH, subject, frame?.exactRects);
    const at = ([a, b]) => a + (b - a) * t;
    return measuredLanding(target + (!full ? MEASURED_MARGIN : frame && side < WINDOW ? SMALL_MARGIN : FULL_MARGIN), reading, frame, d,
      quality => scoredCrop(whole, data, width, pageH, quality, colorSpace, frame, LOOK_PAD).m?.score ?? -Infinity, [at(SAFE_SLOPE), at(SHALLOW)],
      full ? FULL_MEASURES : MEASURES);
  }
  return landed;
}

function quality(want) {
  let lo = 1, hi = CEILING;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (effectiveStep(mid) <= want) hi = mid; else lo = mid;
  }
  return hi;
}

export function lookingReader(q, read, flags = {}) {
  const byData = new WeakMap();
  return (data, width, rect, offGrid, colorSpace, ...more) => {
    let probe = null, pageMargin = false;
    const rest = more.filter(m => {
      if (m === PAGE_MARGIN) { pageMargin = true; return false; }
      if (m && typeof m === 'object' && typeof m.onProbe === 'function') { probe = m.onProbe; return false; }
      return true;
    });
    const frame = frameDescriptor(rest.find(frameDescriptor));
    const reading = read(data, width, rect, offGrid, colorSpace, ...rest);
    let seen = byData.get(data);
    if (!seen) byData.set(data, seen = new Map());
    const phase = frame ? `${(rect.x + (frame.dx ?? 0)) & 7}:${(rect.y + (frame.dy ?? 0)) & 7}:${frame.exactRects?.length ?? 0}` : '';
    const sub = rect.subject ? `:${rect.subject.x},${rect.subject.y},${rect.subject.width},${rect.subject.height}` : '';
    const key = `${width},${rect.x},${rect.y},${rect.width},${rect.height}${sub},${offGrid === true},${colorSpace ?? 'srgb'},${reading},${frame ? `${frame.coder}:${frame.frameQuality}:${phase}` : ''},${pageMargin}`;
    let entry = seen.get(key);
    if (!entry) {
      let kind = null;
      const quality = lookReading(q, data, width, rect, reading, colorSpace, frame, {...flags, pageMargin, offGrid: offGrid === true, onProbe(k) { kind = k; }});
      seen.set(key, entry = {quality, kind});
    }
    probe?.(entry.kind);
    return entry.quality;
  };
}
