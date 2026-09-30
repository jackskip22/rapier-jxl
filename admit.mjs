// Rapier's JPEG XL encoder: what every door admits, and how each refuses. MIT (LICENSE).
// One owner for the checked doors: the options read before any work, the limits, the five codes, and the size and
// memory refusals after it. A module's door refuses the same way (writer.mjs).
import {LIMITS} from './bits.mjs';

export const fault = (code, message) => Object.assign(new Error(message), {code});

// The options every door reads, before any work: an object, or nothing; quality a number from 1 to 100, the door's
// own default when absent; the samples' colour space, the web platform's name for it, sRGB when absent.
export function admitOptions(options = {}, quality = 100) {
  if (options === null || typeof options !== 'object') throw fault('JXL_INPUT', 'Options are an object: {quality, colorSpace}.');
  if (options.quality !== undefined) quality = options.quality;
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 1 || quality > 100) throw fault('JXL_INPUT', 'Quality is a number from 1 to 100.');
  const colorSpace = options.colorSpace === undefined ? 'srgb' : options.colorSpace;
  if (colorSpace !== 'srgb' && colorSpace !== 'display-p3') throw fault('JXL_INPUT', 'The colour space is srgb or display-p3.');
  return {quality, colorSpace};
}

// A door's size, against the door's own limits (the core's when none are named).
export function admitSize(width, height, limits = LIMITS) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw fault('JXL_INPUT', 'A picture is at least one pixel wide and high, in whole pixels.');
  if (width > limits.edge || height > limits.edge) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + limits.edge + ' pixels on a side.');
  if (width * height > limits.pixels) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + limits.pixels.toLocaleString('en-US') + ' pixels.');
}

export function admitPixels(data, width, height, limits) {
  admitSize(width, height, limits);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Pixels are a Uint8Array or Uint8ClampedArray of RGBA bytes.');
  if (data.length !== width * height * 4) throw fault('JXL_INPUT', 'Pixels are width * height * 4 bytes: straight (not premultiplied) RGBA, row by row.');
}

export function answer(bytes) {
  if (bytes.length > LIMITS.bytes) throw fault('JXL_SIZE', 'The encoded picture exceeds 16 MiB.');
  return bytes;
}

// A plain RangeError from inside the work is the engine out of memory; a coded error passes through as it is.
export function guard(work) {
  try { return work(); }
  catch (error) { if (error instanceof RangeError && !error.code) throw fault('JXL_MEMORY', 'Not enough memory for this picture.'); throw error; }
}

// A door's work as a job: iterate it for the fraction done, in (0, 1], the last exactly 1, and read `bytes` after the
// last step (the job also returns them). Leaving the loop is a cancel with nothing to release. `hurry` asks a search to
// finish with the best candidate it has priced; effort 1 searches nothing, so its bytes are the same either way.
export function job(steps) {
  const it = (function* () {
    let step, last;
    while (!(step = guard(() => steps.next(it.hurry))).done) yield last = step.value;
    // A candidate given up (the stream limit, or memory for the lossy attempt beside an exact stream) ends early.
    if (last < 1) yield 1;
    return it.bytes = answer(step.value);
  })();
  it.bytes = null; it.hurry = false;
  return it;
}
