// SPDX-License-Identifier: MIT
import {encodeOptions} from './encode-options.mjs';
import {featureless} from './first-region-option.mjs';
import {own} from './ownership.mjs';
import {fail, object, pixelLimit} from './primitives.mjs';
import {outputSides} from './preparation-sides.mjs';
import {PREVIEW} from './preview.mjs';

export function fitOptions(value, admitEncode = encodeOptions) {
  const {maxBytes, fidelity = {quality: 90}, ...encode} = featureless(object(value));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw fail('JXL_OPTIONS', 'maxBytes is a positive safe integer.');
  let minQuality, maxQuality, requestedFidelity;
  if (fidelity === 'exact') { minQuality = maxQuality = 100; requestedFidelity = 'exact'; }
  else {
    const keys = fidelity && typeof fidelity === 'object' && Object.keys(fidelity);
    const quality = fidelity?.quality, range = typeof quality === 'number' ? {min: 1, max: quality} : quality;
    if (!keys || keys.length !== 1 || keys[0] !== 'quality' || !range || typeof range !== 'object' ||
        Array.isArray(range) || Object.keys(range).length !== 2 || !Object.hasOwn(range, 'min') || !Object.hasOwn(range, 'max'))
      throw fail('JXL_OPTIONS', "Fit fidelity is 'exact', {quality: max} or {quality: {min, max}}.");
    minQuality = range.min; maxQuality = range.max;
    if (!Number.isFinite(minQuality) || !Number.isFinite(maxQuality) || minQuality < 1 || maxQuality > 100 || minQuality > maxQuality)
      throw fail('JXL_OPTIONS', 'The quality range is finite and 1 <= min <= max <= 100.');
    requestedFidelity = typeof quality === 'number' ? {quality} : {quality: {min: minQuality, max: maxQuality}};
  }
  admitEncode({...encode, fidelity: {quality: maxQuality}});
  pixelLimit(encode.maxPixels);
  const {signal, onProgress, onPreview, [PREVIEW]: preview, ...data} = encode;
  return {maxBytes, requestedFidelity, search: {minQuality, maxQuality, maxProbes: 12},
    encode: {...own(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress}),
      ...(onPreview !== undefined && {onPreview}), ...(preview && {[PREVIEW]: preview})}};
}

export function variantsOptions(value, admitEncode = encodeOptions) {
  const {outputs, ...shared} = object(value);
  admitEncode(shared);
  const maxPixels = pixelLimit(shared.maxPixels);
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', 'outputs is a nonempty array of image requests.');
  const fixed = own(outputs), {signal, onProgress, onPreview, [PREVIEW]: preview, ...data} = shared;
  const common = {...own(data), signal, onProgress, ...(onPreview !== undefined && {onPreview}), ...(preview && {[PREVIEW]: preview})};
  const requests = fixed.map(output => {
    const {width, height, ...settings} = object(output, 'An output');
    outputSides(width, height, maxPixels);
    for (const key of Object.keys(settings)) if (!['fidelity', 'effort', 'features', 'maxBytes'].includes(key))
      throw fail('JXL_OPTIONS', `Unknown output option: ${key}.`);
    const options = {...common, ...settings};
    if (settings.maxBytes !== undefined) return {width, height, policy: fitOptions(options, admitEncode)};
    admitEncode(options);
    return {width, height, options};
  });
  return {requests, common, maxPixels};
}

