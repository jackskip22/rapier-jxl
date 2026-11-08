// SPDX-License-Identifier: MIT
// Workers Free delivery admission. This reads geometry, never pixels or a fidelity proof. JPEG XL container and
// codestream headers belong to the public metadata reader; only the original JPEG/PNG prefix is read here.
import {inspect} from 'rapier-jxl/metadata';
import {settings} from './media-settings.mjs';

export const SOURCE_HEADER_BYTES = 64 * 1024;
export const DELIVERY_BYTES = 8 * 1024 * 1024;
const SEGMENTS = 256;
const fail = (code, message) => Object.assign(new Error(message), {code});
const invalid = message => { throw fail('JXL_INPUT', message); };
const incomplete = () => { throw fail('JXL_UNSUPPORTED', 'The original geometry is not contained in its bounded header.'); };
const dimensions = (width, height, maxPixels) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > maxPixels)
    throw fail('JXL_LIMIT', 'The original geometry exceeds the pixel limit.');
};
function tiffOrientation(bytes) {
  const big = bytes[0] === 77 && bytes[1] === 77;
  if (bytes.length < 8 || !big && !(bytes[0] === 73 && bytes[1] === 73)) invalid('Invalid original Exif byte order.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, !big), u32 = at => view.getUint32(at, !big);
  if (u16(2) !== 42) invalid('Invalid original Exif signature.');
  const at = u32(4);
  if (at < 8 || at > bytes.length - 2) invalid('Invalid original Exif directory.');
  const count = u16(at);
  if (count > 512 || at + 2 + count * 12 + 4 > bytes.length) invalid('Invalid original Exif directory length.');
  let orientation = null;
  for (let i = 0, entry = at + 2; i < count; i++, entry += 12) if (u16(entry) === 274) {
    if (orientation !== null || u16(entry + 2) !== 3 || u32(entry + 4) !== 1)
      invalid('Invalid or repeated original Exif orientation.');
    orientation = u16(entry + 8);
    if (orientation < 1 || orientation > 8) invalid('Invalid original Exif orientation.');
  }
  return orientation ?? 1;
}
function jpegGeometry(bytes) {
  let at = 2, width, height, components, orientation = 1, exif = false;
  for (let count = 0; count < SEGMENTS; count++) {
    if (at >= bytes.length) incomplete();
    if (bytes[at++] !== 255) invalid('Invalid original JPEG marker.');
    while (at < bytes.length && bytes[at] === 255) at++;
    if (at >= bytes.length) incomplete();
    const marker = bytes[at++];
    if (marker === 1) continue;
    if (marker === 0 || marker === 216 || marker === 217 || marker >= 208 && marker <= 215)
      invalid('Invalid original JPEG header marker.');
    if (!(marker >= 192 && marker <= 207) && ![218, 219, 221, 254].includes(marker) && !(marker >= 224 && marker <= 239))
      invalid('Unknown original JPEG header marker.');
    if (at + 2 > bytes.length) incomplete();
    const length = bytes[at] * 256 + bytes[at + 1], body = at + 2, end = at + length;
    if (length < 2) invalid('Invalid original JPEG segment length.');
    if (end > bytes.length) incomplete();
    if ([192, 193, 194].includes(marker)) {
      if (width !== undefined || length < 11) invalid('Invalid or repeated original JPEG frame.');
      components = bytes[body + 5];
      if (![8, 12].includes(bytes[body]) || components < 1 || components > 4 || length !== 8 + 3 * components)
        invalid('Invalid original JPEG frame geometry.');
      height = bytes[body + 1] * 256 + bytes[body + 2]; width = bytes[body + 3] * 256 + bytes[body + 4];
    } else if ([195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
      throw fail('JXL_UNSUPPORTED', 'The original JPEG frame is not supported by structural delivery.');
    if (marker === 225 && [69, 120, 105, 102, 0, 0].every((value, i) => bytes[body + i] === value)) {
      if (exif) invalid('Repeated original Exif metadata.');
      exif = true; orientation = tiffOrientation(bytes.subarray(body + 6, end));
    }
    if (marker === 218) {
      const scans = bytes[body];
      if (width === undefined || scans < 1 || scans > components || length !== 6 + scans * 2)
        invalid('Invalid original JPEG scan header.');
      return {format: 'jpeg', width, height, orientation};
    }
    at = end;
  }
  throw fail('JXL_LIMIT', 'The original header exceeds its segment limit.');
}
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function pngGeometry(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, width, height, colour, palette = false, orientation = 1, exif = false;
  for (let count = 0; count < SEGMENTS; count++) {
    if (at + 8 > bytes.length) incomplete();
    const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = at + 8, end = body + length;
    if (length > 0x7fffffff) invalid('Invalid original PNG chunk length.');
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) invalid('Invalid original PNG chunk type.');
    if (!count && (type !== 'IHDR' || length !== 13)) invalid('The original PNG must start with IHDR.');
    if (type === 'IDAT') {
      if (width === undefined || colour === 3 && !palette) invalid('The original PNG header is incomplete.');
      return {format: 'png', width, height, orientation};
    }
    if (end + 4 > bytes.length) incomplete();
    let crc = 0xffffffff;
    for (let i = at + 4; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end)) invalid('Invalid original PNG header checksum.');
    if (type === 'IHDR') {
      if (count) invalid('Repeated original PNG image header.');
      width = view.getUint32(body); height = view.getUint32(body + 4); colour = bytes[body + 9];
      const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
      if (!depths[colour]?.includes(bytes[body + 8]) || bytes[body + 10] !== 0 || bytes[body + 11] !== 0 || bytes[body + 12] > 1)
        invalid('Invalid original PNG image header.');
    } else if (type === 'PLTE') {
      if (palette || !length || length > 768 || length % 3 || [0, 4].includes(colour)) invalid('Invalid original PNG palette.');
      palette = true;
    } else if (type === 'eXIf') {
      if (exif) invalid('Repeated original Exif metadata.');
      exif = true; orientation = tiffOrientation(bytes.subarray(body, end));
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type))
      throw fail('JXL_UNSUPPORTED', 'Animated originals require the server verification route.');
    else if (type[0] === type[0].toUpperCase()) invalid('Unexpected critical original PNG header chunk.');
    at = end + 4;
  }
  throw fail('JXL_LIMIT', 'The original header exceeds its segment limit.');
}

// Only pre-scan JPEG Exif and pre-IDAT PNG eXIf can be observed in this prefix. Structural admission is deliberately
// not a proof about metadata after image data, pixel equality, fidelity, or JPEG reconstruction.
export function originalGeometry(bytes, {mimeType, maxPixels = 24e6} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > SOURCE_HEADER_BYTES)
    throw fail('JXL_LIMIT', 'Expected one bounded original header.');
  const info = bytes[0] === 255 && bytes[1] === 216 ? jpegGeometry(bytes)
    : PNG.every((value, i) => bytes[i] === value) ? pngGeometry(bytes) : null;
  if (!info || mimeType !== `image/${info.format}`) invalid('The stored original does not match its image type.');
  dimensions(info.width, info.height, maxPixels);
  return {...info, displayWidth: info.orientation >= 5 ? info.height : info.width,
    displayHeight: info.orientation >= 5 ? info.width : info.height};
}

export async function structuralDelivery(result, original, selected, {width, maxPixels = 24e6} = {}) {
  const site = settings(selected), bytes = result?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > DELIVERY_BYTES)
    throw fail('JXL_LIMIT', 'The delivery exceeds its byte limit.');
  if (site.maxKilobytes && bytes.length > site.maxKilobytes * 1024)
    throw fail('JXL_TARGET', 'The copy exceeds the selected size limit.');
  const exact = result.fidelity === 'exact' || result.fidelity?.maxError === 0 || result.fidelity?.quality === 100;
  // Match the shared ImageResult exact endpoints: a payload cannot describe its own preservation as lossy while
  // promising exact pixels. This is metadata consistency, not server verification of the pixels.
  if (exact && result.kept === 'lossy')
    throw fail('JXL_INPUT', 'A lossy delivery cannot declare an exact fidelity promise.');
  if (!exact && (site.exact || !Number.isFinite(result.fidelity?.quality) || result.fidelity.quality > 100 ||
      result.fidelity.quality < (site.maxKilobytes ? 1 : site.quality)))
    throw fail('JXL_TARGET', 'The copy does not meet the captured fidelity setting.');
  if (width !== undefined && (!site.widths.includes(width) || width >= original.displayWidth))
    throw fail('JXL_DIMENSIONS', 'The responsive width is not in the captured image settings.');
  const expectedWidth = width ?? original.displayWidth;
  const expectedHeight = width === undefined ? original.displayHeight : Math.max(1, Math.round(width * original.displayHeight / original.displayWidth));
  dimensions(expectedWidth, expectedHeight, maxPixels);
  if (result?.format !== 'jxl' || result.fits !== true || result.width !== expectedWidth || result.height !== expectedHeight)
    throw fail('JXL_DIMENSIONS', 'The delivery does not have the server-derived image geometry.');
  const info = await inspect(bytes, {details: ['layout'], maxInputBytes: DELIVERY_BYTES, maxPixels, maxBoxes: SEGMENTS});
  const shownWidth = info.orientation >= 5 ? info.height : info.width, shownHeight = info.orientation >= 5 ? info.width : info.height;
  if (info.animation || shownWidth !== expectedWidth || shownHeight !== expectedHeight)
    throw fail('JXL_DIMENSIONS', 'The delivery header differs from the server-derived image geometry.');
  if (result.kept === 'jpeg-bytes') {
    if (width !== undefined || original.format !== 'jpeg' || result.fidelity !== 'exact' || !info.reconstruction)
      throw fail('JXL_INPUT', 'The JPEG delivery header does not describe JPEG reconstruction.');
  } else if (!['pixels', 'lossy'].includes(result.kept))
    throw fail('JXL_INPUT', 'Expected a pixel delivery result.');
  // The browser may normalize orientation into pixels. Compare displayed geometry; literal tag equality would
  // reject an equivalent normalized result. Pixel/orientation equivalence itself is the browser verifier's claim.
  return {kind: 'structural', scope: 'delivery', browserVerification: 'informational',
    original: {width: original.width, height: original.height, orientation: original.orientation},
    output: {width: expectedWidth, height: expectedHeight, orientation: info.orientation}};
}
