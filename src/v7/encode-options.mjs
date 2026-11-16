// SPDX-License-Identifier: MIT
import {pixelLimit, PIXELS, fail, object, admitSignal} from './primitives.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';
import {featureless} from './first-region-option.mjs';
import {RESULT_REFERENCE, DEVICE_RAN} from './result-reference.mjs';
import {PREVIEW} from './preview.mjs';
import {RETAIN_INPUT} from './ownership.mjs';
const rawKeys = /* @__PURE__ */ new Set(['fidelity','effort','progressive','features','readAs','jpeg','webgpu','maxPixels','signal','onProgress','onPreview']);
export const ENCODE_FEATURES = /* @__PURE__ */ Symbol('encode features');
export function publicVocabulary(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  if ('features' in options) throw fail('JXL_OPTIONS', 'Unknown option: features; remove it.');
  const inner = options[ENCODE_FEATURES], region = 'firstRegion' in options ? options.firstRegion : undefined;
  if (inner === undefined && !('firstRegion' in options)) return options;
  const {firstRegion: _region, [ENCODE_FEATURES]: _inner, ...rest} = options;
  const features = inner !== undefined ? {...inner, ...(region !== undefined && {firstRegion: region})} : region !== undefined ? {firstRegion: region} : undefined;
  return features === undefined ? rest : {...rest, features};
}
export function encodeOptions(value) {
  const options = featureless(object(value));
  refuseDescription(options);
  for (const key of Object.keys(options)) if (!rawKeys.has(key))
    throw fail('JXL_OPTIONS', `Unknown encode option: ${key}; use the options listed for this function.`);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fail('JXL_OPTIONS', "Invalid onProgress; pass a function.");
  if (options.onPreview !== undefined && typeof options.onPreview !== 'function') throw fail('JXL_OPTIONS', "Invalid onPreview; pass a function.");
  admitSignal(options.signal);
  const fidelity = encodeFidelity(options.fidelity), {effort = 7} = options;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fail('JXL_OPTIONS', "Invalid effort; pass a whole number from 1 to 9.");
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3')
    throw fail('JXL_OPTIONS', "Invalid readAs; use srgb or display-p3.");
  if (options.jpeg !== undefined && options.jpeg !== 'pixels')
    throw fail('JXL_OPTIONS', "Invalid jpeg; use 'pixels' or leave it out.");
  if (options.progressive !== undefined && typeof options.progressive !== 'boolean')
    throw fail('JXL_OPTIONS', 'Invalid progressive; pass true or false.');
  if (options.progressive === true && fidelity.quality === 100)
    throw fail('JXL_OPTIONS', 'progressive encodes multi-scale lossy passes; omit progressive for exact fidelity.');
  if (options.webgpu !== undefined && options.webgpu !== 'required' && options.webgpu !== false)
    throw fail('JXL_OPTIONS', "Invalid webgpu; use 'required', false, or leave it out.");
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels);
  if (options.features !== undefined) {
    const named = Object.keys(options.features ?? {});
    if (fidelity.target !== undefined && (named.length !== 1 || named[0] !== 'firstRegion')) throw fail('JXL_OPTIONS', "Measured target chooses its own features; omit features other than firstRegion.");
    object(options.features, 'features');
    refuseDescription(options.features, 'features');
    const allowed = new Set(['level','upsampling','upsamplingWeights','transforms','quantization','coefficientOrders',
      'progressive','noise','lfFrames','firstRegion']);
    for (const key of Object.keys(options.features)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown features option ${key}; remove it.`);
    if (options.features.upsampling !== undefined && fidelity.quality === 100)
      throw fail('JXL_OPTIONS', "upsampling changes the picture; remove it for exact fidelity or request lossy fidelity.");
  }
  const {[RESULT_REFERENCE]: _reference, [PREVIEW]: _preview, [RETAIN_INPUT]: _retain, [DEVICE_RAN]: _ran, fidelity: _fidelity, signal, onProgress, onPreview, features, readAs, jpeg, webgpu, maxPixels, ...codec} = options;
  return {...codec, ...fidelity, effort, webgpu, maxPixels};
}

export function callOptions({webgpu, maxPixels, ...codec}, hooks = {}) {
  return {codec, hooks: {...hooks, webgpu: webgpu ?? hooks.webgpu, maxPixels: Math.min(maxPixels ?? PIXELS, hooks.maxPixels ?? PIXELS)}};
}
