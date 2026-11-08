// SPDX-License-Identifier: MIT
import {uintConfig} from './prefix.mjs';
import {floorLog2} from './bits.mjs';
import {ANS_CONFIGS} from './entropy.mjs';

const HIGH = [uintConfig(7), uintConfig(7, 1, 0), uintConfig(7, 0, 1), uintConfig(7, 2, 0), uintConfig(7, 1, 1),
  uintConfig(7, 0, 2), uintConfig(7, 3, 0), uintConfig(7, 2, 1), uintConfig(7, 1, 2), uintConfig(6, 4, 0), uintConfig(6, 3, 1), uintConfig(6, 2, 2)];
const scratch = new Uint32Array(2048);
export const JPEG_ANS = Object.freeze({
  configs: [...ANS_CONFIGS, uintConfig(2, 1, 1), uintConfig(3, 1, 2), uintConfig(3, 2, 1), uintConfig(4, 0, 2),
    uintConfig(5), uintConfig(5, 0, 1), uintConfig(5, 1, 2), uintConfig(6), uintConfig(6, 1, 0), uintConfig(6, 0, 1),
    uintConfig(6, 2, 0), uintConfig(6, 1, 1), uintConfig(6, 0, 2), uintConfig(6, 2, 1), uintConfig(6, 1, 2)],
  high(chosen, top, split, modelCost, shapedCost) {
    let best = null;
    for (const candidate of HIGH) {
      const widest = top >= candidate.splitToken ? candidate.splitToken + (((floorLog2(top) - candidate.split) << (candidate.msb + candidate.lsb)) | ((1 << (candidate.msb + candidate.lsb)) - 1)) + 1 : top + 1;
      if (widest > 256) continue;
      const [raw, last] = split(candidate, scratch);
      if (last > 255) { scratch.fill(0, 0, last + 1); continue; }
      const used = scratch.slice(0, last + 1);
      scratch.fill(0, 0, last + 1);
      const cost = raw + modelCost(used, candidate);
      if (!best || cost < best.cost) best = {candidate, tokens: used, raw, cost};
    }
    const {config, freqs, extra} = chosen;
    if (best && (shapedCost ? best.raw + shapedCost(best.tokens, best.candidate) < extra + shapedCost(freqs, config) : best.cost < chosen.cost))
      return {config: best.candidate, freqs: best.tokens, extra: best.raw};
    return {config, freqs, extra};
  },
});
