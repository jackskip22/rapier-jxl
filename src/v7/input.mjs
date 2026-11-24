// SPDX-License-Identifier: MIT
import {check, fail, blobBytes} from './primitives.mjs';
import {admitSize} from '../admit.mjs';
import {image as imageWith, nativeBitmap, requirePNGReader, pngChunks, blobProfile} from './input-native.mjs';
import {profileSpace, profileIntent} from '../jfif.mjs';
import {inspectICC} from '../icc-profile.mjs';
import {withCost} from './ownership.mjs';
export {pixels, jpegDimensions, jpegBlobDimensions, jpegInfo, jpegBlobInfo, admitJpeg} from './input-native.mjs';

export const image = (input, options, hooks = {}) => imageWith(input, options, hooks, readBlob);
async function readBlob(input, options, hooks, head, png) {
  if (png) {
    const depth = head[24], colourType = head[25];
    const stated = depth !== 16 && hooks.deep && options?.readAs !== undefined && await statedColor(input, hooks.signal);
    if (depth === 16 || stated || hooks.deep && options?.readAs === undefined && (colourType === 4 || colourType === 6 ||
        typeof createImageBitmap !== 'function' || await ownReadingChunk(input, hooks.signal) !== false)) {
      if (!stated) requirePNGReader(options, hooks);
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      admitSize(view.getUint32(16), view.getUint32(20), hooks.maxPixels);
      const {readSource, orient} = await hooks.deep();
      const result = await readSource(await blobBytes(input, hooks.signal), {maxPixels: hooks.maxPixels});
      check(hooks.signal);
      const space = stated && ownSpace(result);
      if (stated && space === 'srgb' && options.readAs === 'srgb') return nativeBitmap(input, options, hooks, browserPolicy(input, options, head, hooks));
      if (stated && space !== options.readAs) throw convertRefusal(space, options.readAs);
      const picture = await orient(result, {signal: hooks.signal, maxPixels: hooks.maxPixels});
      withCost(picture.data, picture.data.byteLength);
      return picture;
    }
  }
  if (!png && head[0] === 255 && head[1] === 216 && typeof createImageBitmap !== 'function' && hooks.jpegPixels && options?.readAs === undefined) {
    const picture = await hooks.jpegPixels(await blobBytes(input, hooks.signal), {maxPixels: hooks.maxPixels, signal: hooks.signal});
    check(hooks.signal);
    if (picture.data) withCost(picture.data, picture.data.byteLength);
    if (picture.icc) withCost(picture.icc, picture.icc.byteLength);
    return picture;
  }
  const own = hooks.deep && typeof createImageBitmap === 'function' ? await ownProfile(input, head, hooks.signal) : null;
  if (own?.unread) {
    if (options?.exact) throw fail('JXL_UNSUPPORTED', `ICC ${own.unread}: pass pixels with icc or use lossy`);
  } else if (own) {
    if (options?.readAs !== undefined && options.readAs !== own.space) throw convertRefusal(own.space, options.readAs);
    const {colorSpace: _srgb, ...picture} = await nativeBitmap(own.plain, {}, hooks, browserPolicy(input, options, head, hooks));
    return {...picture, icc: own.icc};
  }
  return nativeBitmap(input, options, hooks, browserPolicy(input, options, head, hooks));
}
const convertRefusal = (space, readAs) => fail('JXL_OPTIONS', `readAs '${readAs}': not with exact`);
function ownSpace({icc, colorEncoding, colorSpace = 'srgb', transferFunction = 'srgb'}) {
  if (icc) { try { return profileSpace(icc); } catch { return null; } }
  return colorEncoding || transferFunction !== 'srgb' || !['srgb', 'display-p3'].includes(colorSpace) ? null : colorSpace;
}
async function statedColor(blob, signal) {
  const chunks = await pngChunks(blob, signal);
  return !chunks || ['iCCP', 'cICP', 'gAMA', 'cHRM'].some(name => chunks.names.has(name));
}
async function ownProfile(blob, head, signal) {
  const found = await blobProfile(blob, head, signal);
  check(signal);
  if (!found) return null;
  if (found.unread) return {unread: 'unreadable'};
  try { if (inspectICC(found.icc, undefined, 'rgb') !== 3) throw 0; } catch { return {unread: 'not RGB'}; }
  let space = null;
  try { space = profileSpace(found.icc); } catch {}
  return space === 'srgb' && profileIntent(found.icc) === 'relative' ? null : {...found, space};
}
function browserPolicy(input, options, head, hooks) {
  return {
    prepare: () => hooks.phone?.(input, head, hooks),
    platform: () => options?.readAs !== undefined ? 'omit readAs' : hooks.deep ? 'pass RGBA pixels, PNG, or use recompress()' : undefined,
    blob: phone => phone?.decodeBlob,
    failure: phone => phone ? 'phone image: pass RGBA pixels' : undefined,
    admit(bitmap, phone) {
      if (phone && (bitmap.width !== phone.width || bitmap.height !== phone.height))
        throw fail('JXL_INPUT', 'native decode: size mismatch; pass pixels');
    },
  };
}

const OWN_READING = ['tRNS', 'gAMA', 'cHRM', 'iCCP', 'cICP'];
async function ownReadingChunk(blob, signal) {
  const chunks = await pngChunks(blob, signal);
  if (!chunks) return 'unknown';
  return OWN_READING.some(name => chunks.names.has(name)) || chunks.names.has('sRGB') && chunks.intent !== 1;
}

