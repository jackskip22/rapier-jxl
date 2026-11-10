// SPDX-License-Identifier: MIT
import {flatSamples, CAPTURE_FLAT, screenLike} from './screen-samples.mjs';

const TILE = 128, PROBE_PIXELS = 4 * 4 * TILE * TILE, OVER = 2;
export const textFloorEligible = (data, width, height, colorSpace) => (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
  data.length === width * height * 4 && typeof colorSpace !== 'object' && width >= TILE && height >= TILE &&
  flatSamples(data, width, height, CAPTURE_FLAT) >= CAPTURE_FLAT && !screenLike(data, width, height);

function tile(data, width, x0, y0) {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) out.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + TILE) * 4), y * TILE * 4);
  return out;
}

export function* textFloorCapture(bytes, data, width, height, colorSpace) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (width * height > PROBE_PIXELS) {
    let sum = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const x = Math.floor((width - TILE) * (2 * i + 1) / 4), y = Math.floor((height - TILE) * (2 * j + 1) / 4);
      const part = yield {capture: {data: tile(data, width, x, y), width: TILE, height: TILE, colorSpace}};
      if (!(part instanceof Uint8Array)) return null;
      sum += part.length;
    }
    if (sum * width * height / (4 * TILE * TILE) >= OVER * bytes.length) return null;
  }
  const captured = yield {capture: {data, width, height, colorSpace}};
  return captured instanceof Uint8Array && captured.length < bytes.length ? captured : null;
}

export function* textFloorSteps(steps, data, width, height, colorSpace) {
  const bytes = yield* steps;
  return (yield* textFloorCapture(bytes, data, width, height, colorSpace)) ?? bytes;
}
