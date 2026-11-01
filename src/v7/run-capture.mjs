import {check, fail, pixelLimit, LARGEST} from './primitives.mjs';
import {WHOLE, bandRows} from './band-size.mjs';
import {readBand} from './rows.mjs';
import {wasmRequired} from '../capture-wasm-error.mjs';
import {admitCapture} from './capture-options.mjs';

let active = 0;
function load() {
  const boot = import('./capture-boot.mjs');
  const kernels = boot.then(async ({compileCaptureKernels}) => { if (!await compileCaptureKernels()) throw wasmRequired(); });
  boot.catch(() => {}); kernels.catch(() => {});
  return {kernels, boot};
}
export function prepareCapture() {
  const {kernels, boot} = load();
  return Promise.all([kernels, boot]).then(([, {warmCapture}]) => { if (!active) warmCapture(); });
}

function captureDomain(picture) {
  const refuse = what => { throw fail('JXL_INPUT', `A capture takes 8-bit straight RGBA in sRGB or Display P3; this picture's ${what}. Use encode for it.`); };
  if (!(picture.data instanceof Uint8Array || picture.data instanceof Uint8ClampedArray)) refuse('samples are not 8-bit');
  if (picture.colorSpace !== undefined && picture.colorSpace !== 'srgb' && picture.colorSpace !== 'display-p3') refuse(`colorSpace is ${picture.colorSpace}`);
  if (picture.bitDepth !== undefined && picture.bitDepth !== 8) refuse(`bitDepth is ${picture.bitDepth}`);
  if (picture.sampleFormat !== undefined && picture.sampleFormat !== 'uint') refuse(`sampleFormat is ${picture.sampleFormat}`);
  if (picture.transferFunction !== undefined && picture.transferFunction !== 'srgb') refuse(`transferFunction is ${picture.transferFunction}`);
  if (picture.alphaPremultiplied) refuse('alpha is premultiplied');
  if (picture.intensityTarget !== undefined && picture.intensityTarget !== 255) refuse(`intensityTarget is ${picture.intensityTarget}`);
  if (picture.icc !== undefined) refuse('profile is an ICC profile');
  if (picture.orientation !== undefined && picture.orientation !== 1) refuse(`orientation is ${picture.orientation}`);
  if (picture.extraChannels?.length) refuse('extra channels are set');
}

export {admitCapture};
export async function runCapture(input, options, hooks) {
  const maxError = admitCapture(options), {fidelity: _fidelity, readAs: _readAs, maxPixels, ...rest} = options;
  if (maxPixels !== undefined) hooks = {...hooks, maxPixels: Math.min(pixelLimit(maxPixels, LARGEST), hooks.maxPixels ?? Infinity)};
  active++;
  try {
    const {kernels, boot} = load();
    const {image, encodeCaptureBytes} = await boot;
    if (input?.description && typeof input.rows === 'function') {
      captureDomain({...input.description, data: new Uint8Array(0)});
      const {width, height} = input;
      check(hooks.signal); await kernels;
      const read = async (y, rows) => { const band = await readBand(input, y, rows, hooks.signal); captureDomain(band); return band.data; };
      const result = await captureLarge(read, width, height, {...rest, maxError, colorSpace: input.description.colorSpace, signal: hooks.signal}, hooks, boot);
      check(hooks.signal); hooks.onProgress?.(1); return result;
    }
    const picture = await image(input, options, hooks);
    captureDomain(picture);
    const {data, width, height, colorSpace} = picture;
    check(hooks.signal);
    await kernels;
    check(hooks.signal);
    const coding = {...rest, maxError, colorSpace, signal: hooks.signal};
    const result = width * height > WHOLE ? await captureLarge((y, rows) => data.subarray(y * width * 4, (y + rows) * width * 4), width, height, coding, hooks, boot)
      : encodeCaptureBytes(data, width, height, coding);
    check(hooks.signal); hooks.onProgress?.(1); return result;
  } finally { active--; }
}

async function captureLarge(read, width, height, coding, hooks, boot) {
  const {captureBandShape, captureBand, encodeCaptureBytes} = await boot, rows = bandRows(width), parts = [];
  if (rows >= height) { const {signal: _signal, ...options} = coding; const data = await read(0, height); check(hooks.signal); return encodeCaptureBytes(data, width, height, {...options, signal: hooks.signal}); }
  let shape, size = 0;
  for (let y = 0; y < height; y += rows) { shape = captureBandShape(await read(y, Math.min(rows, height - y)), shape); check(hooks.signal); }
  for (let y = 0; y < height; y += rows) {
    const part = captureBand(await read(y, Math.min(rows, height - y)), width, Math.min(rows, height - y), {...coding, y, imageHeight: height, shape});
    check(hooks.signal); parts.push(part); size += part.length; hooks.onProgress?.(Math.min(0.999, (y + rows) / height));
  }
  const bytes = new Uint8Array(size);
  for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) bytes.set(parts[i], at);
  return bytes;
}
