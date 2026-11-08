import {fail, pixelLimit, LARGEST, webgpuSetting} from './primitives.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {captureFidelity, fidelityHint} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';

const allowed = new Set(['fidelity', 'effort', 'webgpu', 'readAs', 'maxPixels', 'signal', 'onProgress', 'onPreview', 'onEncoded', 'features']);
export function admitCapture(options = {}, carried = null) {
  refuseDescription(options);
  if (options.onPreview !== undefined && typeof options.onPreview !== 'function') throw fail('JXL_OPTIONS', 'onPreview must be a function.');
  for (const key of Object.keys(options)) if (!allowed.has(key) && key !== 'exactRects' && key !== 'photoRects') throw fail('JXL_OPTIONS', `Unknown capture option: ${key}.${key !== 'quality' ? '' : (carried?.module === 'rapier-jxl/capture' ? ` Photo quality: use ${carried.next}.` : '') + fidelityHint(options.quality)}`);
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3') throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels, LARGEST);
  const range = carried?.next ? `${carried.module} runs efforts 1-${carried.top}; ${carried.next} runs 1-9.` : 'effort is a whole number from 1 to 9.';
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9)) throw fail('JXL_OPTIONS', range);
  if (carried && options.effort > carried.top) throw fail('JXL_UNSUPPORTED', range);
  if (webgpuSetting(options.webgpu) === 'required' && (options.effort ?? 3) >= GPU_FROM && !carried?.gpu)
    throw fail('JXL_WEBGPU', `${carried?.module ?? 'This module'} runs effort ${options.effort} on WebAssembly only; leave webgpu out.`);
  if (options.features !== undefined && (!options.features || typeof options.features !== 'object' || Object.keys(options.features).some(key => key !== 'firstRegion')))
    throw fail('JXL_OPTIONS', 'A capture\'s features are {firstRegion}.');
  const maxError = captureFidelity(options.fidelity);
  for (const name of ['exactRects', 'photoRects']) if (options[name] !== undefined)
    throw fail('JXL_UNSUPPORTED', `${name} needs rapier-jxl/capture-complete; rapier-jxl/capture is exact.`);
  return maxError;
}
