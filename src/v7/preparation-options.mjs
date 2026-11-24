// SPDX-License-Identifier: MIT
import {encodeOptions} from './encode-options.mjs';
import {featureless} from './first-region-option.mjs';
import {own} from './ownership.mjs';
import {fail, snapshotOptions, snapshotArray, pixelLimit, unknownOption} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {outputSides} from './preparation-sides.mjs';
import {PREVIEW} from './preview.mjs';

export function fitOptions(value, admitEncode = encodeOptions) {
  const {maxBytes, fidelity = {quality: 90}, ...encode} = featureless(snapshotOptions(value));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw fail('JXL_OPTIONS', 'maxBytes: positive integer');
  let minQuality, maxQuality, requestedFidelity;
  if (fidelity === 'exact') { minQuality = maxQuality = 100; requestedFidelity = 'exact'; }
  else {
    const fid = isPlainRecord(fidelity) ? snapshotOptions(fidelity, 'fidelity', [], true) : null;
    const keys = fid && Object.keys(fid);
    const quality = fid?.quality, range = typeof quality === 'number' ? {min: 1, max: quality} : isPlainRecord(quality) ? snapshotOptions(quality, 'quality', [], true) : null;
    if (!keys || keys.length !== 1 || keys[0] !== 'quality' || !range ||
        Object.keys(range).length !== 2 || !Object.hasOwn(range, 'min') || !Object.hasOwn(range, 'max'))
      throw fail('JXL_OPTIONS', "fidelity: 'exact', {quality} or {quality: {min, max}}");
    minQuality = range.min; maxQuality = range.max;
    if (!Number.isFinite(minQuality) || !Number.isFinite(maxQuality) || minQuality < 1 || maxQuality > 100 || minQuality > maxQuality)
      throw fail('JXL_OPTIONS', 'quality: 1 <= min <= max <= 100');
    requestedFidelity = {quality: {min: minQuality, max: maxQuality}};
  }
  admitEncode({...encode, fidelity: {quality: maxQuality}});
  pixelLimit(encode.maxPixels);
  const {signal, onProgress, onPreview, [PREVIEW]: preview, ...data} = encode;
  return {maxBytes, requestedFidelity, search: {minQuality, maxQuality, maxProbes: 12},
    encode: {...own(data), ...(signal !== undefined && {signal}), ...(onProgress !== undefined && {onProgress}),
      ...(onPreview !== undefined && {onPreview}), ...(preview && {[PREVIEW]: preview})}};
}

export function variantsOptions(value, admitEncode = encodeOptions) {
  const {outputs, ...shared} = snapshotOptions(value);
  if (isPlainRecord(shared.fidelity)) shared.fidelity = snapshotOptions(shared.fidelity, 'fidelity', [], true);
  admitEncode(shared);
  const maxPixels = pixelLimit(shared.maxPixels);
  if (!Array.isArray(outputs) || !outputs.length) throw fail('JXL_OPTIONS', 'outputs: nonempty array');
  const list = snapshotArray(outputs, 'outputs');
  const {signal, onProgress, onPreview, [PREVIEW]: preview, ...data} = shared;
  const common = {...own(data), signal, onProgress, ...(onPreview !== undefined && {onPreview}), ...(preview && {[PREVIEW]: preview})};
  const requests = list.map(item => {
    if (!isPlainRecord(item)) throw fail('JXL_OPTIONS', 'output: object');
    const {width, height, upscale, firstRegion, ...settings} = snapshotOptions(item, 'output', [], true);
    outputSides(width, height, maxPixels);
    if (upscale !== undefined && typeof upscale !== 'boolean') throw fail('JXL_OPTIONS', 'upscale: boolean');
    for (const key of Object.keys(settings)) if (!['fidelity', 'effort', 'progressive', 'jpeg', 'maxBytes'].includes(key))
      throw unknownOption(key, settings, 'output option');
    if (isPlainRecord(settings.fidelity)) {
      settings.fidelity = snapshotOptions(settings.fidelity, 'fidelity', [], true);
      if (isPlainRecord(settings.fidelity.quality)) settings.fidelity.quality = snapshotOptions(settings.fidelity.quality, 'quality', [], true);
    }
    const rawOptions = {...common, ...settings, ...(firstRegion !== undefined && {features: {firstRegion}})};
    if (settings.maxBytes !== undefined) return {width, height, upscale, policy: fitOptions(rawOptions, admitEncode)};
    admitEncode(rawOptions);
    const {signal: _s, onProgress: _p, onPreview: _v, [PREVIEW]: _pv, ...ownable} = rawOptions;
    const owned = {...own(ownable), signal, onProgress, ...(onPreview !== undefined && {onPreview}), ...(preview && {[PREVIEW]: preview})};
    return {width, height, upscale, options: owned};
  });
  return {requests, common, maxPixels};
}

