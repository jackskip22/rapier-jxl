// SPDX-License-Identifier: MIT
import {flatSamples, flatSampleAt, flatSampleX, flatSampleY, FLAT, flatSurround, screenLike} from '../screen.mjs';
import {screenPhotoRegions} from '../screen-photo-regions.mjs';
import {captureExact} from '../capture-codec.mjs';
import {captureBlockHashes} from '../capture-kernels.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {lettersFound, findText} from './letters-found.mjs';
import {photoTextLayers} from '../photo-text-layers.mjs';
import {lowCaptureReading} from './low-intent-quality.mjs';
import {lookingReader, LOOK_FROM} from './capture-region-look.mjs';
import {namedColour} from '../text-floor.mjs';
import {journaled} from '../step-journal.mjs';

const PAGE_FLAT = 128, CELL = 32, WHOLE = 0.85, SOME_FLAT = Math.ceil(256 * (1 - WHOLE) / 2);

export function pagePicture(data, width, height, settings) {
  if (!(settings.quality < 100) || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return false;
  if ((settings.colorSpace ?? 'srgb') !== 'srgb' || !namedColour(settings) || settings.photo === false || settings.orientation !== undefined || settings.extraChannels !== undefined) return false;
  if (width < 4 * CELL || height < 3 * CELL) return false;
  const samples = admitSampleFormat(data, settings);
  if (!samples.native8 || samples.iccSpace) return false;
  const clear = s => data[(flatSampleY(height, s) * width + flatSampleX(width, s)) * 4 + 3] === 0;
  let flat = flatSamples(data, width, height);
  if (flat >= SOME_FLAT) for (let s = 0; s < 256; s++) if (clear(s) && flatSampleAt(data, width, height, s) & FLAT) flat--;
  if (flat < SOME_FLAT) return false;
  const regions = screenPhotoRegions(data, width, height);
  let photo = 0;
  for (const r of regions) photo += r.width * r.height;
  if (photo >= WHOLE * width * height) return false;
  if (!regions.length && !lettersFound(data, width, height)) return false;
  if (flat >= PAGE_FLAT) return true;
  let off = 0, offFlat = 0;
  for (let s = 0; s < 256; s++) {
    const x = flatSampleX(width, s), y = flatSampleY(height, s);
    if (clear(s) || regions.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
    off++; offFlat += flatSampleAt(data, width, height, s) & FLAT;
  }
  return off > 0 && offFlat * 4 >= off * 3;
}

export function pageWithoutPhotograph(data, width, height) {
  if (flatSamples(data, width, height) >= PAGE_FLAT) return true;
  for (let s = 0; s < 256; s++) if (data[(flatSampleY(height, s) * width + flatSampleX(width, s)) * 4 + 3] === 0) return true;
  return false;
}

export async function pageFile(run, {data, width, height}, fidelity, effort, hooks, selected, webgpu, exact) {
  const bytes = await run({data, width, height, colorSpace: 'srgb'}, {fidelity, effort, ...(webgpu !== undefined && {webgpu})},
    {signal: hooks.signal, onProgress: hooks.onProgress, ...(hooks.journal && {journal: hooks.journal})});
  if (!captureExact(bytes)) {
    if (!exact || !photographsRepeat(data, width, height)) return bytes;
    const own = await exact();
    if (!(own.length < bytes.length)) return bytes;
    selected?.({kept: 'pixels', measurements: []});
    return own;
  }
  selected?.({kept: 'pixels', measurements: []});
  const own = exact ? await exact() : null;
  return own && own.length < bytes.length ? own : bytes;
}

export function photographsRepeat(data, width, height) {
  const regions = screenPhotoRegions(data, width, height);
  if (!regions.length) return false;
  const hashes = captureBlockHashes(new Uint32Array(data.buffer, data.byteOffset, width * height), width, height);
  if (!hashes) return false;
  const gw = width >> 3, gh = height >> 3, counts = new Map();
  for (const h of hashes) if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  let blocks = 0, repeats = 0;
  for (const r of regions) for (let by = (r.y + 7) >> 3; (by + 1) * 8 <= r.y + r.height && by < gh; by++)
    for (let bx = (r.x + 7) >> 3; (bx + 1) * 8 <= r.x + r.width && bx < gw; bx++) {
      blocks++;
      const h = hashes[by * gw + bx];
      if (h && counts.get(h) > 1) repeats++;
    }
  return 2 * repeats > blocks;
}

export function cutoutPage(data, width, height) {
  if (!flatSurround(data, width, height)) return false;
  let clear = false;
  for (let i = 3; i < data.length && !clear; i += 4) clear = data[i] < 255;
  return clear && !screenPhotoRegions(data, width, height).length;
}

export const exactCodec = ({qualityIntent: _intent, lowIntent: _low, lowFilteredQuality: _filtered, ...codec}) => ({...codec, quality: 100});

export {lettersFound};

export async function unletteredFile(picture, exact, lossyCodec, code) {
  if (picture.extraChannels !== undefined || lettersFound(picture.data, picture.width, picture.height)) return null;
  const lossy = await lossyCodec();
  if (!(lossy.quality < 100)) return null;
  const answer = await code(lossy);
  return answer.bytes.length < exact.length ? answer : null;
}

export function letteredSteps(picture, codec, intent, exact, selected) {
  const found = letteredFound(picture, codec);
  if (!found) return null;
  const {data, width, height} = picture, rect = {x: 0, y: 0, width, height}, read = smooth => (d, w, r, off, cs) => lowCaptureReading(intent, d, w, r, off, cs, smooth);
  const quality = (codec.effort >= LOOK_FROM
    ? lookingReader(intent, read(false), {measureLarge: true, effort: codec.effort})(data, width, rect, false, 'srgb')
    : read(true)(data, width, rect, false, 'srgb')) ?? codec.quality;
  const bytes = photoTextLayers(data, width, height, found.mask, quality, codec.effort);
  return (function* () {
    if (bytes) { selected?.({kept: 'lossy', measurements: []}); return bytes; }
    const own = yield* exact();
    selected?.({kept: 'pixels', measurements: []});
    return own;
  })();
}

export const lettersRead = (journal, picture, codec) => journal ? journaled(journal, 'letters', () => letteredFound(picture, codec) !== null) : true;

export function letteredFound(picture, codec) {
  const {data, width, height} = picture;
  if (picture.extraChannels !== undefined || !namedColour(picture) || !namedColour(codec) || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
    (codec.colorSpace ?? 'srgb') !== 'srgb' || !(codec.quality < 100)) return null;
  if (screenLike(data, width, height)) return null;
  const found = findText(data, width, height);
  return found?.lines.length && !(found.lines.every(line => line.ink === 0xffffff || line.ink === 0) &&
    found.lines.reduce((sum, line) => sum + line.strokes, 0) <= 3) ? found : null;
}
