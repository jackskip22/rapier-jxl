import {kernelHooks} from '../kernel-hooks.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {checkKernelsFirst} from './webgpu.mjs';
import {configureKernels, prepareKernels} from '../kernels.mjs';
export async function kernelsReady() {
  if (!await prepareKernels() || configureKernels('auto') === 'off' || !kernelHooks.channel) throw wasmRequired();
}
checkKernelsFirst(kernelsReady);
