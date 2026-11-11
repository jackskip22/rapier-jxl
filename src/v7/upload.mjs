import {previewCall} from './preview.mjs';
import {resultOperation, resultReference, resultFacts, RESULT_REFERENCE} from './result-operation.mjs';
import {JOURNAL, JOURNAL_FILE, journaled, journalFact, JOIN} from '../step-journal.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
import {effortJob} from '../effort-job.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {longTail} from '../jpeg-tail.mjs';
import {readPNG16} from '../source.mjs';
import {journalPNG} from './journal-png.mjs';
import {sRGBWithIntent, withRenderingIntent} from './header-intent.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {coreSteps} from './instant.mjs';
import {bytes, check, fail, declared, callers, isCaller, progressOf, dimensions} from './primitives.mjs';
import {drain, driveSteps, callOptions} from './common.mjs';
import {uploadOptions} from './upload-options.mjs';
import {ordinaryStillReader} from './ordinary-still-policy.mjs';
import {lowPhotoSteps, encodeLowSplit, makeLowUpload, finishLowUpload, closeLowUpload, smoothPhoto, smoothDecides} from './low-photo.mjs';
import {preparationUpload} from './preparation-upload.mjs';
import {DRIVE} from './drive.mjs';
import {image, pixels, jpegDimensions, admitJpeg} from './input.mjs';
import {inspectPhone} from './phone-container.mjs';
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
import {photoSplitBands, splitSteps, splitEnd, splitHasAlpha, splitRoute, encodeSplit} from '../photo-split.mjs';
import {v6Trace} from '../photo-v6.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {kernelsReady} from './kernels-ready.mjs';
import {captureWith} from './capture-core.mjs';
import {imageResult} from './result.mjs';
import {admitCapturePhoto, captureRectangles} from './capture-photo-options.mjs';
import {lowCaptureRunner, prepareCapturePhoto} from './capture-photo-runner.mjs';
import {CAPTURE_UPLOAD, carriedBy} from './capture-levels.mjs';
const carried = carriedBy('rapier-jxl/upload', CAPTURE_UPLOAD);
const capture = captureWith(null,{admit:options => admitCapturePhoto(options,carried),rectangles:captureRectangles,run:lowCaptureRunner()},imageResult), prepareCapture = () => prepareCapturePhoto().catch(error => { throw declared(error); });
import {compileCaptureKernels} from '../capture-codec.mjs';
export {capture};
export {wasmOnlySupported as supported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';

const FULL = 'the full encoder, rapier-jxl';

const WARM_UPLOADS = 8;
let prepared;
function warmUpload() {
  const width = 256, height = 192, data = new Uint8Array(width * height * 4);
  for (let i = 0, state = 1; i < width * height; i++) {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    const x = i % width, y = i / width | 0, v = 90 + (x + 2 * y >> 3) + (state >>> 28);
    data[4 * i] = v + (x >> 3); data[4 * i + 1] = v; data[4 * i + 2] = v - (y >> 3); data[4 * i + 3] = 255;
  }
  return encodeHere({data, width, height}, {fidelity: {quality: 82}, effort: 3});
}
export function prepare(operation = 'encode') {
  if (operation === 'capture') return prepareCapture();
  if (!['encode', 'fit', 'variants'].includes(operation)) return Promise.reject(fail('JXL_OPTIONS', 'prepare names encode, fit, variants or capture.'));
  return prepared ||= (async () => { await kernelsReady(); await compileCaptureKernels(); if (typeof document === 'undefined') for (let i = 0; i < WARM_UPLOADS; i++) await warmUpload(); })()
    .catch(error => { prepared = undefined; throw declared(error); });
}

const encodeBytes = (input, options) => encodeHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
encodeBytes[DRIVE] = (input, options, helpers) => encodeHere(input, options, helpers).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
export const encode = resultOperation(encodeBytes, {preview: previewCall});
export {resultJSON} from './result.mjs';
export const {fit, variants} = preparationUpload(encodeBytes, {deep: async () => ({readSource: bytes => readPNG16(bytes, {named: true}), orient: orientSamples})});
const TAKEN = ['fidelity', 'effort', 'readAs', 'maxPixels', 'webgpu'];
Object.defineProperty(encode, STEPS, {value: verbSteps('encode:rapier-jxl/upload', encode, {taken: TAKEN, rows: true, files: true})});
Object.defineProperty(fit, STEPS, {value: verbSteps('fit:rapier-jxl/upload', fit, {taken: ['maxBytes', ...TAKEN], rows: true, files: true})});
Object.defineProperty(variants, STEPS, {value: verbSteps('variants:rapier-jxl/upload', variants, {taken: ['outputs', ...TAKEN]})});
async function encodeHere(input, given = {}, helpers = null) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const journal = given[JOURNAL], options = journal === undefined ? given : (({[JOURNAL]: _journal, ...rest}) => rest)(given);
  const {codec, hooks: {webgpu: _webgpu, maxPixels}} = callOptions(uploadOptions(options));
  const reader = ordinaryStillReader({signal: options.signal, maxPixels});
  const intended = {};
  try { return withRenderingIntent(await encodeOwned(input, options, helpers, codec, maxPixels, reader, journal, intended), intended.intent); }
  finally { reader.destroy(); }
}

async function encodeOwned(input, options, helpers, codec, maxPixels, reader, journal, intended = {}) {
  const readAs = options.readAs;
  check(options.signal);
  if (journal !== undefined) { await kernelsReady(); check(options.signal); }
  let decoded = null;
  if (journal !== undefined && input?.[JOURNAL_FILE] !== undefined) {
    const file = input[JOURNAL_FILE];
    decoded = await journalPNG(file, readAs, maxPixels, journal);
    if (!decoded) input = new Blob([file.subarray(0, file.length)]);
  }
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source sets colorSpace.');
    const source = admitRows(input, maxPixels), report = options.onProgress;
    source.description = own(source.description, maxPixels);
    resultReference(options, source);
    const hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, onProgress: progressOf(report, options.signal), journal};
    await kernelsReady();
    let exact = true;
    const settle = async band => {
      const settled = reader.read(codec, band) ?? await reader.project(codec, band);
      exact &&= settled.quality === 100; return settled;
    };
    const bytes = await encodeBands({width: source.width, height: source.height, read: (y, rows) => readBand(source, y, rows, hooks.signal)},
      async (band, bandHooks) => encodePicture(band, await settle(band), bandHooks, helpers), async function* (band, shared) {
        return yield* recodeBand(band, await settle(band), shared);
      }, drain, hooks);
    if (exact) resultFacts(options, {kept: 'pixels', measurements: []});
    return bytes;
  }
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) throw fail('JXL_UNSUPPORTED', `A GPU texture is encoded by ${FULL}.`);
  const blob = decoded !== null || typeof Blob !== 'undefined' && input instanceof Blob;
  const borrowed = blob ? null : journal ? admitPicture(journalPixels(input, maxPixels)) : admitPicture(pixels(input, {readAs}, maxPixels, true));
  const read = blob ? null : {input: borrowed, codec: reader.read(codec, borrowed)};
  const direct = read?.codec ? directRoute(read, maxPixels) : null;
  if (direct) {
    check(options.signal);
    if (options[RESULT_REFERENCE]) resultReference(options, read.input);
  }
  if (direct && helpers?.split) return splitHere(read, direct, helpers, options, maxPixels);
  const low = direct?.lowWebp !== undefined && makeLowUpload(read.input.data, read.input.width, read.input.height, direct.quality, direct.effort,
    smoothDecides(direct) && smoothPhoto(read.input.data, read.input.width, read.input.height), direct.lowFilteredQuality);
  const split = low ? low.split : direct && photoSplitBands(read.input.data, read.input.width, read.input.height, direct.quality, {gaborish: direct.gaborish});
  if (split && splitHasAlpha(split)) splitEnd(split);
  else if (split || low?.incumbent) {
    try {
      v6Trace('upload: bands made, no copy');
      const report = options.onProgress, hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, journal,
        onProgress: progressOf(report, options.signal)};
      await kernelsReady();
      check(hooks.signal);
      return await drain(low ? finishLowUpload(low, direct.effort) : splitSteps(split), hooks);
    } finally { if (low) closeLowUpload(low); else splitEnd(split); }
  }
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  let captured = blob ? null : journal ? {input: read.input, ...own({codec: read.codec}, maxPixels, budget)} : own(read, maxPixels, budget);
  if (captured) resultReference(options, captured.input);
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels, journal};
  if (captured && captured.codec === null) captured.codec = await reader.project(codec, captured.input);
  let carried = null;
  if (blob && !decoded && codec.quality === 100 && readAs === undefined) {
    const head = new Uint8Array(await input.slice(0, 2).arrayBuffer());
    check(hooks.signal);
    if (head[0] === 255 && head[1] === 216) {
      await admitJpeg(input, maxPixels, hooks.signal);
      const jpeg = new Uint8Array(await input.arrayBuffer());
      check(hooks.signal);
      try { const file = await carry(jpeg, codec.effort, hooks); resultReference(options, jpeg, jpeg, {kept: 'jpeg-bytes'}); return file; }
      catch (error) { if (error?.code !== 'JXL_JPEG') throw error; check(hooks.signal); carried = error; }
    }
  }
  if (blob) {
    let picture = decoded;
    if (!picture) try { picture = await journaled(journal, 'decode', () => image(input, {readAs}, {...hooks, phone: inspectPhone, deep: async () => ({readSource: readPNG16, orient: orientSamples})})); }
    catch (error) {
      if (carried && !isCaller(error) && typeof error?.code === 'string' && error.code.startsWith('JXL_') && error.code !== 'JXL_ABORTED')
        throw Object.assign(carried, {cause: error});
      throw error;
    }
    [picture, intended.intent] = sRGBWithIntent(picture);
    captured = decoded ? {input: admitPicture(picture), ...own({codec}, maxPixels, budget)} : own({input: admitPicture(picture), codec}, maxPixels, budget);
    resultReference(options, captured.input, input);
    captured.codec = reader.read(codec, captured.input) ?? await reader.project(codec, captured.input);
  }
  const {data, width, height, ...source} = captured.input;
  if (captured.codec.quality === 100) resultFacts(options, {kept: 'pixels', measurements: []});
  check(hooks.signal);
  await kernelsReady();
  check(hooks.signal);
  if (width * height > WHOLE) return encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
    (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers), (band, target) => recodeBand(band, captured.codec, target), drain, hooks);
  return encodePicture(captured.input, captured.codec, hooks, helpers);
}

function journalPixels({data, width, height, colorSpace}, maxPixels) {
  dimensions(width, height, maxPixels);
  return {data, width, height, ...(colorSpace && {colorSpace})};
}

function admitPicture(picture) {
  if (picture.orientation !== undefined || picture.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', `Orientation and extra channels are written by ${FULL}.`);
  return picture;
}

function encodePicture({data, width, height, ...source}, codec, hooks, helpers) {
  const settings = {...source, ...codec};
  if (settings.quality < 100 && (data instanceof Float32Array || settings.sampleFormat === 'float16')) throw fail('JXL_UNSUPPORTED', `Lossy float (HDR) needs ${FULL}; this module encodes it exactly.`);
  const low = lowPhotoSteps(data, width, height, settings);
  const steps = low ?? (settings.effort === 1 ? coreSteps(data, width, height, settings) : effortJob(data, width, height, settings, false));
  return helpers && (low || settings.effort !== 1) ? driveSteps(steps, hooks, undefined, width * height, helpers, null) : drain(steps, hooks);
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
    onProgress: progressOf(report, options.signal)};
  await kernelsReady();
  check(hooks.signal);
  v6Trace('upload: split at once');
  const bytes = await drain(splitAsk(captured.input.data, width, height, direct), {...hooks, split: helpers.split});
  if (bytes) return bytes;
  check(hooks.signal);
  v6Trace('upload: no split, the full route');
  const {data: owned, ...source} = captured.input;
  if (direct.lowWebp !== undefined) return encodePicture(captured.input, captured.codec, hooks, helpers);
  return driveSteps(effortJob(owned, width, height, {...source, ...captured.codec}, false), hooks, undefined, width * height, helpers, null);
}
function* splitAsk(data, width, height, {quality, gaborish, lowWebp, effort, lowFilteredQuality}) {
  if (lowWebp !== undefined) return (yield {split: {pixels: width * height,
    run: (helpers, options) => encodeLowSplit(data, width, height, quality, effort, helpers, {...options, smooth: smoothDecides({effort, quality}) && smoothPhoto(data, width, height), lowFilteredQuality})}}) ?? null;
  return (yield {split: {pixels: width * height, run: (helpers, options) =>
    encodeSplit(data, width, height, quality, helpers, {...options, gaborish, screen: false, opaque: true})}}) ?? null;
}

function directRoute(read, maxPixels) {
  if (typeof document !== 'undefined' || !kernelHooks.gabBand || !kernelHooks.acGroup || !kernelHooks.channel) return null;
  const {data, width, height, ...source} = read.input, settings = {...source, ...read.codec};
  if (source.orientation !== undefined || source.extraChannels !== undefined || settings.photo === false || !(settings.effort >= 1 && settings.effort <= 3)) return null;
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
  if (!journalFact(data, JOIN) && measure(read, maxPixels) > DEFAULT_INPUT_BYTES) return null;
  for (let p = 0, step = Math.max(1, Math.floor(width * height / 16384)); p < width * height; p += step) if (data[p * 4 + 3] !== 255) return null;
  const shape = inspectPixels(data, width, height, {opacity: false});
  if (shape.palette || shape.alpha || !preferXYB(data, width, height) || screenLike(data, width, height)) return null;
  return {quality, gaborish: settings.effort === 3, effort: settings.effort, lowWebp: settings.lowWebp, lowFilteredQuality: settings.lowFilteredQuality};
}

async function carry(jpeg, effort, hooks) {
  bytes(jpeg); jpegDimensions(jpeg, hooks.maxPixels); check(hooks.signal);
  await kernelsReady();
  return drain(ansTranscodeSteps(jpeg, {effort, maxPixels: hooks.maxPixels, tails: longTail}), hooks);
}
