// SPDX-License-Identifier: MIT
// Node's JPEG preparation, shared by the worker and the bounded resumable reader.
import {digest} from './digest.mjs';
const fail = (code, message) => Object.assign(new Error(message), {code});

// Pixels naming a space whose profile's rendering intent is not relative: the encoder writes that intent into the file.
export const namedColor = ({colorSpace = 'srgb', renderingIntent}) => ({space: 'rgb', whitePoint: 'd65', primaries: colorSpace, transferFunction: 'srgb', renderingIntent});
export const pixelColor = samples => samples.renderingIntent !== undefined ? {colorEncoding: namedColor(samples)} : samples.colorSpace ? {colorSpace: samples.colorSpace} : {};

export async function jpegPixels(bytes, input, {maxPixels, signal} = {}) {
  const [{recompress}, {decode}] = await Promise.all([import('jpegxl/jpeg'), import('jpegxl/decode')]);
  const kept = await recompress(bytes, {effort: 1, ...(maxPixels === undefined ? {} : {maxPixels})});
  if (!(kept?.bytes instanceof Uint8Array)) throw fail('JXL_UNSUPPORTED', "JPEG recompression failed; keep the original JPEG.");
  signal?.throwIfAborted();
  const image = await decode(kept.bytes, maxPixels === undefined ? {} : {maxPixels}), data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  if (data.length !== image.width * image.height * 4) throw fail('JXL_UNSUPPORTED', "JPEG unreadable here; pass pixels from a host reader.");
  const icc = image.rgbaICC instanceof Uint8Array && image.rgbaICC.byteLength > 0 && image.rgbaICC.byteLength <= 2048 ? image.rgbaICC : null;
  const enc = image.rgbaColorEncoding ?? {};
  const primaries = enc.space === 'gray' ? 'srgb' : enc.primaries;
  const colorSpace = !icc && (enc.whitePoint === undefined || enc.whitePoint === 'd65') && ['display-p3', 'rec2020'].includes(primaries) ? primaries : undefined;
  // The profile's own rendering intent (sRGB or Display P3, no ICC) travels with the pixels: the encoder writes it into the file's header.
  const renderingIntent = !icc && ['srgb', 'display-p3'].includes(primaries ?? 'srgb') && enc.renderingIntent !== undefined && enc.renderingIntent !== 1 ? enc.renderingIntent : undefined;
  const transferFunction = !icc && ['srgb', 'linear', 'pq', 'hlg'].includes(enc.transferFunction) && enc.transferFunction !== 'srgb' ? enc.transferFunction : undefined;
  const intensityTarget = typeof image.header?.toneMapping?.intensityTarget === 'number' && image.header.toneMapping.intensityTarget !== 255
    ? image.header.toneMapping.intensityTarget : undefined;
  const iccBase64 = icc ? Buffer.from(icc.buffer, icc.byteOffset, icc.byteLength).toString('base64') : undefined;
  const value = {data, icc, input: {generation: input.generation, sha256: await digest(data), byteLength: data.length, kind: 'pixels',
    width: image.width, height: image.height, ...(maxPixels !== undefined && {maxPixels}),
    ...(colorSpace && {colorSpace}), ...(renderingIntent !== undefined && {renderingIntent}), ...(transferFunction && {transferFunction}),
    ...(intensityTarget !== undefined && {intensityTarget}), ...(iccBase64 && {iccBase64})}};
  return value;
}
