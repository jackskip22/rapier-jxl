// SPDX-License-Identifier: MIT
import {s2RGBA} from './ssimulacra2-input.mjs';
import {s2LinearTable} from './ssimulacra2-arithmetic.mjs';
import {linearFromTransform} from './color-bytes.mjs';

export {s2LinearTable as linearTable};
let METRIC_TRANSFORM = null;
export function linearFromRGBA(rgba, pixels) {
  const input = s2RGBA(rgba, pixels), planes = [0, 1, 2].map(() => new Float32Array(pixels));
  if (pixels === 0) return planes;
  if (!METRIC_TRANSFORM) { const table = s2LinearTable(); METRIC_TRANSFORM = {lms: null, tables: [table, table, table]}; }
  return linearFromTransform(new Uint8Array(input.buffer, input.byteOffset, pixels * 4), pixels, METRIC_TRANSFORM, planes);
}
