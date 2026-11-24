import {fail, snapshotOptions} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';

const KEYS = ['x', 'y', 'width', 'height'];
export function featureless(options) {
  if (!isPlainRecord(options)) return options;
  const out = snapshotOptions(options);
  if (isPlainRecord(out.features)) out.features = snapshotOptions(out.features);
  if (isPlainRecord(out.features) && (out.features.upsampling === undefined || out.features.upsampling === 1) &&
      (Object.hasOwn(out.features, 'upsampling') || Object.hasOwn(out.features, 'upsamplingWeights'))) {
    const {upsampling: _factor, upsamplingWeights: _weights, ...rest} = out.features;
    out.features = rest;
  }
  if (isPlainRecord(out.features) && out.features.level === 5) { const {level: _level, ...rest} = out.features; out.features = rest; }
  if (isPlainRecord(out.features) && !Reflect.ownKeys(out.features).length) delete out.features;
  return out;
}
export function takeFirstRegion(given) {
  const options = featureless(given), requested = options?.features?.firstRegion;
  if (requested === undefined) return {options, region: undefined};
  const region = requested && typeof requested === 'object' ? snapshotOptions(requested, 'firstRegion', KEYS, true) : requested;
  if (!region || typeof region !== 'object' || KEYS.some(key => !Number.isSafeInteger(region[key]) || region[key] < (key === 'x' || key === 'y' ? 0 : 1)) ||
      Object.keys(requested).some(key => !KEYS.includes(key)))
    throw fail('JXL_OPTIONS', 'firstRegion: {x, y, width, height} in picture');
  const {firstRegion: _region, ...features} = options.features;
  return {region, options: {...options, features: Object.keys(features).length ? features : undefined}};
}
