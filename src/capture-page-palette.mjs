// SPDX-License-Identifier: MIT
import {smoothColors} from './capture-smooth-quantize.mjs';
import {ssimulacra2, ssimulacra2Reference} from './ssimulacra2.mjs';
import {askedLook} from './photo-quality-table.mjs';
import {findText} from './v7/letters-found.mjs';
import {photoCells, photoCellText} from './screen-photo-regions.mjs';
import {gradientRegions, gradientProtectionRects} from './screen-gradient-regions.mjs';

const STEPS = [3, 4, 6, 8, 10, 12, 14, 16], KEEP = 0.01;
const PREDICTED = [[50, 16], [58, 14], [64, 12], [74, 10], [80, 8], [82, 6], [86, 4], [92, 3]];
const predicted = floor => PREDICTED.find(([most]) => floor <= most)?.[1] ?? null;

const MARGIN = 2;
export function pagePalette(data, width, height, intent, signal, measured = false, libjxl = true) {
  const floor = askedLook(intent), n = width * height, start = predicted(floor);
  if (start === null) return null;
  const found = findText(data, width, height);
  if (!found) return null;
  const exact = found.mask;
  for (const l of found.lines) for (let y = Math.max(0, l.y0); y <= Math.min(height - 1, l.y1); y++) exact.fill(1, y * width + Math.max(0, l.x0), y * width + Math.min(width - 1, l.x1) + 1);
  const cells = photoCells(data, width, height), text = photoCellText(cells, 0, 0, cells.cols - 1, cells.rows - 1);
  for (let ty = 0; ty < cells.rows; ty++) for (let tx = 0; tx < cells.cols; tx++) if (text[ty * cells.cols + tx] === 1)
    for (let y = ty * 32; y < (ty + 1) * 32; y++) exact.fill(1, y * width + tx * 32, y * width + (tx + 1) * 32);
  if ((found.lines.length || text.includes(1)) && gradientRegions(data, width, height).length)
    for (const r of gradientProtectionRects(data, width, height))
      for (let y = r.y; y < r.y + r.height; y++) exact.fill(1, y * width + r.x, y * width + r.x + r.width);
  let textSamples = 0, held = 0;
  for (let i = 0; i < n; i++) { textSamples += exact[i]; if (data[i * 4 + 3] !== 255) exact[i] = 1; held += exact[i]; }
  const palette = smoothColors(data, exact), keep = Math.max(2, Math.ceil(KEEP * (n - held)));
  if (palette.size < 256) { palette.close(); return null; }
  const cache = Math.min(16 << 20, n * 48), reference = ssimulacra2Reference({rgba: data}, width, height, {immutable: true, cacheBytes: cache});
  try {
    const probe = at => {
      if (signal?.aborted) throw signal.reason;
      const step = STEPS[at], pixels = palette.remap(step, keep), score = ssimulacra2(reference, {rgba: pixels}, width, height).score;
      return score >= floor ? {pixels, step, score, floor, textSamples} : null;
    };
    let at = STEPS.indexOf(start);
    const passing = [], first = probe(at);
    if (first) passing.push(first);
    if (!first) { if (at > 0 && (measured || n <= 2e6)) { const finer = probe(at - 1); if (finer) passing.push(finer); } }
    else if (measured) for (let more = 0; more < 2 && at + 1 < STEPS.length; more++) { const next = probe(++at); if (!next) break; passing.push(next); }
    let read = false;
    for (let i = passing.length - 1; i >= 0; i--) {
      const c = passing[i];
      if (c.score >= floor + MARGIN) return c;
      if (!measured || !libjxl || read) continue;
      read = true;
      const tool = ssimulacra2Reference({rgba: data}, width, height, {immutable: true, cacheBytes: cache, arithmetic: 'libjxl'});
      try { c.libjxlScore = ssimulacra2(tool, {rgba: c.pixels}, width, height).score; } finally { tool.release(); }
      if (c.libjxlScore >= floor) return c;
    }
    return null;
  } finally { reference.release(); palette.close(); }
}
