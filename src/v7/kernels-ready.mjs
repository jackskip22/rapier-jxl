import {kernelHooks} from '../kernel-hooks.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {checkKernelsFirst} from './webgpu.mjs';
let cachedKernels = null;
export async function kernelsReady() {
  const {configureKernels, prepareKernels} = await (cachedKernels ||= import('../kernels.mjs'));
  if (!await prepareKernels() || configureKernels('auto') === 'off' || !kernelHooks.channel) throw wasmRequired();
}
checkKernelsFirst(kernelsReady);
