import {fail, pixelLimit, LARGEST} from './primitives.mjs';
import {captureFidelity} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';

const allowed = new Set(['fidelity', 'readAs', 'maxPixels', 'signal', 'onProgress', 'features']);
export function admitCapture(options = {}) {
  refuseDescription(options);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown capture option: ${key}.`);
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3') throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels, LARGEST);
  if (options.features !== undefined && (!options.features || typeof options.features !== 'object' || Object.keys(options.features).some(key => key !== 'firstRegion')))
    throw fail('JXL_OPTIONS', 'A capture\'s features are {firstRegion}.');
  return captureFidelity(options.fidelity);
}
