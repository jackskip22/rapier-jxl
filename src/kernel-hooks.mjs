// MIT. Synchronous kernels with private memory. `ensure` (kernels.mjs ensureKernels) configures the kernels for a caller
import {fault} from './fault.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
export const kernelHooks = {channel: null, weighted: null, fill: null, palette: null, rct: null, tuple: null, passLevels: null, group: null, screen: null, sampled: null, dct: null, ycbcrTile: null, ycbcrTiles: null, rgbTiles: null, rgbBand: null, photoTile: null, acGroup: null, acGroupPair: null, acDeferred: null, nonzero: null, entropy: null, varblock: null, gaborish: null, strategyFill: null, strategyWrite: null, xybPlanes: null, gabBand: null, dcEvents: null, dcPlan: null, planTokens: null, shape: null, nativeRGBA: null, s2cChannel: null, opaque: null, arena: null, ensure: null};
export const ensured = () => (kernelHooks.ensure?.(), kernelHooks);
export const missing = () => { throw wasmRequired(); };
let holds = 0, held = null;
export function holdEntropy(lend) {
  if (holds++ > 0 || kernelHooks.entropy) return;
  held = lend() ?? null;
  if (held) { const kernels = held; kernelHooks.entropy = () => kernels; }
}
export function releaseEntropy() {
  if (--holds > 0 || !held) return;
  held = null; kernelHooks.entropy = null; kernelHooks.arena?.release();
}
export const declined = name => fault('JXL_INTERNAL', `The ${name} kernel refused a call it takes.`);
