// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitWriter} from '../src/bits.mjs';
import {buildCode, countToken} from '../src/prefix.mjs';
import {LZ77, RESIDUAL_CONFIG} from '../src/modular.mjs';
import {codeWeighted, WEIGHTED_CUTS} from '../src/weighted.mjs';
import {configureKernels} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SIMD_PROBE} from '../src/kernels-bytes.mjs';

const supportsSIMD = typeof WebAssembly === 'object' && WebAssembly.validate(Uint8Array.from(atob(SIMD_PROBE), c => c.charCodeAt(0)));

test('weighted contexts follow the signaled tree cuts in JavaScript and available kernels', () => {
  const width = 256, height = 256, count = width * height, contexts = WEIGHTED_CUTS.length + 1;
  const identity = Int32Array.from({length: contexts}, (_, i) => i);
  let seed = 3917;
  const plane = Int16Array.from({length: count}, (_, i) => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const amplitude = 1 << (i >>> 13);
    return (seed >>> 0) % (amplitude * 2 + 1) - amplitude;
  });
  let reference;
  try {
    for (const mode of ['off', 'scalar', ...(supportsSIMD ? ['simd'] : [])]) {
      assert.equal(configureKernels(mode), mode);
      let accepted = 0;
      if (mode !== 'off') {
        const weighted = kernelHooks.weighted;
        kernelHooks.weighted = (...args) => { const took = weighted(...args); accepted += took; return took; };
      }
      const residuals = new Uint32Array(count), properties = new Int32Array(count);
      codeWeighted(null, null, plane, width, height, 0, identity, residuals, properties);
      const histograms = Array.from({length: contexts}, () => new Uint32Array(257));
      codeWeighted(null, histograms, plane, width, height, 0, identity);
      const expected = histograms.map(() => new Uint32Array(257)), occupied = new Set();
      for (let i = 0; i < count; i++) {
        const context = WEIGHTED_CUTS.filter(cut => cut < properties[i]).length;
        occupied.add(context);
        if (residuals[i]) countToken(RESIDUAL_CONFIG, residuals[i], expected[context]);
      }
      assert.equal(occupied.size, contexts, 'exercise every tree interval and both saturated tails');
      for (let c = 0; c < contexts; c++) {
        // Zero runs use copy tokens; nonzero residuals directly expose their tree interval.
        assert.deepEqual(histograms[c].slice(1, LZ77.minSymbol), expected[c].slice(1, LZ77.minSymbol));
      }
      const writer = new BitWriter(16);
      codeWeighted(writer, histograms.map(buildCode), plane, width, height, 0, identity);
      const result = {residuals, properties, histograms, bytes: writer.finish(), bits: writer.bitLength};
      if (mode === 'off') reference = result;
      else { assert.ok(accepted > 0, 'run the weighted kernel'); assert.deepEqual(result, reference); }
    }
  } finally { configureKernels('off'); }
});
