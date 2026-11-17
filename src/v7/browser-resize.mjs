// SPDX-License-Identifier: MIT
import {check, fail} from './primitives.mjs';
import {admitSampleDomain} from '../sample-domain.mjs';

const BROWSER_READ = /* @__PURE__ */ new WeakSet();
export const browserRead = data => { BROWSER_READ.add(data); };
const hosted = () => typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && typeof ImageData === 'function';
export function browserResizable(picture, fromFile = false) {
  if (!hosted() || !(picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray) || fromFile && !BROWSER_READ.has(picture.data) ||
      picture.extraChannels !== undefined || picture.colorEncoding !== undefined || (picture.orientation ?? 1) !== 1) return false;
  let samples;
  try { samples = admitSampleDomain(picture.data, picture.icc ? {...picture, icc: undefined, colorSpace: 'srgb'} : picture); } catch { return false; }
  return samples.bitDepth === 8 && samples.transferFunction === 'srgb' && !samples.alphaPremultiplied && samples.intensityTarget === 255 &&
    (samples.colorSpace === 'srgb' || samples.colorSpace === 'display-p3');
}
const spaceOf = picture => picture.icc === undefined && picture.colorSpace === 'display-p3' ? 'display-p3' : 'srgb';
const bitmapOf = picture => createImageBitmap(new ImageData(new Uint8ClampedArray(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength),
  picture.width, picture.height, {colorSpace: spaceOf(picture)}), {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
const resized = (bitmap, width, height) => createImageBitmap(bitmap, {resizeWidth: width, resizeHeight: height, resizeQuality: 'high'});
function pixelsOf(bitmap, picture) {
  const {width, height} = bitmap, colorSpace = spaceOf(picture), canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', {willReadFrequently: true, colorSpace});
  if (!context) throw fail('JXL_UNSUPPORTED', 'no 2D canvas resize: pass resized pixels');
  context.drawImage(bitmap, 0, 0);
  const {data} = context.getImageData(0, 0, width, height, {colorSpace});
  const {data: _data, width: _width, height: _height, ...description} = picture;
  return {...description, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width, height};
}
export function browserParents(sizes, picture) {
  return sizes.map((s, i) => {
    const same = sizes.findIndex(t => t.width === s.width && t.height === s.height);
    if (same !== i) return same;
    let best = -1;
    for (let j = 0; j < sizes.length; j++) {
      const t = sizes[j];
      if (j === i || sizes.findIndex(u => u.width === t.width && u.height === t.height) !== j ||
          t.width < 2 * s.width || t.height < 2 * s.height || t.width >= picture.width && t.height >= picture.height) continue;
      if (best < 0 || t.width * t.height < sizes[best].width * sizes[best].height) best = j;
    }
    return best;
  });
}
export function browserResizer(picture, sizes, signal) {
  const parents = browserParents(sizes, picture), bitmaps = new Map(), pictures = new Map();
  let whole = null, fromWhole = parents.filter((p, i) => p < 0 && (sizes[i].width !== picture.width || sizes[i].height !== picture.height)).length;
  const bitmap = async i => {
    if (i < 0) return whole ??= await bitmapOf(picture);
    if (!bitmaps.has(i)) {
      const {width, height} = sizes[i];
      bitmaps.set(i, width === picture.width && height === picture.height ? await bitmap(-1)
        : parents[i] >= 0 && sizes[parents[i]].width === width && sizes[parents[i]].height === height ? await bitmap(parents[i])
        : await resized(await bitmap(parents[i]), width, height));
      if (parents[i] < 0 && bitmaps.get(i) !== whole && !--fromWhole) { whole.close(); whole = null; }
      check(signal);
    }
    return bitmaps.get(i);
  };
  const via = i => {
    const parent = parents[i];
    if (parent < 0) return [];
    const steps = via(parent), {width, height} = sizes[parent];
    return width === sizes[i].width && height === sizes[i].height ? steps : [...steps, {width, height}];
  };
  return {
    via,
    async make(i) {
      const {width, height} = sizes[i];
      if (width === picture.width && height === picture.height) return picture;
      if (!pictures.has(i)) pictures.set(i, pixelsOf(await bitmap(i), picture));
      return pictures.get(i);
    },
    done(i) { pictures.delete(i); },
    close() { whole?.close(); for (const b of bitmaps.values()) b.close(); bitmaps.clear(); whole = null; },
  };
}
export async function browserResized(picture, width, height) {
  const whole = await bitmapOf(picture);
  try { const bitmap = await resized(whole, width, height); try { return pixelsOf(bitmap, picture); } finally { bitmap.close(); } }
  finally { whole.close(); }
}
export async function browserReference(picture, transform) {
  if (!hosted()) throw fail('JXL_UNSUPPORTED', 'browser-resized output: verify in browser');
  if (!browserResizable(picture)) throw fail('JXL_UNSUPPORTED', 'original: 8-bit picture required');
  const opened = [];
  try {
    let bitmap = await bitmapOf(picture); opened.push(bitmap);
    for (const step of [...(transform.via ?? []), transform]) {
      if (step.width === bitmap.width && step.height === bitmap.height) continue;
      bitmap = await resized(bitmap, step.width, step.height); opened.push(bitmap);
    }
    return bitmap.width === picture.width && bitmap.height === picture.height ? picture : pixelsOf(bitmap, picture);
  } finally { for (const b of opened) b.close(); }
}
