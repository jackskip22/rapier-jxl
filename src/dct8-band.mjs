// SPDX-License-Identifier: MIT
import {kernelModule} from './kernel-runtime.mjs';
import {inverseBasis} from './reconstruct-dct8.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';

const BLOCKS = 256, COEFF = BLOCKS * 512, OUT = 3 * COEFF, TMP = OUT + BLOCKS * 256, BASIS = TMP + 1024, PAGES = 8;
let band;
export function dct8Band() {
  if (band) return band;
  const memory = new WebAssembly.Memory({initial: PAGES, maximum: PAGES});
  let k;
  try { k = new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports; }
  catch (error) { throw error?.code === 'JXL_WASM' ? error : wasmRequired(); }
  new Float64Array(memory.buffer, BASIS, 64).set(inverseBasis(8));
  return band = {blocks: BLOCKS, coeff: [0, COEFF, 2 * COEFF], out: OUT, tmp: TMP, basis: BASIS, buffer: () => memory.buffer,
    idct8f32: (...args) => k.idct8f32(...args)};
}
