// What the two services share: the integration's options, the cache key and Astro's named qualities.
import {baseService} from 'astro/assets';
import pkg from 'jpegxl/package.json' with {type: 'json'};

// Astro's named qualities, as its sharp service reads them.
const NAMED = {low: 25, mid: 50, high: 80, max: 100};

/** The integration's options with their defaults: effort 3 keeps a build within twice Astro's own; quality 72 is at least
 * the look of Astro's default WebP. maxPixels bounds what a Worker reads (default 12,600,000, a 12 MP phone photograph); a build has no bound. */
export function settings(config, workers) {
  const {effort = 3, quality = 72, jpeg = 'pixels', maxPixels = workers ? 12_600_000 : undefined} = config?.service?.config?.jxl ?? {};
  return {effort, quality, jpeg, maxPixels};
}

/** A quality asked on the component, as a number from 1 to 100, or undefined. */
export function asked(value) {
  if (value == null || value === '') return undefined;
  const number = NAMED[value] ?? (Number.isFinite(+value) ? +value : undefined);
  return number === undefined ? undefined : Math.min(100, Math.max(1, Math.round(number)));
}

/** Astro hashes these fields into each file's name and its build cache: the encoder's version and options join them. */
export const propertiesToHash = ['src', 'width', 'height', 'format', 'quality', 'fit', 'position', 'background', 'jxl'];

export function validateOptions(options, config) {
  const valid = baseService.validateOptions(options, config);
  if (valid.format === 'jxl') {
    const {effort, quality, jpeg} = settings(config);
    valid.jxl = `${pkg.version}:${effort}:${quality}:${jpeg}`;
  }
  return valid;
}

export function getHTMLAttributes(options, config) {
  const {jxl, ...rest} = options;
  return baseService.getHTMLAttributes(rest, config);
}

/** The result's bytes, or an error naming the picture and the JXL_* code. */
export function bytes(result, src) {
  if (result.bytes) return result.bytes;
  throw Object.assign(new Error(`${src}: ${result.reason.code} ${result.reason.message}`), {code: result.reason.code});
}
