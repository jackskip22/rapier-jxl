// SPDX-License-Identifier: MIT
import {BitWriter, ceilLog2} from './bits.mjs';
import {writeCodedContextMap, setSmallMap} from './prefix.mjs';

const MTF_SCRATCH = /* @__PURE__ */ new Uint8Array(256);
function moveMapToFront(map) {
  const list = MTF_SCRATCH, out = new Uint8Array(map.length);
  for (let i = 0; i < 256; i++) list[i] = i;
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    let at = 0;
    while (list[at] !== v) at++;
    out[i] = at;
    for (let k = at; k > 0; k--) list[k] = list[k - 1];
    list[0] = v;
  }
  return out;
}
const coded = (w, map, widest, mtf, runs, minLength) => {
  if (!mtf) return writeCodedContextMap(w, map, widest, false, runs, minLength);
  const moved = moveMapToFront(map);
  let top = 0;
  for (let i = 0; i < moved.length; i++) if (moved[i] > top) top = moved[i];
  writeCodedContextMap(w, moved, top, true, runs, minLength);
};

setSmallMap((w, contextMap, widest) => {
  const bits = widest ? ceilLog2(widest + 1) : 0;
  if (bits <= 3) {
    let best = null, bestBits = 3 + bits * contextMap.length;
    if (bits && contextMap.length >= 12) {
      for (const [mtf, useRuns, minL] of [[false, contextMap.length >= 64, 7], [true, false, 7], [false, contextMap.length >= 16, 3], [true, contextMap.length >= 16, 3]]) {
        const out = new BitWriter(64);
        coded(out, contextMap, widest, mtf, useRuns, minL);
        if (out.bitLength < bestBits) { best = out; bestBits = out.bitLength; }
      }
    }
    if (best) { w.append(best); return; }
    w.write(1, 1); w.write(2, bits);
    if (bits) for (let i = 0; i < contextMap.length; i++) w.write(bits, contextMap[i]);
    return;
  }
  let best = new BitWriter(Math.max(64, contextMap.length));
  coded(best, contextMap, widest, false, contextMap.length >= 64, 7);
  if (contextMap.length >= 8) {
    const specs = [[true, false, 7]];
    if (contextMap.length >= 16) specs.push([false, true, 3], [true, true, 3]);
    if (contextMap.length >= 64) specs.push([true, true, 7]);
    for (const [mtf, useRuns, minL] of specs) {
      const cand = new BitWriter(Math.max(64, contextMap.length));
      coded(cand, contextMap, widest, mtf, useRuns, minL);
      if (cand.bitLength < best.bitLength) best = cand;
    }
  }
  w.append(best);
});
