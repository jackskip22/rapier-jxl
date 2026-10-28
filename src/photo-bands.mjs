// SPDX-License-Identifier: MIT
import {complete} from './bits.mjs';
import {photoXYBSteps, gaborishPlanes} from './photo-xyb.mjs';
import {offloading, offloadWorkers, sharing, shareable} from './offload.mjs';

export const PHOTO_BAND_MARGIN = 8;

export function photoXYBBand(data, width, height, quality, options, top = 0) {
  const W = Math.ceil(width / 8) * 8, H = Math.ceil(height / 8) * 8;
  const all = gaborishPlanes(data, width, data.length / 4 / width, options);
  const pre = all.map(p => p.subarray(top * W, (top + H) * W));
  return complete(photoXYBSteps(data.subarray(top * width * 4, (top + height) * width * 4), width, height, quality, {...options, pre}));
}

export function appendPhotoBand(image, result, width, height, y, data, colorSpace = result.colorSpace, target = null) {
  if (!image) {
    if (y === 0 && result.height === height && !target) return {...result, colorSpace, alpha: result.alpha ? data : null};
    const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
    image = {...result, width, height, colorSpace, alpha: null, nonZero: target?.nonZero ?? null, placed: undefined,
      components: result.components.map((c, k) => ({...c, rows, coeffs: target?.coeffs[k] ?? shareable(Int16Array, stride * rows * 64)}))};
    if (result.cfl) {
      const size = result.cfl.width * Math.ceil(height / 64);
      image.cfl = {width: result.cfl.width, x: target?.cfl.x ?? shareable(Int8Array, size), b: target?.cfl.b ?? shareable(Int8Array, size)};
    }
  }
  if (!result.placed) placeBand(image, result, width, y);
  if (result.alpha) image.alpha = data;
  return image;
}
export function placeBand(image, result, width, y) {
  result.components.forEach((c, k) => image.components[k].coeffs.set(c.coeffs, y / 8 * c.stride * 64));
  if (result.cfl) {
    const offset = y / 64 * result.cfl.width;
    image.cfl.x.set(result.cfl.x, offset); image.cfl.b.set(result.cfl.b, offset);
  }
  if (result.nonZero) {
    image.nonZero ||= result.nonZero.map(() => shareable(Uint8Array, Math.ceil(width / 8) * Math.ceil(image.height / 8)));
    result.nonZero.forEach((n, c) => image.nonZero[c].set(n, y / 8 * Math.ceil(width / 8)));
  }
}
function bandTarget(width, height, nonZero) {
  if (!sharing()) return null;
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8), tiles = Math.ceil(width / 64) * Math.ceil(height / 64);
  return {coeffs: [0, 1, 2].map(() => shareable(Int16Array, blocks * 64)), cfl: {x: shareable(Int8Array, tiles), b: shareable(Int8Array, tiles)},
    nonZero: nonZero ? [0, 1, 2].map(() => shareable(Uint8Array, blocks)) : null};
}

export function* photoFastBands(data, width, height, quality, options) {
  const bandHeight = Math.max(64, Math.floor(262144 / width / 64) * 64), bands = [];
  const target = bandTarget(width, height, true);
  for (let y = 0; y < height; y += bandHeight) bands.push({kind: 'fast-band', data, width, h: Math.min(bandHeight, height - y), quality, y, target});
  yield {offload: 'prefetch', tasks: bands, at: done => done};
  let image;
  for (const band of bands) {
    const {h, y} = band, remote = yield {offload: 'run', task: band, at: () => y / height};
    const result = remote ? {...remote, colorSpace: 'srgb'} : complete(photoXYBSteps(data.subarray(y * width * 4, (y + h) * width * 4), width, h, quality, options));
    image = appendPhotoBand(image, result, width, height, y, data, undefined, target);
    yield (y + h) / height;
  }
  return image;
}

export function* photoXYBBands(data, width, height, quality, options, color) {
  color = offloading() ? color : undefined;
  const serial = Math.max(64, Math.floor(1048576 / width / 64) * 64), rounds = Math.ceil(Math.ceil(height / serial) / offloadWorkers());
  const bandHeight = color ? Math.max(64, Math.ceil(height / (rounds * offloadWorkers()) / 64) * 64) : serial, bands = [], target = color && bandTarget(width, height, false);
  for (let y = 0; y < height; y += bandHeight) {
    const h = Math.min(bandHeight, height - y);
    bands.push({kind: 'band', data, width, h, quality, color, from: Math.max(0, y - PHOTO_BAND_MARGIN), to: Math.min(height, y + h + PHOTO_BAND_MARGIN), y, target});
  }
  if (color) yield {offload: 'prefetch', tasks: bands, at: done => done};
  let image, opaque = true;
  if (target) for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  for (const band of bands) {
    const {h, from, to, y} = band, remote = color && (yield {offload: 'run', task: band, at: () => y / height});
    const result = remote ? {...remote, colorSpace: options.space ?? 'srgb'} : photoXYBBand(data.subarray(from * width * 4, to * width * 4), width, h, quality, options, y - from);
    const first = !image;
    image = appendPhotoBand(image, result, width, height, y, data, undefined, target);
    if (first && target && bands.length > 1) { image.alpha = opaque ? null : data; yield {offload: 'image', image, bands, at: () => (y + h) / height}; }
    yield (y + h) / height;
  }
  return image;
}
