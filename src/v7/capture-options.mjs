import {fail, pixelLimit, PIXELS, webgpuSetting} from './primitives.mjs';
import {captureFidelity} from './fidelity.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {refuseDescription} from './describe.mjs';

const allowed = /* @__PURE__ */ new Set(['fidelity', 'effort', 'readAs', 'maxPixels', 'signal', 'onProgress', 'onPreview', 'features']);
export function admitCapture(options = {}, carried = null) {
  refuseDescription(options);
  if (options.onPreview !== undefined && typeof options.onPreview !== 'function') throw fail('JXL_OPTIONS', "Invalid onPreview; pass a function.");
  for (const key of Object.keys(options)) if (!allowed.has(key) && key !== 'exactRects' && key !== 'photoRects' && !(key === 'webgpu' && (carried?.gpu ?? true))) throw fail('JXL_OPTIONS', `Unknown capture option ${key}; remove it.`);
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3') throw fail('JXL_OPTIONS', "Invalid readAs; use srgb or display-p3.");
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels);
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9)) throw fail('JXL_OPTIONS', "Invalid effort; use an integer from 1 to 9.");
  if (carried && options.effort > carried.top) throw fail('JXL_UNSUPPORTED', `${carried.module} does not offer this effort; use an effort from 1 to ${carried.top}, or import ${carried.next}.`);
  webgpuSetting(options.webgpu);
  if (options.webgpu === 'required' && (options.effort ?? 3) < GPU_FROM)
    throw fail('JXL_WEBGPU', `Required WebGPU runs only capture efforts ${GPU_FROM}-9; use one of those efforts, or leave webgpu out.`);
  if (options.features !== undefined && (!options.features || typeof options.features !== 'object' || Array.isArray(options.features) || Object.keys(options.features).some(key => key !== 'firstRegion')))
    throw fail('JXL_OPTIONS', "Invalid capture features; use {firstRegion}.");
  const maxError = captureFidelity(options.fidelity);
  for (const name of ['exactRects', 'photoRects']) if (options[name] !== undefined)
    throw fail('JXL_UNSUPPORTED', `${name} is unavailable in this module; use rapier-jxl/capture-complete.`);
  return maxError;
}
