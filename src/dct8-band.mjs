// SPDX-License-Identifier: MIT
import {kernelModule} from './kernel-runtime.mjs';
import {inverseBasis, RECON_ONE} from './reconstruct-dct8.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {fault} from './fault.mjs';

const BLOCKS = 256, COEFF = BLOCKS * 512, OUT = 3 * COEFF, TMP = OUT + BLOCKS * 256, BASIS = TMP + 1024, PAGES = 8;
const QUANT = BASIS + 512, DC = QUANT + 1536, ONE = DC + 24, FIELD = ONE + 24, CFL_X = FIELD + BLOCKS * 8, CFL_B = CFL_X + BLOCKS * 8;
export const VAR_BASE = 524288;
let band;
export function dct8Band() {
  if (band) return band;
  const memory = new WebAssembly.Memory({initial: PAGES});
  let k;
  try { k = new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports; }
  catch (error) { throw error?.code === 'JXL_WASM' ? error : wasmRequired(error); }
  const views = () => {
    const buffer = memory.buffer;
    band.coeffViews = [0, COEFF, 2 * COEFF].map(at => new Float64Array(buffer, at, BLOCKS * 64));
    band.quantViews = [0, 1, 2].map(c => new Float64Array(buffer, QUANT + c * 512, 64));
    band.dcView = new Float64Array(buffer, DC, 3);
    band.fieldView = new Float64Array(buffer, FIELD, BLOCKS);
    band.cflXView = new Float64Array(buffer, CFL_X, BLOCKS);
    band.cflBView = new Float64Array(buffer, CFL_B, BLOCKS);
    band.strip = new Float32Array(buffer, OUT, BLOCKS * 64);
  };
  new Float64Array(memory.buffer, BASIS, 64).set(inverseBasis(8));
  new Float64Array(memory.buffer, ONE, 3).set(RECON_ONE);
  band = {blocks: BLOCKS, coeff: [0, COEFF, 2 * COEFF], out: OUT, tmp: TMP, basis: BASIS, buffer: () => memory.buffer,
    grow(bytes) {
      if (bytes > memory.buffer.byteLength) {
        try { memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / 65536)); }
        catch (cause) { throw Object.assign(fault('JXL_MEMORY', 'dct8-band: grow failed'), {cause}); }
        views();
      }
      return memory.buffer;
    },
    quant: QUANT, dc: DC, one: ONE, field: FIELD, cflX: CFL_X, cflB: CFL_B,
    dequant8: k.dequant8, idct8f32: k.idct8f32, colorRows: k.colorRows, exports: k};
  views();
  return band;
}
