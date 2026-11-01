import {effortJob} from '../effort-job.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {readPNG16} from '../source.mjs';
import {coreSteps} from './instant.mjs';
import {bytes, check, fail, declared, callers, isCaller} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions} from './common.mjs';
import {DRIVE} from './drive.mjs';
import {image, pixels, jpegDimensions} from './input.mjs';
import {own, measure, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {encodeBands, WHOLE} from './bands.mjs';
import {recodeBand} from './band-recode.mjs';
import {isRowSource, admitRows, readBand} from './rows.mjs';
import {kernelHooks} from '../kernel-hooks.mjs';
import {admitOptions, admitPixels} from '../admit.mjs';
import {admitSampleFormat} from '../admit-samples.mjs';
import {admitPhotoFilter} from '../photo-job.mjs';
import {inspectPixels} from '../lossless.mjs';
import {preferXYB} from '../photo-xyb.mjs';
import {screenLike} from '../screen.mjs';
import {photoSplitBands, splitSteps, splitEnd, splitHasAlpha, splitRoute} from '../photo-split.mjs';
import {v6Trace} from '../photo-v6.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {captureWith, prepareCapture as warmCapture} from './capture-core.mjs';
const capture = captureWith(null), prepareCapture = () => warmCapture().catch(error => { throw declared(error); });
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
  if (options.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', `firstRegion is ${FULL}'s.`);
  if (options.features !== undefined) throw fail('JXL_OPTIONS', `Codestream features are ${FULL}'s.`);
  const readAs = options.readAs;
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source names its own space (colorSpace).');
    const source = admitRows(input, maxPixels), report = options.onProgress;
    const hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, onProgress: report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } })};
    await kernelsReady();
    return encodeBands({width: source.width, height: source.height, read: (y, rows) => readBand(source, y, rows, hooks.signal)},
      (band, bandHooks) => encodePicture(band, codec, bandHooks, helpers), (band, shared) => recodeBand(band, codec, shared), drain, hooks);
  }
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) throw fail('JXL_UNSUPPORTED', `A GPU texture is encoded by ${FULL}.`);
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  const read = blob ? null : {input: pixels(input, {readAs}, maxPixels), codec};
  const direct = read ? directRoute(read, maxPixels) : null;
  if (direct) check(options.signal);
  if (direct && helpers?.split) return splitHere(read, direct, helpers, options, maxPixels);
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
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  let captured = blob ? null : own(read, maxPixels, budget);
  const report = options.onProgress, onProgress = report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } });
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels};
  let carried = null;
  if (blob && codec.quality === 100 && readAs === undefined) {
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
    try { picture = await image(input, {readAs}, {...hooks, deep: async () => ({readSource: readPNG16})}); }
    catch (error) {
      if (carried && !isCaller(error) && typeof error?.code === 'string' && error.code.startsWith('JXL_') && error.code !== 'JXL_ABORTED')
        throw Object.assign(carried, {cause: error});
      throw error;
    }
    captured = own({input: picture, codec}, maxPixels, budget);
  }
  const {data, width, height, ...source} = captured.input;
  if (source.orientation !== undefined || source.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', `Orientation and extra channels are written by ${FULL}.`);
  check(hooks.signal);
  await kernelsReady();
  check(hooks.signal);
  if (width * height > WHOLE) return encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
    (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers), (band, target) => recodeBand(band, captured.codec, target), drain, hooks);
  return encodePicture(captured.input, captured.codec, hooks, helpers);
}

function encodePicture({data, width, height, ...source}, codec, hooks, helpers) {
  const settings = {...source, ...codec};
  if (settings.quality < 100 && (data instanceof Float32Array || settings.sampleFormat === 'float16')) throw fail('JXL_UNSUPPORTED', `Lossy float (HDR) samples are encoded by ${FULL}; this module encodes them exactly.`);
  const steps = settings.effort === 1 ? coreSteps(data, width, height, settings) : effortJob(data, width, height, settings, false);
  return helpers && settings.effort !== 1 ? driveSteps(steps, hooks, undefined, width * height, helpers, null) : drain(steps, hooks);
}

async function splitHere(read, direct, helpers, options, maxPixels) {
  const {data, width, height} = read.input;
  let copy = null;
  if (!helpers.owned && typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated !== false) {
    try { copy = new Uint8Array(new SharedArrayBuffer(data.length)); copy.set(data); } catch { copy = null; }
  }
  const captured = helpers.owned ? read : copy ? own({...read, input: {...read.input, data: new Uint8Array(0)}}, maxPixels) : own(read, maxPixels);
  if (copy) captured.input.data = copy;
  const report = options.onProgress, hooks = {signal: options.signal ?? new AbortController().signal, maxPixels,
    onProgress: report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } })};
  await kernelsReady();
  check(hooks.signal);
  v6Trace('upload: split at once');
  const bytes = await drain(splitAsk(captured.input.data, width, height, direct), {...hooks, split: helpers.split});
  if (bytes) return bytes;
  check(hooks.signal);
  v6Trace('upload: no split, the full route');
  const {data: owned, ...source} = captured.input;
  return driveSteps(effortJob(owned, width, height, {...source, ...captured.codec}, false), hooks, undefined, width * height, helpers, null);
}
function* splitAsk(data, width, height, {quality, gaborish}) {
  return (yield {split: {data, width, height, quality, gaborish, screen: false, opaque: true, pixels: width * height}}) ?? null;
}

function directRoute(read, maxPixels) {
  if (typeof document !== 'undefined' || !kernelHooks.gabBand || !kernelHooks.acGroup || !kernelHooks.channel) return null;
  const {data, width, height, ...source} = read.input, settings = {...source, ...read.codec};
  if (source.orientation !== undefined || source.extraChannels !== undefined || settings.photo === false || !(settings.effort === 2 || settings.effort === 3)) return null;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !splitRoute(width, height)) return null;
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

