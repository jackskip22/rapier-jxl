import {check, fail, pixelLimit} from './primitives.mjs';
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
  if (maxPixels !== undefined) hooks = {...hooks, maxPixels: Math.min(pixelLimit(maxPixels), hooks.maxPixels ?? 40000000)};
  active++;
  try {
    const {kernels, boot} = load();
    const {image, encodeCaptureBytes} = await boot;
    const picture = await image(input, options, hooks);
    captureDomain(picture);
    const {data, width, height, colorSpace} = picture;
    check(hooks.signal);
    await kernels;
    check(hooks.signal);
    const result = encodeCaptureBytes(data, width, height, {...rest, maxError, colorSpace, signal: hooks.signal});
    check(hooks.signal); hooks.onProgress?.(1); return result;
  } finally { active--; }
}
