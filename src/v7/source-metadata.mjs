// SPDX-License-Identifier: MIT
import {exifOrientation} from '../exif-orientation.mjs';
import {fail, declared, blobBytes, isBlob} from './primitives.mjs';
import {viewBytes} from './bytes.mjs';

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
const XAP = 'http://ns.adobe.com/xap/1.0/\0', PNG_XMP = 'XML:com.adobe.xmp\0', LIMIT = 16 * 1024 * 1024;
const text = new TextDecoder();

function upright(tiff) {
  const exif = new Uint8Array(tiff);
  let position = -1, big = false;
  if (exifOrientation(exif, 0, exif.length, (at, isBig) => { position = at; big = isBig; }) !== null && position >= 0) {
    exif[position] = big ? 0 : 1; exif[position + 1] = big ? 1 : 0;
  }
  return exif;
}
const tiffOf = (data, prefixed = true) => {
  const at = prefixed && ascii(data, 0, 6) === 'Exif\0\0' ? 6 : 0, little = data[at] === 73;
  if (data.length < at + 8 || data[at] !== data[at + 1] || !little && data[at] !== 77) return null;
  const view = new DataView(data.buffer, data.byteOffset + at, data.length - at), ifd = view.getUint32(4, little);
  return view.getUint16(2, little) === 42 && ifd >= 8 && ifd + 2 <= data.length - at ? data.subarray(at) : null;
};

function fromJpeg(bytes, found) {
  let exifSeen = false;
  for (let at = 2; at + 4 <= bytes.length && bytes[at] === 255;) {
    if (bytes[at + 1] === 255) { at++; continue; }
    const marker = bytes[at + 1];
    if (marker === 218 || marker === 217) break;
    if (marker === 1 || marker >= 208 && marker <= 215) { at += 2; continue; }
    const length = bytes[at + 2] << 8 | bytes[at + 3], end = at + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 225) {
      const body = bytes.subarray(at + 4, end);
      if (ascii(body, 0, 6) === 'Exif\0\0') { if (!exifSeen) found.exif = tiffOf(body); exifSeen = true; }
      else if (ascii(body, 0, XAP.length) === XAP) found.xmp ??= body.subarray(XAP.length);
    }
    at = end;
  }
}
function fromPng(bytes, found) {
  let pixels = false, exifSeen = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at), type = ascii(bytes, at + 4, 4);
    if (length > 0x7fffffff || at + 12 + length > bytes.length || type === 'IEND') break;
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') pixels = true;
    else if (type === 'eXIf' && !pixels && !exifSeen) { found.exif = tiffOf(body, false); exifSeen = true; }
    else if (type === 'iTXt' && body.length >= PNG_XMP.length + 4 && ascii(body, 0, PNG_XMP.length) === PNG_XMP &&
        body[PNG_XMP.length] === 0 && body[PNG_XMP.length + 1] === 0) {
      let from = PNG_XMP.length + 2, zeros = 0;
      for (; zeros < 2 && from < body.length; from++) if (body[from] === 0) zeros++;
      if (zeros === 2) found.xmp ??= body.subarray(from);
    }
    at += 12 + length;
  }
}
function fromRiff(bytes, found) {
  let exifSeen = false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  for (let at = 12; at + 8 <= end;) {
    const type = ascii(bytes, at, 4), length = view.getUint32(at + 4, true);
    if (at + 8 + length > end) break;
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'EXIF' && !exifSeen) { found.exif = tiffOf(body); exifSeen = true; }
    else if (type === 'XMP ') found.xmp ??= body;
    at += 8 + length + (length & 1);
  }
}

export async function sourceMetadata(input) {
  try {
    const bytes = isBlob(input) ? await blobBytes(input) : viewBytes(input);
    if (bytes.length > 1024 * 1024 * 1024) throw fail('JXL_LIMIT', 'sourceMetadata: file too large');
    const found = {};
    if (bytes[0] === 255 && bytes[1] === 216) fromJpeg(bytes, found);
    else if (bytes[0] === 137 && ascii(bytes, 1, 3) === 'PNG') {
      if (ascii(bytes, 4, 4) !== '\r\n\x1a\n') throw fail('JXL_INPUT', 'sourceMetadata: a PNG signature');
      fromPng(bytes, found);
    }
    else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') fromRiff(bytes, found);
    else throw fail('JXL_INPUT', 'sourceMetadata: a JPEG, PNG or WebP file');
    const exif = found.exif && found.exif.length <= LIMIT, xmp = found.xmp?.length > 0 && found.xmp.length <= LIMIT;
    return exif || xmp ? {...(exif && {exif: upright(found.exif)}), ...(xmp && {xmp: text.decode(found.xmp)})} : null;
  } catch (error) { throw declared(error); }
}
