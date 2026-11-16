// SPDX-License-Identifier: MIT
// Workers Free delivery admission. This reads geometry, never pixels or a fidelity proof. JPEG XL container and
// codestream headers belong to the public metadata reader; only the original JPEG/PNG prefix is read here.
import {inspect} from 'jpegxl/metadata';
import {settings} from './media-settings.mjs';

export const SOURCE_HEADER_BYTES = 64 * 1024;
export const EXTENDED_SOURCE_HEADER_BYTES = 256 * 1024;
export const DELIVERY_BYTES = 8 * 1024 * 1024;
const SEGMENTS = 256;
const fail = (code, message) => Object.assign(new Error(message), {code});
const invalid = message => { throw fail('JXL_INPUT', message); };
const incomplete = () => { throw Object.assign(fail('JXL_UNSUPPORTED', "Missing dimensions; use server verification."), {incomplete: true}); };
const dimensions = (width, height, maxPixels) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(width * height) || maxPixels !== undefined && width * height > maxPixels)
    throw fail('JXL_LIMIT', "Invalid dimensions; use safe positive integers within maxPixels.");
};
function tiffOrientation(bytes) {
  const big = bytes[0] === 77 && bytes[1] === 77;
  if (bytes.length < 8 || !big && !(bytes[0] === 73 && bytes[1] === 73)) invalid("Invalid Exif byte order; use valid Exif.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, !big), u32 = at => view.getUint32(at, !big);
  if (u16(2) !== 42) invalid("Invalid Exif signature; use valid Exif.");
  const at = u32(4);
  if (at < 8 || at > bytes.length - 2) invalid("Invalid Exif directory; use valid Exif.");
  const count = u16(at);
  if (count > 512 || at + 2 + count * 12 + 4 > bytes.length) invalid("Invalid Exif directory length; use valid Exif.");
  let orientation = null;
  for (let i = 0, entry = at + 2; i < count; i++, entry += 12) if (u16(entry) === 274) {
    if (orientation !== null || u16(entry + 2) !== 3 || u32(entry + 4) !== 1)
      invalid("Invalid or repeated Exif orientation; use valid Exif.");
    orientation = u16(entry + 8);
    if (orientation < 1 || orientation > 8) invalid("Invalid Exif orientation; use valid Exif.");
  }
  return orientation ?? 1;
}
function jpegGeometry(bytes) {
  let at = 2, width, height, components, orientation = 1, exif = false;
  for (let count = 0; count < SEGMENTS; count++) {
    if (at >= bytes.length) incomplete();
    if (bytes[at++] !== 255) invalid("Invalid JPEG marker; use a valid JPEG.");
    while (at < bytes.length && bytes[at] === 255) at++;
    if (at >= bytes.length) incomplete();
    const marker = bytes[at++];
    if (marker === 1) continue;
    if (marker === 0 || marker === 216 || marker === 217 || marker >= 208 && marker <= 215)
      invalid("Invalid JPEG header marker; use a valid JPEG.");
    if (!(marker >= 192 && marker <= 207) && ![218, 219, 221, 254].includes(marker) && !(marker >= 224 && marker <= 239))
      invalid("Unknown JPEG header marker; use a valid JPEG.");
    if (at + 2 > bytes.length) incomplete();
    const length = bytes[at] * 256 + bytes[at + 1], body = at + 2, end = at + length;
    if (length < 2) invalid("Invalid JPEG segment length; use a valid JPEG.");
    if (end > bytes.length) incomplete();
    if ([192, 193, 194].includes(marker)) {
      if (width !== undefined || length < 11) invalid("Invalid or repeated JPEG frame; use a valid JPEG.");
      components = bytes[body + 5];
      if (![8, 12].includes(bytes[body]) || components < 1 || components > 4 || length !== 8 + 3 * components)
        invalid("Invalid JPEG frame geometry; use a valid JPEG.");
      height = bytes[body + 1] * 256 + bytes[body + 2]; width = bytes[body + 3] * 256 + bytes[body + 4];
    } else if ([195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
      throw fail('JXL_UNSUPPORTED', "JPEG delivery unsupported; use server verification.");
    if (marker === 225 && [69, 120, 105, 102, 0, 0].every((value, i) => bytes[body + i] === value)) {
      if (exif) invalid("Repeated Exif metadata; use one Exif block.");
      exif = true; orientation = tiffOrientation(bytes.subarray(body + 6, end));
    }
    if (marker === 218) {
      const scans = bytes[body];
      if (width === undefined || scans < 1 || scans > components || length !== 6 + scans * 2)
        invalid("Invalid JPEG scan header; use a valid JPEG.");
      return {format: 'jpeg', width, height, orientation};
    }
    at = end;
  }
  throw fail('JXL_LIMIT', "Header too large; use server verification.");
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
    if (length > 0x7fffffff) invalid("Invalid PNG chunk length; use a valid PNG.");
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) invalid("Invalid PNG chunk type; use a valid PNG.");
    if (!count && (type !== 'IHDR' || length !== 13)) invalid("PNG must start with IHDR; use a valid PNG.");
    if (type === 'IDAT') {
      if (width === undefined || colour === 3 && !palette) invalid("Incomplete PNG header; use a valid PNG.");
      return {format: 'png', width, height, orientation};
    }
    if (end + 4 > bytes.length) incomplete();
    let crc = 0xffffffff;
    for (let i = at + 4; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end)) invalid("Invalid PNG header checksum; use a valid PNG.");
    if (type === 'IHDR') {
      if (count) invalid("Repeated PNG image header; use a valid PNG.");
      width = view.getUint32(body); height = view.getUint32(body + 4); colour = bytes[body + 9];
      const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
      if (!depths[colour]?.includes(bytes[body + 8]) || bytes[body + 10] !== 0 || bytes[body + 11] !== 0 || bytes[body + 12] > 1)
        invalid("Invalid PNG image header; use a valid PNG.");
    } else if (type === 'PLTE') {
      if (palette || !length || length > 768 || length % 3 || [0, 4].includes(colour)) invalid("Invalid PNG palette; use a valid PNG.");
      palette = true;
    } else if (type === 'eXIf') {
      if (exif) invalid("Repeated Exif metadata; use one Exif block.");
      exif = true; orientation = tiffOrientation(bytes.subarray(body, end));
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type))
      throw fail('JXL_UNSUPPORTED', "Animated image; use server verification.");
    else if (type[0] === type[0].toUpperCase()) invalid("Unexpected critical PNG header chunk; use a valid PNG.");
    at = end + 4;
  }
  throw fail('JXL_LIMIT', "Header too large; use server verification.");
}

// Only pre-scan JPEG Exif and pre-IDAT PNG eXIf can be observed in this prefix. Structural admission is deliberately
// not a proof about metadata after image data, pixel equality, fidelity, or JPEG reconstruction.
export function originalGeometry(bytes, {mimeType, maxPixels, maxHeaderBytes = SOURCE_HEADER_BYTES} = {}) {
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 8 || maxHeaderBytes > EXTENDED_SOURCE_HEADER_BYTES)
    throw fail('JXL_OPTIONS', "Invalid header limit; use a bounded size.");
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > maxHeaderBytes)
    throw fail('JXL_LIMIT', "Missing or large header; use server verification.");
  const info = bytes[0] === 255 && bytes[1] === 216 ? jpegGeometry(bytes)
    : PNG.every((value, i) => bytes[i] === value) ? pngGeometry(bytes) : null;
  if (!info || mimeType !== `image/${info.format}`) invalid("Original bytes mismatch their type; supply the matching original.");
  dimensions(info.width, info.height, maxPixels);
  return {...info, displayWidth: info.orientation >= 5 ? info.height : info.width,
    displayHeight: info.orientation >= 5 ? info.width : info.height};
}

export function headerIncomplete(bytes, mimeType) {
  try { originalGeometry(bytes, {mimeType, maxHeaderBytes: EXTENDED_SOURCE_HEADER_BYTES}); return false; }
  catch (error) { return error?.incomplete === true; }
}

export async function structuralDelivery(result, original, selected, {width, maxPixels} = {}) {
  const site = settings(selected), bytes = result?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > DELIVERY_BYTES)
    throw fail('JXL_LIMIT', "Delivery too large; use server verification.");
  if (site.maxKilobytes && bytes.length > site.maxKilobytes * 1024)
    throw fail('JXL_TARGET', "Copy exceeds its size target; regenerate for that target.");
  const exact = result.fidelity === 'exact' || result.fidelity?.maxError === 0 || result.fidelity?.quality === 100;
  // Match the shared ImageResult exact endpoints: a payload cannot describe its own preservation as lossy while
  // promising exact pixels. This is metadata consistency, not server verification of the pixels.
  if (exact && result.kept === 'lossy')
    throw fail('JXL_INPUT', "Lossy delivery; declare its measured quality.");
  if (!exact && (site.exact || !Number.isFinite(result.fidelity?.quality) || result.fidelity.quality > 100 ||
      result.fidelity.quality < (site.maxKilobytes ? 1 : site.quality)))
    throw fail('JXL_TARGET', "Copy misses its fidelity target; regenerate for that target.");
  if (width !== undefined && (!site.widths.includes(width) || width >= original.displayWidth))
    throw fail('JXL_DIMENSIONS', "Unconfigured width; use a configured one.");
  const expectedWidth = width ?? original.displayWidth;
  const expectedHeight = width === undefined ? original.displayHeight : Math.max(1, Math.round(width * original.displayHeight / original.displayWidth));
  dimensions(expectedWidth, expectedHeight, maxPixels);
  if (result?.format !== 'jxl' || result.meetsTarget !== true || result.width !== expectedWidth || result.height !== expectedHeight)
    throw fail('JXL_DIMENSIONS', "Delivery dimensions differ; regenerate with current settings.");
  const info = await inspect(bytes, {details: ['layout'], maxInputBytes: DELIVERY_BYTES, maxPixels, maxBoxes: SEGMENTS});
  const shownWidth = info.orientation >= 5 ? info.height : info.width, shownHeight = info.orientation >= 5 ? info.width : info.height;
  if (info.animation || shownWidth !== expectedWidth || shownHeight !== expectedHeight)
    throw fail('JXL_DIMENSIONS', "Header dimensions differ; regenerate with current settings.");
  if (result.kept === 'jpeg-bytes') {
    if (width !== undefined || original.format !== 'jpeg' || result.fidelity !== 'exact' || !info.reconstruction)
      throw fail('JXL_INPUT', "Missing JPEG reconstruction; use recompress().");
  } else if (!['pixels', 'lossy'].includes(result.kept))
    throw fail('JXL_INPUT', "Invalid delivery; use a pixel-encoding result.");
  // The browser may normalize orientation into pixels. Compare displayed geometry; literal tag equality would
  // reject an equivalent normalized result. Pixel/orientation equivalence itself is the browser verifier's claim.
  return {kind: 'structural', scope: 'delivery', browserVerification: 'informational',
    original: {width: original.width, height: original.height, orientation: original.orientation},
    output: {width: expectedWidth, height: expectedHeight, orientation: info.orientation}};
}
