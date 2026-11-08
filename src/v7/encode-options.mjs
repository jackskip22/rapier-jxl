// SPDX-License-Identifier: MIT
import {pixelLimit, LARGEST, fail, object, admitSignal} from './primitives.mjs';
import {encodeFidelity, fidelityHint} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';
import {featureless} from './first-region-option.mjs';
import {RESULT_REFERENCE} from './result-reference.mjs';
import {PREVIEW} from './preview.mjs';
const rawKeys = new Set(['fidelity','effort','features','readAs','webgpu','maxPixels','signal','onProgress','onPreview']);
const HINT = {
  lossless: "Write fidelity: 'exact'.", target: 'Write fidelity: {ssimulacra2: 80}.',
  maxError: 'maxError is a capture fidelity: capture(screen, {fidelity: {maxError: 2}}).',
  acceleration: "Write webgpu: 'required' or webgpu: false.",
  photo: 'The encoder chooses the coding.', filter: 'The encoder chooses the coding.',
  losslessProfile: 'The encoder chooses the coding.', mode: 'The encoder chooses the coding.',
  iccCompression: "The encoder writes a profile's smaller coding.",
};
export function encodeOptions(value) {
  const options = featureless(object(value));
  refuseDescription(options);
  for (const key of Object.keys(options)) if (!rawKeys.has(key))
    throw fail('JXL_OPTIONS', `Unknown encode option: ${key}.${key === 'quality' ? fidelityHint(options.quality) : Object.hasOwn(HINT, key) ? ' ' + HINT[key] : ''}`);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  if (options.onPreview !== undefined && typeof options.onPreview !== 'function') throw fail('JXL_OPTIONS', 'onPreview must be a function.');
  admitSignal(options.signal);
  const fidelity = encodeFidelity(options.fidelity), {effort = 7} = options;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fail('JXL_OPTIONS', 'effort must be an integer 1–9.');
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3')
    throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  if (options.webgpu !== undefined && options.webgpu !== 'required' && options.webgpu !== false)
    throw fail('JXL_OPTIONS', "webgpu is 'required' or false, or left out.");
  if (options.maxPixels !== undefined) pixelLimit(options.maxPixels, LARGEST);
  if (options.features !== undefined) {
    const named = Object.keys(options.features ?? {});
    if (fidelity.target !== undefined && (named.length !== 1 || named[0] !== 'firstRegion')) throw fail('JXL_OPTIONS', 'A measured target supplies its own features search.');
    object(options.features, 'features');
    refuseDescription(options.features, 'features');
    const allowed = new Set(['level','upsampling','upsamplingWeights','transforms','quantization','coefficientOrders',
      'progressive','noise','lfFrames','firstRegion']);
    for (const key of Object.keys(options.features)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown features option: ${key}.`);
  }
  const {[RESULT_REFERENCE]: _reference, [PREVIEW]: _preview, fidelity: _fidelity, signal, onProgress, onPreview, features, readAs, webgpu, maxPixels, ...codec} = options;
  return {...codec, ...fidelity, effort, webgpu, maxPixels};
}

export function callOptions({webgpu, maxPixels, ...codec}, hooks = {}) {
  return {codec, hooks: {...hooks, webgpu: webgpu ?? hooks.webgpu, maxPixels: Math.min(maxPixels ?? 40000000, hooks.maxPixels ?? Infinity)}};
}
