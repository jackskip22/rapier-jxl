import {fail} from './primitives.mjs';

const KEYS = ['x', 'y', 'width', 'height'];
export function takeFirstRegion(options) {
  const requested = options?.features?.firstRegion;
  if (requested === undefined) return {options, region: undefined};
  const region = requested && typeof requested === 'object'
    ? {x: requested.x, y: requested.y, width: requested.width, height: requested.height} : requested;
  if (!region || typeof region !== 'object' || KEYS.some(key => !Number.isSafeInteger(region[key]) || region[key] < (key === 'x' || key === 'y' ? 0 : 1)) ||
      Object.keys(requested).some(key => !KEYS.includes(key)))
    throw fail('JXL_OPTIONS', 'firstRegion is {x, y, width, height}: whole pixels, inside the picture.');
  const {firstRegion: _region, ...features} = options.features;
  return {region, options: {...options, features: Object.keys(features).length ? features : undefined}};
}
