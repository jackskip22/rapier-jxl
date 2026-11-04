import {fail} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';

const KEYS = ['x', 'y', 'width', 'height'];
export function featureless(options) {
  if (!isPlainRecord(options)) return options;
  const out = {};
  for (const key of Reflect.ownKeys(options)) if (Object.prototype.propertyIsEnumerable.call(options, key)) out[key] = options[key];
  if (isPlainRecord(out.features) && !Reflect.ownKeys(out.features).length) delete out.features;
  return out;
}
export function takeFirstRegion(given) {
  const options = featureless(given), requested = options?.features?.firstRegion;
  if (requested === undefined) return {options, region: undefined};
  const region = requested && typeof requested === 'object'
    ? {x: requested.x, y: requested.y, width: requested.width, height: requested.height} : requested;
  if (!region || typeof region !== 'object' || KEYS.some(key => !Number.isSafeInteger(region[key]) || region[key] < (key === 'x' || key === 'y' ? 0 : 1)) ||
      Object.keys(requested).some(key => !KEYS.includes(key)))
    throw fail('JXL_OPTIONS', 'firstRegion is {x, y, width, height} in whole pixels, inside the picture.');
  const {firstRegion: _region, ...features} = options.features;
  return {region, options: {...options, features: Object.keys(features).length ? features : undefined}};
}
