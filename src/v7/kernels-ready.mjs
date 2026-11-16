import {wasmRequired} from '../capture-wasm-error.mjs';
import {checkKernelsFirst} from './webgpu.mjs';
import {ensureKernels, prepareKernels} from '../kernels.mjs';
export async function kernelsReady() {
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
}
checkKernelsFirst(kernelsReady);
