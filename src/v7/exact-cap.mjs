// SPDX-License-Identifier: MIT
import {captureExact} from '../capture-codec.mjs';
import {kernelHooks} from '../kernel-hooks.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {MEASURED_EFFORT} from '../effort-level.mjs';
import {inspectPixels} from '../lossless.mjs';
import {namedColour} from '../text-floor.mjs';

export const LINE = 1, LOSSY_LINE = 4, WITHIN = 1.02, FLOOR = 3;

export function exactCouldWin(bytes, input, effort) {
  if (!bytes) return false;
  const pixels = input?.width * input?.height;
  if (!(pixels > 0)) return false;
  const bits = bytes.length * 8 / pixels;
  if (captureExact(bytes) ? effort < FLOOR && bits > LINE : bits > LOSSY_LINE) return true;
  const data = input.data;
  if (!(ArrayBuffer.isView(data) && data.length === pixels * 4)) return false;
  const hook = kernelHooks.capturePhoto;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) return false;
  if (!hook?.opaque) throw wasmRequired();
  hook.ready();
  return !hook.opaque(data, input.width, 0, 0, input.width, input.height);
}

export const SMALL_EXACT = 128 * 128, SMALL_GATE = 1.08;
const narrowPalette = ({data, width, height}) => Math.min(width, height) < 128 && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) &&
  data.length === width * height * 4 && !!inspectPixels(data, width, height, {opacity: false}).palette;
const smallExactCouldWin = (bytes, input, effort) => {
  const {width, height} = input;
  if (!(effort < MEASURED_EFFORT) || captureExact(bytes)) return false;
  return width * height <= SMALL_EXACT ? bytes.length * 8 > LOSSY_LINE * width * height : narrowPalette(input);
};
export async function smallExactBeside(bytes, input, effort, exactAt) {
  if (!smallExactCouldWin(bytes, input, effort)) return null;
  const first = await exactAt(1);
  let best = first.length < bytes.length ? first : null;
  if (effort > 1 && first.length <= bytes.length * SMALL_GATE) {
    const asked = await exactAt(effort);
    if (asked.length < bytes.length && asked.length <= (best ?? bytes).length) best = asked;
  }
  return best;
}

export function exactCandidate(input, run, own, {journal, signal} = {}) {
  const {data, width, height, ...source} = input;
  const plain = !journal && (source.colorSpace ?? 'srgb') === 'srgb' && source.icc === undefined && source.orientation === undefined &&
    source.extraChannels === undefined && namedColour(source) && narrowPalette(input);
  if (!plain) return own;
  return async effort => {
    const page = await run({data, width, height, colorSpace: 'srgb'}, {fidelity: 'exact', effort}, {signal}), mine = await own(effort);
    return page.length <= mine.length ? page : mine;
  };
}
