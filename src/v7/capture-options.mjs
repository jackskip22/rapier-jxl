import {fail, pixelLimit} from './primitives.mjs';
import {captureFidelity} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';

const allowed = new Set(['fidelity', 'readAs', 'maxPixels', 'signal', 'onProgress']);
export function admitCapture(options = {}) {
  refuseDescription(options);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown capture option: ${key}.`);
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3') throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels);
  return captureFidelity(options.fidelity);
}
