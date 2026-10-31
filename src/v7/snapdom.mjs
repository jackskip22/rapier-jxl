export {wasmOnlySupported as supported} from './capture-support.mjs';
// SPDX-License-Identifier: MIT
import {createCodec} from './codec.mjs';
import {admitSignal, check} from './primitives.mjs';
let captureCodec, uploadCodec;
const captureEncode = (input, options) => (captureCodec ||= createCodec({module: 'rapier-jxl/capture'})).capture(input, options);
const photoEncode = (input, options) => (uploadCodec ||= createCodec({module: 'rapier-jxl/upload'})).encode(input, options);

function warmPage() {
  const width = 1100, height = 96, data = new Uint8Array(width * height * 4);
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
    let r = 255, g = 255, b = 255;
    if (y >= 6 && y < 18 && x >= 8 && x < 1092) { r = 28; g = 61; b = 92; }
    if (y >= 24 && y < 88) {
      if (x >= 8 && x < 520) {
        const cell = (x - 8) % 13, row = (y - 24) % 12;
        const ink = cell > 2 && cell < 8 && row > 2 && row < 9;
        const edge = (cell === 2 || cell === 8) && row > 2 && row < 9;
        const shade = 144 + ((x * 13 + y * 29) & 63);
        r = ink ? 30 : edge ? shade : 242;
        g = ink ? 42 : edge ? shade + 3 : 245;
        b = ink ? 58 : edge ? shade + 6 : 248;
      } else if (x >= 580 && x < 1092) {
        const u = x - 580, v = y - 24;
        r = u & 255; g = v * 4; b = (u >>> 8) * 128 + ((u * 7 + v * 11) & 127);
      }
    }
    data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
  }
  return {data, width, height};
}

function warmup(encode) {
  let pending;
  return (rich = false) => pending ||= Promise.resolve().then(() => encode(rich ? warmPage() : {data: new Uint8Array(4), width: 1, height: 1}))
    .then(() => { pending = null; }, error => { pending = null; throw error; });
}

const OWN = new Set(['quality', 'maxError', 'signal', 'onProgress']);
const refuse = (Class, message) => Object.assign(new Class(message), {code: 'JXL_OPTIONS'});
const bound = (value, name) => { if (!Number.isInteger(value) || value < 0 || value > 8) throw refuse(RangeError, `${name}: maxError is an integer from 0 to 8; 0 is exact.`); };

const PLUGIN = new Set(['maxError', 'capture', 'encode', 'prepare']);
export function jxl(settings = {}) {
  for (const key of Object.keys(settings ?? {})) if (!PLUGIN.has(key)) throw refuse(TypeError, `jxl(): unknown option ${key}.`);
  const {maxError = 0, capture = captureEncode, encode = capture === captureEncode ? photoEncode : undefined, prepare = true} = settings ?? {};
  if (typeof capture !== 'function') throw refuse(TypeError, 'jxl(): capture must be a function, such as encoder.capture from createCodec()');
  if (encode !== undefined && typeof encode !== 'function') throw refuse(TypeError, 'jxl(): encode must be a function, such as encoder.encode from createCodec()');
  bound(maxError, 'jxl()');
  if (typeof prepare !== 'boolean') throw refuse(TypeError, 'jxl(): prepare is true or false.');
  const start = warmup(capture), startLossy = encode
    ? warmup(input => encode(input, {fidelity: {quality: 1}, effort: 1})) : start;
  if (prepare) start(true).catch(() => {});
  return {
    name: 'jxl',
    prepare: () => start(true),
    defineExports: ({exports}) => ({
      async jxl(context, options = {}) {
        const {signal, onProgress} = options;
        admitSignal(signal);
        if (onProgress !== undefined && typeof onProgress !== 'function') throw refuse(TypeError, 'toJxl(): onProgress is a function.');
        if (options.maxError !== undefined) bound(options.maxError, 'toJxl()');
        check(signal);
        const requested = context?.export?.requestedOptions ?? {}, explicitQuality = Object.hasOwn(requested, 'quality');
        const quality = requested.quality === 1 ? 1 : options.quality, error = options.maxError ?? maxError;
        if (explicitQuality) {
          for (const value of [requested.quality, quality])
            if (!Number.isFinite(value) || value < 0 || value > 1) throw refuse(RangeError, 'toJxl(): quality must be a finite number from 0 to 1.');
          if (error !== 0) throw refuse(TypeError, 'toJxl(): quality and nonzero maxError cannot be combined.');
          if (quality < 1 && !encode) throw refuse(TypeError, 'toJxl(): a custom capture needs encode for quality below 1.');
        }
        const lossy = explicitQuality && quality < 1;
        (lossy ? startLossy : start)().catch(() => {});
        const canvas = await exports.canvas(Object.fromEntries(Object.entries(options).filter(([key]) => !OWN.has(key))));
        const bytes = lossy
          ? await encode(canvas, {fidelity: {quality: Math.max(1, quality * 100)}, effort: 1, signal, onProgress})
          : await capture(canvas, {fidelity: error ? {maxError: error} : 'exact', signal, onProgress});
        return new Blob([bytes], {type: 'image/jxl'});
      },
    }),
  };
}
