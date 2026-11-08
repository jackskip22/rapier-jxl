// SPDX-License-Identifier: MIT
import {dimensions, fail} from './primitives.mjs';
import {SIGNATURE, boxes, RECONSTRUCTION} from '../container.mjs';
import {useJpegDisplay} from './result.mjs';
import {carried, stage, PASSED} from '../step-journal.mjs';
import {exifOrientation} from '../exif-orientation.mjs';

const SCAN_BYTES = 131072;
const geometryStart = () => ({at: 0, phase: 'signature', width: undefined, height: undefined, orientation: null, done: false});
const displaySize = ({width, height, orientation}) => orientation >= 5 ? {width: height, height: width} : {width, height};
function geometryDone({width, height, orientation, orientationAt, orientationBig}, maxPixels) {
  if (width === undefined || height === undefined) throw fail('JXL_JPEG', 'JPEG dimensions are missing.');
  dimensions(width, height, maxPixels);
  return {width, height, orientation: orientation ?? 1, orientationAt, orientationBig};
}
export function jpegDisplayDimensions(bytes, maxPixels) {
  let state = geometryStart();
  while (!state.done) state = geometryWindow(bytes, state);
  return displaySize(geometryDone(state, maxPixels));
}
export function* jpegDisplayDimensionsSteps(bytes, maxPixels, shown) {
  const geometry = yield* stage('jpeg-geometry', function* () {
    let state = geometryStart();
    while (!state.done) {
      const value = yield* carried('jpeg-geometry-window', () => geometryWindow(bytes, state));
      if (value !== PASSED) state = value;
    }
    return geometryDone(state, maxPixels);
  });
  shown?.({...geometry});
  return displaySize(geometry);
}
function geometryWindow(bytes, previous) {
  const state = {...previous}, start = state.at, length = bytes.length, stop = Math.min(length, start + SCAN_BYTES);
  const window = bytes.subarray(start, Math.min(length, stop + 65540)), byte = at => window[at - start];
  const pending = () => state.phase === 'marker-code' || state.phase === 'entropy-code';
  if (state.phase === 'signature') {
    if (byte(0) !== 255 || byte(1) !== 216) throw fail('JXL_JPEG', 'Input is not a JPEG.');
    state.at = 2; state.phase = 'marker';
  }
  while (!state.done && (state.at < stop || state.at >= length && pending())) {
    if (state.phase === 'entropy') {
      while (state.at < stop && byte(state.at) !== 255) state.at++;
      if (state.at < stop) { state.at++; state.phase = 'entropy-code'; }
      continue;
    }
    if (state.phase === 'marker') {
      if (byte(state.at++) !== 255) throw fail('JXL_JPEG', 'Invalid JPEG marker.');
      state.phase = 'marker-code';
    }
    while (state.at < stop && byte(state.at) === 255) state.at++;
    if (state.at >= stop && state.at < length) break;
    if (state.phase === 'entropy-code') {
      const marker = byte(state.at);
      if (marker === 0 || marker >= 208 && marker <= 215) { state.at++; state.phase = 'entropy'; continue; }
      state.phase = 'marker-code';
    }
    const marker = byte(state.at++);
    if (marker === 217) { state.done = true; break; }
    state.phase = 'marker';
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    const size = byte(state.at) * 256 + byte(state.at + 1), end = state.at + size, body = state.at + 2;
    if (!Number.isInteger(size) || size < 2 || end > length) throw fail('JXL_JPEG', 'JPEG segment is incomplete.');
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      if (size < 8) throw fail('JXL_JPEG', 'JPEG dimensions are incomplete.');
      state.height = byte(body + 1) * 256 + byte(body + 2); state.width = byte(body + 3) * 256 + byte(body + 4);
    }
    if (marker === 225 && state.orientation === null && end - body >= 6 &&
        [69,120,105,102,0,0].every((value, i) => byte(body + i) === value))
      state.orientation = exifOrientation(window, body + 6 - start, end - start, (at, big) => {
        state.orientationAt = start + at; state.orientationBig = big;
      });
    state.at = end;
    if (marker === 218) state.phase = 'entropy';
  }
  if (state.at >= length && !pending()) state.done = true;
  return state;
}

export function jpegReconstruction(bytes) {
  if (!(bytes instanceof Uint8Array) || !SIGNATURE.every((byte, i) => bytes[i] === byte)) return undefined;
  for (const {type, body, end} of boxes(bytes)) if (type === RECONSTRUCTION && end > body) return 'jpeg';
  return undefined;
}

useJpegDisplay(jpegDisplayDimensions);
