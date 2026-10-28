export const fail = (code, message) => Object.assign(new Error(message), {code});
export function check(signal) { signal?.throwIfAborted(); }
export function object(value, name = 'Options') {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('JXL_OPTIONS', `${name} must be an object.`);
  return value;
}
export function dimensions(width, height, maxPixels = 40000000) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 16384 || height > 16384 || width * height > maxPixels)
    throw fail('JXL_DIMENSIONS', 'Image dimensions exceed the configured limit.');
}
export function bytes(input) {
  if (!(input instanceof Uint8Array) || !input.length) throw fail('JXL_INPUT', 'Encoded input must be a nonempty Uint8Array.');
  return input;
}
