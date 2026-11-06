// SPDX-License-Identifier: MIT
import {typedName} from './bytes.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';

export const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
export function sampleDescription(picture, data = picture.data ?? picture.frames?.[0]?.data) {
  const type = typedName.call(data), sampleFormat = picture.sampleFormat ?? (type === 'Float32Array' ? 'float32' : type === 'Float16Array' ? 'float16' : 'uint');
  const bitDepth = picture.bitDepth ?? (sampleFormat === 'float32' ? 32 : type === 'Uint16Array' || sampleFormat === 'float16' ? 16 : 8);
  const curve = picture.colorEncoding?.transferFunction ?? picture.transferFunction ?? (sampleFormat === 'uint' ? 'srgb' : 'linear');
  return {sampleFormat, bitDepth,
    colorSpace: picture.icc || picture.colorEncoding ? undefined : picture.colorSpace ?? 'srgb',
    transferFunction: picture.icc || picture.colorEncoding ? undefined : curve,
    intensityTarget: picture.intensityTarget ?? (curve === 'pq' ? 10000 : curve === 'hlg' ? 1000 : 255),
    alphaPremultiplied: picture.alphaPremultiplied ?? false, orientation: picture.orientation ?? 1};
}
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
export async function storedIdentity({kind, width, height, colorSpace, sha256}) {
  const digest = 'sha256:' + sha256;
  if (kind === 'file' || width === undefined) return {kind: 'bytes', digest};
  const text = new TextEncoder().encode(JSON.stringify(stable({width, height,
    ...sampleDescription({...(colorSpace && {colorSpace})}, new Uint8Array(0)), data: digest})));
  const sum = globalThis.crypto?.subtle ? hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', text)))
    : sha256Finish(sha256Update(sha256Start(), text));
  return {kind: 'pixels', digest: 'sha256:' + sum};
}
