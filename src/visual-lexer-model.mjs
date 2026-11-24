// SPDX-License-Identifier: MIT
import {evalVisualLexerFromRgbaWasm, evalVisualLexerWasm, extractVisualLexemes8Wasm, decodeVisualLexerPlan, decodeVisualLexerRecipe, readVisualLexerVote} from './visual-lexer-core.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';

function evalVisualLexerPlan(rgba, width, height, readingIntent, wide, fallbackQuality, pkt, onlyWherePays, memo, decode) {
  const qInt = Math.max(0, Math.min(8192, Math.round((readingIntent ?? (fallbackQuality / 100)) * 8192))) | 0;
  const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8);
  let rawOut;
  if (memo) {
    if (memo.rgba !== rgba || memo.width !== width || memo.height !== height)
      Object.assign(memo, {rgba, width, height, feat: extractVisualLexemes8Wasm(rgba, width, height, bw, bh, qInt)});
    const feat = memo.feat;
    for (let at = 11; at < feat.length; at += 12) feat[at] = qInt;
    rawOut = evalVisualLexerWasm(pkt, feat, bw, bh, qInt, wide ? 1 : 0);
  } else rawOut = evalVisualLexerFromRgbaWasm(pkt, rgba, width, height, qInt, wide ? 1 : 0);
  const isV2 = pkt[2] === 2;
  const n8 = bw * bh;
  if (onlyWherePays && !isV2 && !readVisualLexerVote(rawOut, n8, false).pays) return null;
  const plan = decode(rawOut, width, height, readingIntent, wide, fallbackQuality, isV2 || pkt[3] > 32, isV2);
  if (onlyWherePays && isV2) {
    let varCells = 0;
    for (const b of plan.layout) if (b.id) varCells += (TRANSFORMS[b.id].width >> 3) * (TRANSFORMS[b.id].height >> 3);
    if (varCells / Math.max(1, n8) < 0.2435) return null;
  }
  return plan;
}

export function evalBuiltinVisualLexerPlan(rgba, width, height, readingIntent, wide, fallbackQuality, pkt, onlyWherePays = false, memo = null) {
  return evalVisualLexerPlan(rgba, width, height, readingIntent, wide, fallbackQuality, pkt, onlyWherePays, memo, decodeVisualLexerPlan);
}
export function evalVisualLexerRecipe(rgba, width, height, readingIntent, wide, fallbackQuality, pkt, onlyWherePays = false, memo = null) {
  return evalVisualLexerPlan(rgba, width, height, readingIntent, wide, fallbackQuality, pkt, onlyWherePays, memo, decodeVisualLexerRecipe);
}
