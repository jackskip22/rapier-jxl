// SPDX-License-Identifier: MIT
import {evalVisualLexerRecipe} from './visual-lexer-model.mjs';
import {evalVisualLexerFromRgbaWasm, readVisualLexerVote, visualLexerPacketShape} from './visual-lexer-core.mjs';
import {VISUAL_LEXER_SEED} from './visual-lexer-seed.mjs';
import {wasmBytes} from './wasm-text.mjs';

import {DC_GROUP_DIM} from './frame.mjs';

export const COMPACT = Object.freeze({compactDct8: true, tableBands: 6, dct8Bands: 8});

export function planWithVisualLexer(rgba, width, height, quality, readingIntent, {onlyWherePays = true, packet, memo = null} = {}) {
  const p = evalVisualLexerRecipe(rgba, width, height, readingIntent, false, quality, packet, onlyWherePays, memo);
  if (!p) return null;
  const deadzoneMap = p.deadzoneMap;
  return {
    quality: p.quality,
    slope: p.slope,
    layout: p.layout,
    providerBlocks: true,
    epfScale: p.epfScale,
    ...(p.fieldScale && {field: p.fieldScale}),
    ...(p.sharpness && {sharpness: p.sharpness}),
    options: {...COMPACT, ...(deadzoneMap && {deadzoneMap})},
  };
}

function chooseLfGroup(packet, rgba, width, height, intent) {
  const across = Math.ceil(width / DC_GROUP_DIM), down = Math.ceil(height / DC_GROUP_DIM);
  const q = Math.max(0, Math.min(8192, Math.round(intent * 8192)));
  const wholeGroup = DC_GROUP_DIM * DC_GROUP_DIM, native = width * height > wholeGroup;
  const limit = native ? 2 * 1024 * 1024 : wholeGroup;
  const extraLimit = width * height >= 11 * 1024 * 1024 ? width * height * 3 / 8 : 0;
  let group = -1, best = 0, read = 0, extra = -1, extraBest = 0, extraRead = 0, patch;
  for (let g = 0; g < across * down && (read < 8 || (extraLimit && extraRead < 4)); g++) {
    const x = (g % across) * DC_GROUP_DIM, y = Math.floor(g / across) * DC_GROUP_DIM;
    const w = Math.min(width - x, DC_GROUP_DIM), h = Math.floor(Math.min(height - y, DC_GROUP_DIM)), area = w * h;
    const larger = area > limit;
    if (area < 512 * 512 || (larger ? area > extraLimit || extraRead >= 4 : read >= 8)) continue;
    patch ??= new Uint8Array(64 * 64 * 4);
    if (larger) extraRead++; else read++;
    let confident = 0;
    for (const fy of [1, 3]) for (const fx of [1, 3]) {
      const sx = x + Math.floor((w - 64) * fx / 4), sy = y + Math.floor((h - 64) * fy / 4);
      for (let row = 0; row < 64; row++) {
        const start = ((sy + row) * width + sx) * 4;
        patch.set(rgba.subarray(start, start + 256), row * 256);
      }
      const raw = evalVisualLexerFromRgbaWasm(packet, patch, 64, 64, q, 0);
      const vote = readVisualLexerVote(raw, 64, false);
      if (vote.pays) confident += vote.hiMarginCells;
    }
    const score = area * (24 * 256 - confident);
    if (larger) {
      if (score > extraBest) { extraBest = score; extra = g; }
    } else if (score > best) { best = score; group = g; }
  }
  if (extra < 0) return group;
  return group < 0 ? extra : [group, extra];
}

const FLAT = Object.freeze({providerBlocks: true, options: COMPACT});

let testPlan = null;
export const planForTests = plan => { testPlan = plan; };
export function lexerOfPacket(packet) {
  const parsed = visualLexerPacketShape(packet);
  const bpp = parsed.readLine ? parsed.readLine / 100 : undefined;
  if (testPlan) { const own = testPlan; return {packet, version: parsed.version, ran: false, bpp, lfGroup: () => -1, plan: (...args) => own.plan(...args)}; }
  const memo = {};
  const lexer = {packet, version: parsed.version, ran: false, bpp,
    lfGroup(rgba, width, height, intent) {
      const group = chooseLfGroup(packet, rgba, width, height, intent);
      if (Array.isArray(group) || group >= 0) lexer.ran = true;
      return group;
    },
    plan(rgba, width, height, quality, readingIntent, effort) {
      if (effort < 3 || effort > 6) return null;
      lexer.ran = true;
      return planWithVisualLexer(rgba, width, height, quality, readingIntent, {packet, memo}) ?? FLAT;
    }};
  return lexer;
}

let seed = null;
export function seedLexer() {
  seed ??= wasmBytes(VISUAL_LEXER_SEED);
  return Object.assign(lexerOfPacket(seed), {seed: true});
}
