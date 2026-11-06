// SPDX-License-Identifier: MIT
import {dimensions, fail} from './primitives.mjs';
import {SIGNATURE, boxes, RECONSTRUCTION} from '../container.mjs';
import {useJpegDisplay} from './result.mjs';

export function jpegDisplayDimensions(bytes, maxPixels) {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw fail('JXL_JPEG', 'Input is not a JPEG.');
  let width, height, orientation = null;
  for (let at = 2; at < bytes.length;) {
    if (bytes[at++] !== 255) throw fail('JXL_JPEG', 'Invalid JPEG marker.');
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const length = bytes[at] * 256 + bytes[at + 1], end = at + length, start = at + 2;
    if (!Number.isInteger(length) || length < 2 || end > bytes.length) throw fail('JXL_JPEG', 'JPEG segment is incomplete.');
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      if (length < 8) throw fail('JXL_JPEG', 'JPEG dimensions are incomplete.');
      height = bytes[start + 1] * 256 + bytes[start + 2]; width = bytes[start + 3] * 256 + bytes[start + 4];
    }
    if (marker === 225 && end - start >= 6 && [69,120,105,102,0,0].every((byte, i) => bytes[start + i] === byte))
      orientation ??= exifOrientation(bytes, start + 6, end);
    at = end;
    if (marker === 218) {
      while (at < bytes.length) {
        if (bytes[at] !== 255) { at++; continue; }
        let next = at + 1; while (bytes[next] === 255) next++;
        if (bytes[next] === 0 || bytes[next] >= 208 && bytes[next] <= 215) { at = next + 1; continue; }
        break;
      }
    }
  }
  if (width === undefined || height === undefined) throw fail('JXL_JPEG', 'JPEG dimensions are missing.');
  dimensions(width, height, maxPixels);
  return orientation >= 5 ? {width: height, height: width} : {width, height};
}

export function exifOrientation(bytes, start, end) {
  const big = bytes[start] === 77 && bytes[start + 1] === 77;
  if (!big && !(bytes[start] === 73 && bytes[start + 1] === 73)) return null;
  const u16 = at => at + 2 > end ? 0 : big ? bytes[at] * 256 + bytes[at + 1] : bytes[at] + bytes[at + 1] * 256;
  const u32 = at => at + 4 > end ? 0 : big ? (bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3]) : (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216);
  if (u16(start + 2) !== 42 || u32(start + 4) < 8) return null;
  const ifd = start + u32(start + 4), entries = u16(ifd);
  for (let i = 0, at = ifd + 2; i < entries && at + 12 <= end; i++, at += 12) {
    const value = u16(at + 8);
    if (u16(at) === 274 && u16(at + 2) === 3 && u32(at + 4) === 1 && value >= 1 && value <= 8) return value;
  }
  return null;
}

export function jpegReconstruction(bytes) {
  if (!(bytes instanceof Uint8Array) || !SIGNATURE.every((byte, i) => bytes[i] === byte)) return undefined;
  for (const {type, body, end} of boxes(bytes)) if (type === RECONSTRUCTION && end > body) return 'jpeg';
  return undefined;
}

useJpegDisplay(jpegDisplayDimensions);
