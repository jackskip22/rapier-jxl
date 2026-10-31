// SPDX-License-Identifier: MIT
import {fail, object, admitSignal} from './primitives.mjs';
import {encodeFidelity} from './fidelity.mjs';
import {refuseDescription} from './describe.mjs';
const rawKeys = new Set(['fidelity','effort','features','readAs','webgpu','maxPixels','signal','onProgress']);
const HINT = {
  quality: 'Write fidelity: {quality: 90}.', lossless: "Write fidelity: 'exact'.", target: 'Write fidelity: {ssimulacra2: 80}.',
  maxError: 'maxError is a capture fidelity: capture(screen, {fidelity: {maxError: 2}}).',
  acceleration: "Write webgpu: 'required' or webgpu: false.",
  photo: 'The encoder chooses the coding.', filter: 'The encoder chooses the coding.',
  losslessProfile: 'The encoder chooses the coding.', mode: 'The encoder chooses the coding.',
  iccCompression: "The encoder writes a profile's smaller coding.",
};
export function encodeOptions(value) {
  const options = object(value);
  refuseDescription(options);
  for (const key of Object.keys(options)) if (!rawKeys.has(key))
    throw fail('JXL_OPTIONS', `Unknown encode option: ${key}.${Object.hasOwn(HINT, key) ? ' ' + HINT[key] : ''}`);
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  admitSignal(options.signal);
  const fidelity = encodeFidelity(options.fidelity), effort = options.effort ?? 7;
  if (!Number.isInteger(effort) || effort < 1 || effort > 9) throw fail('JXL_OPTIONS', 'effort must be an integer 1–9.');
  if (options.readAs !== undefined && options.readAs !== 'srgb' && options.readAs !== 'display-p3')
    throw fail('JXL_OPTIONS', 'readAs is srgb or display-p3.');
  if (options.webgpu !== undefined && options.webgpu !== 'required' && options.webgpu !== false)
    throw fail('JXL_OPTIONS', "webgpu is 'required' or false; leave it out to use WebGPU where this realm has it.");
  if (options.maxPixels !== undefined && (!Number.isSafeInteger(options.maxPixels) || options.maxPixels < 1 || options.maxPixels > 40000000))
    throw fail('JXL_OPTIONS', 'maxPixels is a positive whole number, at most 40,000,000.');
  if (options.features !== undefined) {
    if (fidelity.target !== undefined) throw fail('JXL_OPTIONS', 'A measured target supplies its own features search.');
    object(options.features, 'features');
    refuseDescription(options.features, 'features');
    const allowed = new Set(['level','upsampling','upsamplingWeights','transforms','quantization','coefficientOrders',
      'progressive','noise','lfFrames']);
    for (const key of Object.keys(options.features)) if (!allowed.has(key)) throw fail('JXL_OPTIONS', `Unknown features option: ${key}.`);
  }
  const {fidelity: _fidelity, signal, onProgress, features, readAs, webgpu, maxPixels, ...codec} = options;
  return {...codec, ...fidelity, effort, webgpu, maxPixels};
}

export function callOptions({webgpu, maxPixels, ...codec}, hooks = {}) {
  return {codec, hooks: {...hooks, webgpu: webgpu ?? hooks.webgpu, maxPixels: Math.min(maxPixels ?? 40000000, hooks.maxPixels ?? 40000000)}};
}
