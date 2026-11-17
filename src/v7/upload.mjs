import {previewCall} from './preview.mjs';
import {smallExactBeside, exactCandidate} from './exact-cap.mjs';
import {resultOperation, resultReference, resultFacts, RESULT_REFERENCE} from './result-operation.mjs';
import {JOURNAL, JOURNAL_FILE, journaled, journalFact, JOIN} from '../step-journal.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
import {effortJob} from '../effort-job.mjs';
import {readPNG16} from '../source.mjs';
import {journalPNG} from './journal-png.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {namedPicture} from './result-reference.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {coreSteps} from './instant.mjs';
import {check, fail, declared, callers, progressOf, dimensions} from './primitives.mjs';
import {drain, driveSteps, callOptions} from './common.mjs';
import {uploadOptions} from './upload-options.mjs';
import {ordinaryStillReader, predictedFacts} from './ordinary-still-policy.mjs';
import {lowPhotoSteps, lowPhotoRoute, encodeLowSplit, makeLowUpload, finishLowUpload, closeLowUpload, smoothPhoto, smoothDecides} from './low-photo.mjs';
import {lowIntentFacts, settledFacts, lowIntentEligible} from './low-intent-quality.mjs';
import {settleScans} from './settle-scans.mjs';
import {preparationUpload} from './preparation-upload.mjs';
import {fitOptions, variantsOptions} from './preparation-options.mjs';
import {DRIVE} from './drive.mjs';
import {image, pixels} from './input.mjs';
import {jpegPixels} from './jpeg-pixels.mjs';
import {JPEG_SOURCE, jpegSource, chooseJpeg} from './jpeg-choice.mjs';
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
import {pagePicture, pageFile, exactCodec, unletteredFile, letteredSteps, lettersRead} from './page-route.mjs';
import {captureExact} from '../capture-codec.mjs';
import {textFloorEligible, textFloorSteps} from '../text-floor.mjs';
import {withProgressive} from '../progressive-mode.mjs';
import {CAPTURE_UPLOAD, carriedBy} from './capture-levels.mjs';
const carried = carriedBy('rapier-jxl/upload', CAPTURE_UPLOAD);
const runCapture = lowCaptureRunner();
const capture = captureWith(null,{admit:options => admitCapturePhoto(options,carried),rectangles:captureRectangles,run:runCapture},imageResult), prepareCapture = () => prepareCapturePhoto().catch(error => { throw declared(error); });
import {compileCaptureKernels} from '../capture-codec.mjs';
export {wasmOnlySupported as supported} from './capture-support.mjs';
export {configureDecoder} from '../shown-picture.mjs';

const FULL = 'jpegxl';

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
function prepare(operation = 'encode') {
  if (operation === 'capture') return prepareCapture();
  if (operation !== 'encode') return Promise.reject(fail('JXL_OPTIONS', 'operation: encode or capture'));
  return prepared ||= (async () => { await kernelsReady(); await compileCaptureKernels(); if (typeof document === 'undefined') for (let i = 0; i < WARM_UPLOADS; i++) await warmUpload(); })()
    .catch(error => { prepared = undefined; throw declared(error); });
}
prepare.operations = ['encode', 'capture'];

const encodeBytes = (input, options) => encodeHere(input, options).catch(error => { throw declared(error); });
encodeBytes[DRIVE] = (input, options, helpers) => encodeHere(input, options, helpers).catch(error => { throw declared(error); });
const encode = resultOperation(encodeBytes, {preview: previewCall});
const {fit, variants} = preparationUpload(encodeBytes, {jpegPixels, deep: async () => ({readSource: (bytes, options) => readPNG16(bytes, {...options, named: true}), orient: orientSamples})});
const TAKEN = ['fidelity', 'effort', 'progressive', 'jpeg', 'readAs', 'maxPixels'];
Object.defineProperty(encode, STEPS, {value: verbSteps('encode:rapier-jxl/upload', encode, {taken: TAKEN, admit: options => { uploadOptions(options); }, rows: true, files: true})});
Object.defineProperty(fit, STEPS, {value: verbSteps('fit:rapier-jxl/upload', fit, {taken: ['maxBytes', ...TAKEN], admit: options => { fitOptions(options, uploadOptions); }, rows: true, files: true})});
Object.defineProperty(variants, STEPS, {value: verbSteps('variants:rapier-jxl/upload', variants, {taken: ['outputs', ...TAKEN], admit: options => { variantsOptions(options, uploadOptions); }})});
async function encodeHere(input, given = {}, helpers = null) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw fail('JXL_OPTIONS', 'options: object');
  const journal = given[JOURNAL], original = given[JPEG_SOURCE];
  const options = journal === undefined && original === undefined ? given : (({[JOURNAL]: _journal, [JPEG_SOURCE]: _jpeg, ...rest}) => rest)(given);
  const {codec, hooks: {webgpu: _webgpu, maxPixels}} = callOptions(uploadOptions(options));
  const reader = ordinaryStillReader({signal: options.signal, maxPixels});
  const intended = {};
  const run = async (settings = options, jpeg) => withRenderingIntent(await encodeOwned(input, settings, helpers,
    codec, maxPixels, reader, journal, intended,
    original?.preserve === false || settings.readAs !== undefined ? undefined : jpeg), intended.intent, journal?.join);
  const source = jpegSource(input, original);
  try { return await (source ? chooseJpeg(source, codec, options,
    {signal: options.signal, maxPixels, journal, preserve: !codec.progressive && original?.preserve !== false,
      readsSource: original?.bytes === undefined}, run) : run()); }
  finally { reader.destroy(); }
}

async function encodeOwned(input, options, helpers, codec, maxPixels, reader, journal, intended = {}, jpeg) {
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
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'animated input: use jpegxl/animation');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs: not with row source');
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
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) throw fail('JXL_UNSUPPORTED', 'texture: use jpegxl');
  const blob = decoded !== null || typeof Blob !== 'undefined' && input instanceof Blob;
  let borrowed = blob ? null : journal ? admitPicture(journalPixels(input, maxPixels)) : admitPicture(pixels(input, {readAs}, maxPixels, true));
  if (borrowed) [borrowed, intended.intent] = namedPicture(options, borrowed, codec.quality < 100);
  const read = blob ? null : {input: borrowed, codec: kernelHooks.opaque || kernelHooks.ensure?.() ? reader.read(codec, borrowed, {jpeg}) : null};
  const direct = read?.codec && !(codec.qualityIntent !== undefined && kernelHooks.channel &&
    pagePicture(read.input.data, read.input.width, read.input.height, {...read.input, ...read.codec})) ? directRoute(read, maxPixels) : null;
  if (direct) {
    check(options.signal);
    if (options[RESULT_REFERENCE]) resultReference(options, read.input);
  }
  if (direct && helpers?.split) return splitHere(read, direct, helpers, options, maxPixels);
  const low = direct?.lowIntent !== undefined && makeLowUpload(read.input.data, read.input.width, read.input.height, direct.quality, direct.effort,
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
  if (captured && captured.codec === null) { await kernelsReady(); check(hooks.signal); captured.codec = await reader.project(codec, captured.input, {jpeg}); }
  if (blob) {
    let picture = decoded;
    if (!picture) picture = await journaled(journal, 'decode', () => image(input, {readAs, exact: !(codec.quality < 100)}, {...hooks, phone: inspectPhone, jpegPixels, deep: async () => ({readSource: readPNG16, orient: orientSamples})}));
    [picture, intended.intent] = namedPicture(options, picture, codec.quality < 100);
    captured = decoded ? {input: admitPicture(picture), ...own({codec}, maxPixels, budget)} : own({input: admitPicture(picture), codec}, maxPixels, budget);
    resultReference(options, captured.input, input);
    if (decoded && lowIntentEligible(captured.input))
      settledFacts.set(captured.input.data, await journal.tools.settleFacts(journal, settleScans, captured.input.data, captured.input.width, captured.input.height));
    else if (!journal && codec.qualityIntent !== undefined && lowIntentEligible(captured.input))
      settledFacts.set(captured.input.data, lowIntentFacts(captured.input));
    captured.codec = await journaled(journal, 'settle', async () => reader.read(codec, captured.input, {jpeg}) ?? await reader.project(codec, captured.input, {jpeg}));
  }
  const {data, width, height, ...source} = captured.input;
  if (captured.codec.quality === 100) resultFacts(options, {kept: 'pixels', measurements: []});
  else if (predictedFacts(captured.codec)) resultFacts(options, predictedFacts(captured.codec));
  check(hooks.signal);
  await kernelsReady();
  check(hooks.signal);
  if (width * height > WHOLE) return encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
    (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers), (band, target) => recodeBand(band, captured.codec, target), drain, hooks);
  const route = {page: false};
  const bytes = await encodePicture(captured.input, captured.codec, hooks, helpers, codec.qualityIntent, facts => resultFacts(options, facts), route);
  if (!(codec.qualityIntent !== undefined && codec.quality < 100)) return bytes;
  const exact = captured.codec.quality < 100 && await smallExactBeside(bytes, captured.input, captured.codec.effort,
    exactCandidate(captured.input, runCapture, effort => encodePicture(captured.input, exactCodec({...captured.codec, effort}), hooks, helpers), hooks));
  if (exact) { resultFacts(options, {kept: 'pixels', measurements: []}); return exact; }
  if (!(captured.codec.quality === 100 || captureExact(bytes) || route.page)) return bytes;
  if (captured.codec.quality < 100 && captureExact(bytes)) resultFacts(options, {kept: 'pixels', measurements: []});
  const picture = captured.input;
  const answer = await unletteredFile(picture, bytes, async () => reader.read(codec, picture, {jpeg, exactAllowed: false}) ?? await reader.project(codec, picture, {jpeg}),
    async lossy => {
      const {data: _data, width: _width, height: _height, ...description} = picture;
      let facts = predictedFacts({...description, ...lossy});
      const other = await encodePicture(picture, lossy, hooks, helpers, undefined, selected => { facts = selected; });
      return {bytes: other, facts};
    });
  if (!answer) return bytes;
  resultFacts(options, answer.facts ?? {kept: 'lossy', measurements: []});
  return answer.bytes;
}

function journalPixels({data, width, height, colorSpace, colorEncoding}, maxPixels) {
  dimensions(width, height, maxPixels);
  return {data, width, height, ...(colorSpace && {colorSpace}), ...(colorEncoding && {colorEncoding})};
}

function admitPicture(picture) {
  if (picture.orientation !== undefined || picture.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'orientation or extraChannels: use jpegxl');
  return picture;
}

async function encodePicture({data, width, height, ...source}, codec, hooks, helpers, intent, selected, route = null) {
  const settings = {...source, ...codec};
  if (settings.quality < 100 && (data instanceof Float32Array || settings.sampleFormat === 'float16')) throw fail('JXL_UNSUPPORTED', `lossy float: use ${FULL}`);
  if (intent !== undefined && await journaled(hooks.journal, 'page-route', () => pagePicture(data, width, height, settings))) {
    if (route) route.page = true;
    return pageFile(runCapture, {data, width, height}, {qualityIntent: intent}, settings.effort, hooks, selected, undefined,
      () => encodePicture({data, width, height, ...source}, exactCodec(codec), hooks, helpers));
  }
  const lettered = intent !== undefined && await lettersRead(hooks.journal, {data, width, height, ...source}, settings) ? letteredSteps({data, width, height, ...source}, settings, intent,
    () => settings.effort === 1 ? coreSteps(data, width, height, exactCodec(settings))
      : effortJob(data, width, height, exactCodec(settings), false), selected) : null;
  const low = lettered ? null : lowPhotoSteps(data, width, height, settings, await journaled(hooks.journal, 'low-route', () => lowPhotoRoute(data, width, height, settings, settledFacts.get(data))));
  const coded = lettered ?? low ?? (settings.effort === 1 ? coreSteps(data, width, height, settings) : effortJob(data, width, height, settings, false));
  const floored = settings.quality < 100 && await journaled(hooks.journal, 'text-floor', () => textFloorEligible(data, width, height, settings, settledFacts.get(data)));
  const baseSteps = floored ? textFloorSteps(coded, data, width, height, settings.colorSpace) : coded;
  const steps = settings.progressive ? withProgressive(true, baseSteps) : baseSteps;
  return helpers && !lettered && (low || settings.effort !== 1) ? driveSteps(steps, hooks, undefined, width * height, helpers, null) : drain(steps, hooks);
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
  if (direct.lowIntent !== undefined) return encodePicture(captured.input, captured.codec, hooks, helpers);
  return driveSteps(effortJob(owned, width, height, {...source, ...captured.codec}, false), hooks, undefined, width * height, helpers, null);
}
function* splitAsk(data, width, height, {quality, gaborish, lowIntent, effort, lowFilteredQuality}) {
  if (lowIntent !== undefined) return (yield {split: {pixels: width * height,
    run: (helpers, options) => encodeLowSplit(data, width, height, quality, effort, helpers, {...options, smooth: smoothDecides({effort, quality}) && smoothPhoto(data, width, height), lowFilteredQuality})}}) ?? null;
  return (yield {split: {pixels: width * height, run: (helpers, options) =>
    encodeSplit(data, width, height, quality, helpers, {...options, gaborish, screen: false, opaque: true})}}) ?? null;
}

function directRoute(read, maxPixels) {
  if (typeof document !== 'undefined' || !kernelHooks.gabBand || !kernelHooks.acGroup || !kernelHooks.channel) return null;
  const {data, width, height, ...source} = read.input, settings = {...source, ...read.codec};
  if (settings.progressive || source.orientation !== undefined || source.extraChannels !== undefined || settings.photo === false || !(settings.effort >= 1 && settings.effort <= 3)) return null;
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
  return {quality, gaborish: settings.effort === 3, effort: settings.effort, lowIntent: settings.lowIntent, lowFilteredQuality: settings.lowFilteredQuality};
}

import * as self from './upload.mjs';
import {serveRole, ownFile, roleName} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import * as pool from '../helper-pool.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveSplit} from '../photo-split.mjs';
const NAME = 'rapier-jxl/upload';
serveRole(NAME, {
  worker: () => install(workerPort(), [], moduleRuntime(self, {name: NAME, helpers: async () => pool, helper: ownFile(roleName(NAME, 'helper'))}), previewHub),
  helper: () => {
    const runtime = moduleRuntime(self, {name: NAME});
    serveHelper(() => ({name: NAME, protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit}));
  }});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl/upload', {encode, fit, variants, capture, prepare}, {pool, url: () => new URL(import.meta.url), prepareOp: 'encode'});
const encodeIn = here.wrap('encode'), fitIn = here.wrap('fit'), variantsIn = here.wrap('variants'), captureIn = here.wrap('capture'), prepareIn = here.wrap('prepare');
export {encodeIn as encode, fitIn as fit, variantsIn as variants, captureIn as capture, prepareIn as prepare};
export const {configure, close} = here;
