// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {reconstructYCbCr} from './reconstruct-planes.mjs';
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {askedLook} from './photo-quality-table.mjs';
import {fillHoles} from './screen-photo-mask.mjs';
import {gradientRegions, gradientProtectionRects} from './screen-gradient-regions.mjs';
import {screenPhotoRegions, photoCells, photoCellText} from './screen-photo-regions.mjs';
import {tilesFit} from './screen.mjs';
import {findText} from './v7/letters-found.mjs';
import {photoTextLayers} from './photo-text-layers.mjs';
import {CAPTURE_TOOLS_LEAN} from './capture-codec.mjs';

const TILE = 32, MIN_FREE = 4096, MARGIN = 1.25, RECON_GUARD = 0.35;

export function lowColourFloor(data, width, height) {
  if (!gradientRegions(data, width, height).length) return false;
  const cells = photoCells(data, width, height), text = photoCellText(cells, 0, 0, cells.cols - 1, cells.rows - 1);
  let marked = 0;
  for (const cell of text) marked += cell === 1;
  return marked * 4 >= text.length && tilesFit(data, width, height);
}

function smoothBlockStats(filled, width, height) {
  const cols = width >> 3, rows = height >> 3, stride = width * 4;
  let b1d = 0, b2d = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    let mx = 0, my = 0, ok = 1;
    for (let y = by * 8; ok && y < by * 8 + 8; y++) {
      let i = (y * width + bx * 8) * 4;
      for (let x = 0; x < 8; x++, i += 4) {
        if (x < 7) {
          const a = Math.abs(filled[i] - filled[i + 4]), b = Math.abs(filled[i + 1] - filled[i + 5]), c = Math.abs(filled[i + 2] - filled[i + 6]);
          if (a > 10 || b > 10 || c > 10) { ok = 0; break; }
          if (a | b | c) mx++;
        }
        if (y < by * 8 + 7) {
          const a = Math.abs(filled[i] - filled[i + stride]), b = Math.abs(filled[i + 1] - filled[i + stride + 1]), c = Math.abs(filled[i + 2] - filled[i + stride + 2]);
          if (a > 10 || b > 10 || c > 10) { ok = 0; break; }
          if (a | b | c) my++;
        }
      }
    }
    if (ok && (mx || my)) { b1d++; if (mx >= 4 && my >= 4) b2d++; }
  }
  return {b1d, b2d, total: cols * rows};
}

function protectSteepGradientCells(data, width, height, mask, maxStep) {
  const cols = Math.floor(width / TILE), rows = Math.floor(height / TILE), stride = width * 4;
  const smooth = new Uint8Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    let moved = 0, ok = 1;
    for (let y = ty * TILE; ok && y < ty * TILE + TILE; y++) {
      let i = (y * width + tx * TILE) * 4;
      for (let x = 0; x < TILE; x++, i += 4) {
        if (x < TILE - 1) {
          const a = Math.abs(data[i] - data[i + 4]), b = Math.abs(data[i + 1] - data[i + 5]), c = Math.abs(data[i + 2] - data[i + 6]);
          if (a > maxStep || b > maxStep || c > maxStep) { ok = 0; break; }
          if (a | b | c) moved = 1;
        }
        if (y < ty * TILE + TILE - 1) {
          const a = Math.abs(data[i] - data[i + stride]), b = Math.abs(data[i + 1] - data[i + stride + 1]), c = Math.abs(data[i + 2] - data[i + stride + 2]);
          if (a > maxStep || b > maxStep || c > maxStep) { ok = 0; break; }
          if (a | b | c) moved = 1;
        }
      }
    }
    smooth[ty * cols + tx] = ok & moved;
  }
  const cw = Math.ceil(width / TILE), ch = Math.ceil(height / TILE), kept = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (x < cols && y < rows && smooth[y * cols + x]) continue;
    for (let dy = Math.max(0, y - 1); dy <= Math.min(ch - 1, y + 1); dy++)
      kept.fill(1, dy * cw + Math.max(0, x - 1), dy * cw + Math.min(cw, x + 2));
  }
  for (let ty = 0; ty < ch; ty++) for (let tx = 0; tx < cw; tx++) if (kept[ty * cw + tx]) {
    const x0 = tx * TILE, x1 = Math.min(width, (tx + 1) * TILE), y1 = Math.min(height, (ty + 1) * TILE);
    for (let y = ty * TILE; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
}

const MEMO_KEY = 'gradient-page-state';
function prepareState(data, width, height, givenFound, sharedMemo = null) {
  let state = sharedMemo?.get(MEMO_KEY);
  if (state && state.data === data && state.givenFound === givenFound && state.width === width && state.height === height) {
    return state;
  }
  const n = width * height;
  if (n > 2.5e6 || width < 4 * TILE || height < 3 * TILE || lowColourFloor(data, width, height)) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] !== 255) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  if (screenPhotoRegions(data, width, height).length > 0) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  const found = givenFound ?? findText(data, width, height);
  const cells = photoCells(data, width, height), text = photoCellText(cells, 0, 0, cells.cols - 1, cells.rows - 1);
  const hasTextCells = text.includes(1);
  if (!found?.lines?.length && !hasTextCells) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  const mask = found ? Uint8Array.from(found.mask) : new Uint8Array(n);
  if (found?.lines) {
    for (const l of found.lines) for (let y = Math.max(0, l.y0); y <= Math.min(height - 1, l.y1); y++)
      mask.fill(1, y * width + Math.max(0, l.x0), y * width + Math.min(width - 1, l.x1) + 1);
  }
  for (let ty = 0; ty < cells.rows; ty++) for (let tx = 0; tx < cells.cols; tx++) if (text[ty * cells.cols + tx] === 1)
    for (let y = ty * TILE; y < (ty + 1) * TILE; y++) mask.fill(1, y * width + tx * TILE, y * width + (tx + 1) * TILE);
  const gradRegions = gradientRegions(data, width, height);
  if (gradRegions.length > 0) {
    for (const r of gradientProtectionRects(data, width, height))
      for (let y = r.y; y < r.y + r.height; y++) mask.fill(1, y * width + r.x, y * width + r.x + r.width);
  } else {
    protectSteepGradientCells(data, width, height, mask, 10);
  }
  let masked = 0;
  for (let i = 0; i < n; i++) masked += mask[i];
  if (!masked || n - masked < MIN_FREE) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  const filled = Uint8Array.from(data.subarray(0, n * 4));
  fillHoles(filled, width, height, mask);
  for (let i = 3; i < filled.length; i += 4) filled[i] = 255;
  const stats = smoothBlockStats(filled, width, height);
  const wash1d = stats.b1d >= 256 && stats.b2d * 4 < stats.b1d;
  const hasGradRegions = !wash1d && (gradRegions.length > 0 || stats.b2d * 20 >= stats.total || gradientRegions(filled, width, height).length > 0);
  if (!hasGradRegions) {
    state = {data, givenFound, width, height, eligible: false};
    sharedMemo?.set(MEMO_KEY, state);
    return state;
  }
  state = {data, givenFound, width, height, eligible: true, mask, filled, probes: new Map(), libjxlProbes: new Map(), landings: new Map(), overlays: new Map(), bases: new Map(), results: new Map()};
  sharedMemo?.set(MEMO_KEY, state);
  return state;
}

function landQuality(data, state, intent, signal, measured, libjxl, targetFloor) {
  const {width, height, mask, filled, probes, libjxlProbes, landings} = state;
  const floor = targetFloor ?? askedLook(intent);
  const key = `${floor}|${measured ? 1 : 0}|${libjxl ? 1 : 0}`;
  if (landings.has(key)) return landings.get(key);
  const n = width * height, cache = Math.min(16 << 20, n * 48);
  const reference = ssimulacra2Reference({rgba: data}, width, height, {immutable: true, cacheBytes: cache});
  const readLibjxl = entry => {
    let toolScore = libjxlProbes.get(entry.q);
    if (toolScore === undefined) {
      const tool = ssimulacra2Reference({rgba: data}, width, height, {immutable: true, cacheBytes: cache, arithmetic: 'libjxl'});
      try { toolScore = ssimulacra2(tool, {rgba: entry.rgba}, width, height).score; } finally { tool.release(); }
      libjxlProbes.set(entry.q, toolScore);
    }
    return toolScore;
  };
  try {
    const probe = rawQ => {
      if (signal?.aborted) throw signal.reason;
      const q = Math.max(6, Math.min(97, Math.round(rawQ)));
      const hit = probes.get(q);
      if (hit) return hit;
      const image = complete(photoCoefficientSteps(filled, width, height, q, 'srgb', false, true));
      image.adaptiveLFSmoothing = true;
      const rgba = reconstructYCbCr(image);
      for (let i = 0; i < n; i++) if (mask[i]) {
        const p = i * 4;
        rgba[p] = data[p]; rgba[p + 1] = data[p + 1]; rgba[p + 2] = data[p + 2]; rgba[p + 3] = 255;
      }
      const score = ssimulacra2(reference, {rgba}, width, height).score;
      const entry = {q, image, rgba, score};
      probes.set(q, entry);
      return entry;
    };
    const aim = Math.min(96.5, floor + MARGIN);
    const q0 = Math.max(12, Math.min(95, Math.round(intent * 100 - 20)));
    let unmeasured = null;
    const p0 = probe(q0);
    if (p0.score >= aim) {
      if (p0.score > aim + 2.2 && q0 > 8) {
        const q1 = Math.max(6, Math.min(q0 - 2, Math.round(q0 - (p0.score - (aim + 0.5)) * 1.7)));
        const p1 = probe(q1);
        if (p1.score >= aim) {
          if (p1.score > aim + 2.4 && q1 > 8) {
            const slope = Math.max(0.2, (p0.score - p1.score) / Math.max(1, q0 - q1));
            const q2 = Math.max(6, Math.min(q1 - 2, Math.round(q1 - (p1.score - (aim + 0.4)) / slope)));
            const p2 = probe(q2);
            unmeasured = p2.score >= aim ? p2 : p1;
          } else unmeasured = p1;
        } else {
          const slope = Math.max(0.2, (p0.score - p1.score) / Math.max(1, q0 - q1));
          const q2 = Math.min(q0 - 1, Math.max(q1 + 1, Math.round(q1 + (aim + 0.5 - p1.score) / slope)));
          const p2 = q2 > q1 && q2 < q0 ? probe(q2) : null;
          unmeasured = p2 && p2.score >= aim ? p2 : p0;
        }
      } else unmeasured = p0;
    } else {
      const q1 = Math.min(97, Math.max(q0 + 3, Math.round(q0 + (aim + 0.6 - p0.score) * 1.9)));
      const p1 = probe(q1);
      if (p1.score >= aim) {
        if (p1.score > aim + 2.5 && q1 - q0 >= 4) {
          const slope = Math.max(0.2, (p1.score - p0.score) / (q1 - q0));
          const q2 = Math.min(q1 - 1, Math.max(q0 + 1, Math.round(q0 + (aim + 0.5 - p0.score) / slope)));
          const p2 = q2 > q0 && q2 < q1 ? probe(q2) : null;
          unmeasured = p2 && p2.score >= aim ? p2 : p1;
        } else unmeasured = p1;
      } else if (q1 < 97) {
        const slope = Math.max(0.18, (p1.score - p0.score) / Math.max(1, q1 - q0));
        const q2 = Math.min(97, Math.max(q1 + 2, Math.round(q1 + (aim + 0.6 - p1.score) / slope)));
        const p2 = probe(q2);
        if (p2.score >= aim) unmeasured = p2;
        else if (q2 < 97) {
          const p3 = probe(97);
          if (p3.score >= aim) unmeasured = p3;
        }
      }
    }
    if (!measured) {
      landings.set(key, unmeasured ? {...unmeasured, floor} : null);
      return landings.get(key);
    }
    const target = floor + RECON_GUARD;
    let hi = null, lo = null;
    for (const p of probes.values()) {
      if (p.score >= target && (!hi || p.q < hi.q)) hi = p;
      if (p.score < target && (!lo || p.q > lo.q)) lo = p;
    }
    if (!hi) {
      const top = probe(97);
      if (top.score >= target) hi = top;
      else { landings.set(key, null); return null; }
    }
    for (let step = 0; step < 2; step++) {
      if (lo && hi.q - lo.q <= 2) break;
      const nextQ = lo ? (lo.q + hi.q) >> 1 : Math.max(6, hi.q - 8);
      if (nextQ >= hi.q || lo && nextQ <= lo.q) break;
      const p = probe(nextQ);
      if (p.score >= target) hi = p;
      else lo = p;
    }
    let chosen = hi;
    if (chosen.score < floor + MARGIN && libjxl) {
      const toolScore = readLibjxl(chosen);
      if (toolScore >= floor + 0.15) chosen = {...chosen, libjxlScore: toolScore};
      else if (unmeasured && (unmeasured.score >= floor + MARGIN || readLibjxl(unmeasured) >= floor + 0.15)) chosen = unmeasured;
      else chosen = null;
    }
    let safeUnmeasured = unmeasured;
    if (safeUnmeasured && safeUnmeasured.score < floor + MARGIN && libjxl && readLibjxl(safeUnmeasured) < floor + 0.15)
      safeUnmeasured = null;
    const result = chosen ? {...chosen, floor, unmeasured: safeUnmeasured} : null;
    landings.set(key, result);
    return result;
  } finally { reference.release(); }
}

export function gradientPageLayers(data, width, height, intent, effort = 3, tools = CAPTURE_TOOLS_LEAN, signal = null, options = {}) {
  const {measured = false, libjxl = true, found = null, targetFloor = null, memo = null} = options;
  const state = prepareState(data, width, height, found, memo);
  if (!state.eligible) return null;
  const floorKey = targetFloor ?? askedLook(intent);
  const resKey = `${floorKey}|${effort}|${measured ? 1 : 0}|${libjxl ? 1 : 0}|${tools.top}`;
  const cached = state.results.get(resKey);
  if (cached !== undefined) return cached ? {...cached, bytes: cached.bytes.slice()} : null;
  const landed = landQuality(data, state, intent, signal, measured, libjxl, targetFloor);
  if (!landed) {
    state.results.set(resKey, null);
    return null;
  }
  const prepared = {filled: state.filled, image: landed.image, smooth: true, monotonic: true, overlays: state.overlays, bases: state.bases};
  let bytes = photoTextLayers(data, width, height, state.mask, landed.q, effort, tools, null, prepared);
  if (!bytes) {
    state.results.set(resKey, null);
    return null;
  }
  let score = landed.libjxlScore ?? landed.score, chosenQ = landed.q;
  if (measured && landed.unmeasured && landed.unmeasured.q !== landed.q) {
    const altBytes = photoTextLayers(data, width, height, state.mask, landed.unmeasured.q, effort, tools, null,
      {...prepared, image: landed.unmeasured.image});
    if (altBytes && altBytes.length < bytes.length) {
      bytes = altBytes;
      score = landed.unmeasured.libjxlScore ?? landed.unmeasured.score;
      chosenQ = landed.unmeasured.q;
    }
  }
  const out = {bytes, score, floor: landed.floor, q: chosenQ};
  state.results.set(resKey, out);
  return {...out, bytes: bytes.slice()};
}
