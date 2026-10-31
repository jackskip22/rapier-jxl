import {effortJob} from '../effort-job.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {readPNG16} from '../source.mjs';
import {coreSteps} from './instant.mjs';
import {bytes, check, fail, declared, callers, isCaller} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions} from './common.mjs';
import {DRIVE} from './drive.mjs';
import {image, pixels, jpegDimensions} from './input.mjs';
import {own, measure, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {kernelHooks} from '../kernel-hooks.mjs';
import {admitOptions, admitPixels} from '../admit.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {admitPhotoFilter} from '../photo-job.mjs';
import {inspectPixels} from '../lossless.mjs';
import {preferXYB} from '../photo-xyb.mjs';
import {screenLike} from '../screen.mjs';
import {photoSplitBands, splitSteps, splitEnd, splitHasAlpha} from '../photo-split.mjs';
import {v6Trace} from '../photo-v6.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {capture, prepare as prepareCapture} from './capture.mjs';
import {compileCaptureKernels} from '../capture-codec.mjs';
export {capture};
export {wasmOnlySupported as supported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';

const FULL = 'the full encoder, rapier-jxl';

let prepared;
export function prepare(operation = 'encode') {
  if (operation === 'capture') return prepareCapture();
  if (operation !== 'encode') return Promise.reject(fail('JXL_OPTIONS', 'prepare names encode or capture.'));
  return prepared ||= (async () => { await kernelsReady(); await compileCaptureKernels(); })()
    .catch(error => { prepared = undefined; throw declared(error); });
}

export const encode = (input, options) => encodeHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
encode[DRIVE] = (input, options, helpers) => encodeHere(input, options, helpers).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function encodeHere(input, options = {}, helpers = null) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const {codec: {target, ...codec}, hooks: {webgpu: _webgpu, maxPixels}} = callOptions(encodeOptions({...options, effort: options.effort ?? 3}));
  if (codec.effort > 3) throw fail('JXL_OPTIONS', `The upload encoder runs efforts 1-3; efforts 4-9 are ${FULL}.`);
  if (target !== undefined) throw fail('JXL_OPTIONS', `A measured fidelity is ${FULL}'s.`);
  if (options.features !== undefined) throw fail('JXL_OPTIONS', `Codestream features are ${FULL}'s.`);
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  const read = blob ? null : {input: pixels(input, options, maxPixels), codec};
  const direct = read && !helpers ? directRoute(read, maxPixels) : null;
  if (direct) check(options.signal);
  const split = direct && photoSplitBands(read.input.data, read.input.width, read.input.height, direct.quality, {gaborish: direct.gaborish});
  if (split && splitHasAlpha(split)) splitEnd(split);
  else if (split) {
    try {
      v6Trace('upload: bands made, no copy');
      const report = options.onProgress, hooks = {signal: options.signal ?? new AbortController().signal, maxPixels,
        onProgress: report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } })};
      await kernelsReady();
      check(hooks.signal);
      return await drain(splitSteps(split), hooks);
    } finally { splitEnd(split); }
  }
  let captured = blob ? null : own(read, maxPixels);
  const report = options.onProgress, onProgress = report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } });
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels};
  let carried = null;
  if (blob && codec.quality === 100 && options.readAs === undefined) {
    const head = new Uint8Array(await input.slice(0, 2).arrayBuffer());
    check(hooks.signal);
    if (head[0] === 255 && head[1] === 216) {
      const jpeg = new Uint8Array(await input.arrayBuffer());
      check(hooks.signal);
      try { return await carry(jpeg, codec.effort, hooks); }
      catch (error) { if (error?.code !== 'JXL_JPEG') throw error; check(hooks.signal); carried = error; }
    }
  }
  if (blob) {
    let picture;
    try { picture = await image(input, options, {...hooks, deep: async () => ({readSource: readPNG16})}); }
    catch (error) {
      if (carried && !isCaller(error) && typeof error?.code === 'string' && error.code.startsWith('JXL_') && error.code !== 'JXL_ABORTED')
        throw Object.assign(carried, {cause: error});
      throw error;
    }
    captured = own({input: picture, codec}, maxPixels);
  }
  const {data, width, height, ...source} = captured.input;
  if (source.orientation !== undefined || source.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', `Orientation and extra channels are written by ${FULL}.`);
  check(hooks.signal);
  const settings = {...source, ...captured.codec};
  await kernelsReady();
  check(hooks.signal);
  const steps = settings.effort === 1 ? coreSteps(data, width, height, settings) : effortJob(data, width, height, settings, false);
  return helpers && settings.effort !== 1 ? driveSteps(steps, hooks, undefined, width * height, helpers, null) : drain(steps, hooks);
}

function directRoute(read, maxPixels) {
  if (typeof document !== 'undefined' || !kernelHooks.gabBand || !kernelHooks.acGroup || !kernelHooks.channel) return null;
  const {data, width, height, ...source} = read.input, settings = {...source, ...read.codec};
  if (source.orientation !== undefined || source.extraChannels !== undefined || settings.photo === false || !(settings.effort === 2 || settings.effort === 3)) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !(width * height > 512 * 512)) return null;
  let quality;
  try {
    const admitted = admitOptions(settings);
    if (admitted.quality >= 100 || admitted.colorSpace !== 'srgb') return null;
    admitPhotoFilter(settings); admitPixels(data, width, height);
    const samples = admitSampleFormat(data, settings);
    if (samples.iccSpace || !samples.native8) return null;
    quality = admitted.quality;
  } catch { return null; }
  if (measure(read, maxPixels) > DEFAULT_INPUT_BYTES) return null;
  for (let p = 0, step = Math.max(1, Math.floor(width * height / 16384)); p < width * height; p += step) if (data[p * 4 + 3] !== 255) return null;
  const shape = inspectPixels(data, width, height, {opacity: false});
  if (shape.palette || shape.alpha || !preferXYB(data, width, height) || screenLike(data, width, height)) return null;
  return {quality, gaborish: settings.effort === 3};
}

async function carry(jpeg, effort, hooks) {
  bytes(jpeg); jpegDimensions(jpeg, hooks.maxPixels); check(hooks.signal);
  await kernelsReady();
  return drain(ansTranscodeSteps(jpeg, {effort}), hooks);
}
