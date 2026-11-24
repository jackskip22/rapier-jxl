import {shownEntry} from './entry-name.mjs';
import {fail, unknownOption, pixelLimit, PIXELS, webgpuSetting} from './primitives.mjs';
import {captureFidelity} from './fidelity.mjs';
import {GPU_FROM} from './capture-levels.mjs';
import {refuseDescription} from './describe.mjs';

const allowed = /* @__PURE__ */ new Set(['fidelity', 'effort', 'readAs', 'maxPixels', 'signal', 'onProgress', 'onPreview', 'features']);
export function admitCapture(options = {}, carried = null) {
  refuseDescription(options);
  if (options.onPreview !== undefined && typeof options.onPreview !== 'function') throw fail('JXL_OPTIONS', 'onPreview: function');
  for (const key of Object.keys(options)) if (!allowed.has(key) && key !== 'exactRects' && key !== 'photoRects' && !(key === 'webgpu' && (carried?.gpu ?? true))) throw unknownOption(key, options);
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3') throw fail('JXL_OPTIONS', 'readAs: srgb or display-p3');
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels);
  if (options.effort !== undefined && (!Number.isInteger(options.effort) || options.effort < 1 || options.effort > 9)) throw fail('JXL_OPTIONS', options.effort === 10 ? "effort 10: import {encode} from 'jpegxl/max'" : 'effort: integer 1-9');
  if (carried && options.effort > carried.top) throw fail('JXL_UNSUPPORTED', `${shownEntry(carried.module)} effort: 1-${carried.top}, or use ${carried.next}`);
  webgpuSetting(options.webgpu);
  if (options.webgpu === 'required' && (options.effort ?? 3) < GPU_FROM)
    throw fail('JXL_WEBGPU', `capture efforts ${GPU_FROM}-9, or omit webgpu`);
  if (options.features !== undefined && (!options.features || typeof options.features !== 'object' || Array.isArray(options.features) || Object.keys(options.features).some(key => key !== 'firstRegion')))
    throw fail('JXL_OPTIONS', 'features: {firstRegion}');
  const maxError = captureFidelity(options.fidelity);
  for (const name of ['exactRects', 'photoRects']) if (options[name] !== undefined)
    throw fail('JXL_UNSUPPORTED', `${name}: use jpegxl/capture-complete`);
  return maxError;
}
