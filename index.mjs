// SPDX-License-Identifier: MIT
// Rapier JXL: a JPEG XL encoder in pure JavaScript, the one Rapier's page carries. This is the module's face for
// other apps; Rapier's own worker takes the modules directly (images/encoder.mjs). No WebAssembly, no build step,
// no dependency, nothing read or fetched at run time: pixels in, a bare codestream out.
import {inspectPixels, encodeLossless} from './lossless.mjs';
import {encodeLossy} from './lossy.mjs';
import {transcodeJPEG} from './vardct.mjs';
import {parseJPEG} from './jpeg.mjs';

// What one call takes at most: the 16 MiB codestream, 24 million pixels, 16,384 on a side. Larger asks are refused
// with a coded error before any work, the way a decoder would refuse them after it.
export const LIMITS = Object.freeze({bytes: 16 * 1024 * 1024, pixels: 24_000_000, edge: 16384});

const fault = (code, message) => Object.assign(new Error(message), {code});
function admitSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw fault('JXL_INPUT', 'A picture is at least one pixel wide and high, in whole pixels.');
  if (width > LIMITS.edge || height > LIMITS.edge) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + LIMITS.edge + ' pixels on a side.');
  if (width * height > LIMITS.pixels) throw fault('JXL_DIMENSIONS', 'A picture is at most ' + LIMITS.pixels.toLocaleString('en-US') + ' pixels.');
}
function admitPixels(data, width, height) {
  admitSize(width, height);
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) throw fault('JXL_INPUT', 'Pixels are a Uint8Array or Uint8ClampedArray of RGBA bytes.');
  if (data.length !== width * height * 4) throw fault('JXL_INPUT', 'Pixels are width * height * 4 bytes: straight (not premultiplied) RGBA, row by row.');
}
function answer(bytes) {
  if (bytes.length > LIMITS.bytes) throw fault('JXL_SIZE', 'The encoded picture exceeds 16 MiB.');
  return bytes;
}
function guard(work) {
  try { return work(); }
  catch (error) { if (error instanceof RangeError && !error.code) throw fault('JXL_MEMORY', 'Not enough memory for this picture.'); throw error; }
}

// Exact: every pixel comes back as it went in. An opaque alpha is dropped, a grey picture keeps one channel,
// up to 512 colours become a palette, colour goes through the reversible YCoCg transform.
export function encodeLosslessRGBA(data, width, height) {
  admitPixels(data, width, height);
  return guard(() => answer(encodeLossless(data, width, height, {shape: inspectPixels(data, width, height)})));
}

// Lossy modular at a quality from 1 to 99 (90 is libjxl's distance 1.0); a picture of few colours is answered
// exact when that is fewer bytes. Quality 100 is the lossless answer.
export function encodeLossyRGBA(data, width, height, quality = 90) {
  admitPixels(data, width, height);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw fault('JXL_INPUT', 'Quality is a number from 1 to 100.');
  return guard(() => {
    const shape = inspectPixels(data, width, height);
    if (quality >= 100) return answer(encodeLossless(data, width, height, {shape}));
    let bytes = encodeLossy(data, width, height, {quality, shape});
    if (shape.palette) { const exact = encodeLossless(data, width, height, {shape}); if (exact.length <= bytes.length) bytes = exact; }
    return answer(bytes);
  });
}

// One call for both: quality 100 (the default) is exact, anything lower is lossy.
export function encode(data, width, height, {quality = 100} = {}) {
  return quality >= 100 ? encodeLosslessRGBA(data, width, height) : encodeLossyRGBA(data, width, height, quality);
}

// A JPEG carried whole into JPEG XL: its coefficients, quantisation tables, colour and subsampling kept, only the
// entropy coding changed, so the picture decodes to the JPEG's own pixels at about a fifth fewer bytes. Baseline,
// extended sequential and progressive scans, with restarts; 8-bit; grey or YCbCr/RGB; an Exif orientation kept.
// A JPEG this path does not take (arithmetic coding, 12-bit, lossless, CMYK, a DNL height) is refused as
// JXL_JPEG; decode it and encode its pixels instead.
export function transcode(jpeg) {
  if (!(jpeg instanceof Uint8Array) || !jpeg.length) throw fault('JXL_INPUT', 'A JPEG is a non-empty Uint8Array.');
  if (jpeg.length > LIMITS.bytes) throw fault('JXL_SIZE', 'A JPEG is at most 16 MiB.');
  return guard(() => {
    const parsed = parseJPEG(jpeg);
    admitSize(parsed.width, parsed.height);
    const bytes = answer(transcodeJPEG(jpeg, parsed));
    const swapped = parsed.orientation >= 5;
    return {bytes, width: swapped ? parsed.height : parsed.width, height: swapped ? parsed.width : parsed.height, orientation: parsed.orientation};
  });
}

export {encodeLossless, encodeLossy, transcodeJPEG, parseJPEG, inspectPixels};
