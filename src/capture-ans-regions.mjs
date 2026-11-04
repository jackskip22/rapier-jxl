// SPDX-License-Identifier: MIT
import {ceilLog2} from './bits.mjs';
import {hybridToken, writeContextMap, writeUintConfig} from './prefix.mjs';
import {reverseAlias, shapeHistogram, writeDistribution} from './ans-core.mjs';

let scratch = {n: 0};
export function regionAnsCoding(prefix, groups) {
  const {contextMap, configs, kernels} = prefix, freqs = configs.map(() => new Uint32Array(256)), token = [0, 0, 0];
  const counting = !!kernels?.tables(freqs, contextMap, configs);
  let largest = 0;
  for (const group of groups) {
    const got = counting ? kernels.freqs(group, freqs) : null;
    if (got !== null) { if (got < 0) return null; if (got > largest) largest = got; continue; }
    const {ctxs, values, n} = group;
    for (let i = 0; i < n; i++) {
      const h = contextMap[ctxs[i]];
      hybridToken(configs[h], values[i], token);
      if (token[0] > 255) return null;
      freqs[h][token[0]]++;
      if (token[0] > largest) largest = token[0];
    }
  }
  const logAlphabet = Math.max(5, ceilLog2(largest + 1), ...configs.map(c => c.split));
  if (logAlphabet > 8) return null;
  const shapes = freqs.map(f => { const shape = shapeHistogram(f); return {...shape, ...reverseAlias(shape.counts, logAlphabet)}; });
  const coding = {shapes,
    writeHistograms(w) {
      w.write(1, 0);
      if (contextMap.length > 1) writeContextMap(w, contextMap);
      w.write(1, 0); w.write(2, logAlphabet - 5);
      for (const config of configs) writeUintConfig(w, config, logAlphabet);
      for (const shape of shapes) writeDistribution(w, shape.counts, true, shape.shift, shape.omit);
    },
    writeTokens(w, ctxs, values, n) {
      if (counting && kernels.tables(coding, contextMap, configs) && kernels.write(w, {ctxs, values, n}, true)) return;
      if (scratch.n < n) scratch = {n, nbits: new Uint8Array(n), bits: new Uint32Array(n), word: new Int32Array(n)};
      const {nbits, bits, word} = scratch;
      let state = 0x13 * 65536;
      for (let i = n - 1; i >= 0; i--) {
        const h = contextMap[ctxs[i]], c = configs[h], value = values[i], s = shapes[h];
        let symbol = value;
        if (value < c.splitToken) { nbits[i] = 0; bits[i] = 0; }
        else {
          const e = 31 - Math.clz32(value), below = value - (1 << e), extra = e - c.msb - c.lsb;
          symbol = c.splitToken + (((e - c.split) << (c.msb + c.lsb)) | ((below >> (e - c.msb)) << c.lsb) | (below & ((1 << c.lsb) - 1)));
          nbits[i] = extra; bits[i] = (value >> c.lsb) & ((1 << extra) - 1);
        }
        const freq = s.counts[symbol];
        if ((state >>> 20) >= freq) { word[i] = state & 65535; state >>>= 16; } else word[i] = -1;
        const q = Math.floor(state / freq);
        state = q * 4096 + s.reverse[s.starts[symbol] + state - q * freq];
      }
      w.write(32, state);
      for (let i = 0; i < n; i++) {
        if (word[i] >= 0) w.write(16, word[i]);
        if (nbits[i]) w.write(nbits[i], bits[i]);
      }
    },
  };
  return coding;
}
