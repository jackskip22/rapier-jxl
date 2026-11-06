import {resultOperation, resultReference, resultFacts} from './result-operation.mjs';
import {effortJob} from '../effort-job.mjs';
import {EXACT_LADDER as DEEP} from '../exact-ladder.mjs';
import {photoAnsSteps} from '../photo-v6-blocks.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {encodePhotoSteps} from '../photo-advanced.mjs';
import {measuredFeatures} from './feature-photo.mjs';
import {scoreTarget} from './score-target.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {compileCaptureKernels} from '../capture-codec.mjs';
import {coreSteps} from './instant.mjs';
import {check, fail, declared, callers, progressOf, JPEG_ELSEWHERE} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions} from './common.mjs';
import {parallelJob} from '../parallel-drive.mjs';
import {DRIVE} from './drive.mjs';
import {takeFirstRegion, orderRegion} from './first-region.mjs';
import {image, pixels} from './input.mjs';
import {inspectPhone} from './phone-container.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {encodeBands, WHOLE} from './bands.mjs';
import {needsBands} from './band-size.mjs';
import {recodeBand} from './band-recode.mjs';
import {ordinaryStillReader} from './ordinary-still-policy.mjs';
import {lowPhotoSteps} from './low-photo.mjs';
import {stillPhotoTargetSteps} from './still-photo-target.mjs';
import {HDR} from '../photo-hdr.mjs';
import {isRowSource, admitRows, readBand} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {acceleration, describedRoute} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {JOURNAL, journaled} from '../step-journal.mjs';
import {verbSteps, STEPS} from './verb-steps.mjs';
export {supported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';

const FEATURED = 'Orientation, extra channels and features need 8-bit lossy.';

let prepared;
export function prepare(operation = 'encode') {
  if (operation === 'capture') return Promise.reject(fail('JXL_OPTIONS', 'Page capture is rapier-jxl/capture-complete: prepare() there.'));
  if (operation !== 'encode') return Promise.reject(fail('JXL_OPTIONS', 'prepare names encode, fit or variants.'));
  return prepared ||= (async () => { await acceleration(false, 0, 0); await compileCaptureKernels(); })()
    .catch(error => { prepared = undefined; throw declared(error); });
}

const encodeBytes = (input, options) => regioned(encodeHere, input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
encodeBytes[DRIVE] = (input, options, helpers) => regioned(encodeHere, input, options, helpers).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
export const encode = resultOperation(encodeBytes);
Object.defineProperty(encode, STEPS, {value: verbSteps('encode:rapier-jxl', encode, {taken: ['fidelity', 'effort', 'readAs', 'maxPixels', 'features', 'webgpu']})});
export {resultJSON} from './result.mjs';
async function encodeHere(input, given = {}, helpers = null, region) {
  const journal = given?.[JOURNAL], options = journal === undefined ? given : (({[JOURNAL]: _journal, ...rest}) => rest)(given);
  const {codec: {target, ...codec}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  const reader = ordinaryStillReader({signal: options.signal, maxPixels});
  try { return await encodeOwned(input, options, helpers, {codec, target, webgpu, maxPixels, journal}, reader, region); }
  finally { reader.destroy(); }
}

async function encodeOwned(input, options, helpers, {codec, target, webgpu, maxPixels, journal}, reader, region) {
  const readAs = options.readAs;
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source sets colorSpace.');
    if (target !== undefined || options.features !== undefined) throw fail('JXL_UNSUPPORTED', 'A banded picture takes no measured fidelity or features.');
    const source = admitRows(input, maxPixels), report = options.onProgress;
    source.description = own(source.description, maxPixels);
    resultReference(options, source);
    const hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, onProgress: progressOf(report, options.signal), journal};
    if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100, codec.effort);
    let exact = true;
    const settle = async band => {
      const settled = reader.read(codec, band) ?? await reader.project(codec, band);
      exact &&= settled.quality === 100; return settled;
    };
    const bytes = await encodeBands({width: source.width, height: source.height, read: (y, rows) => readBand(source, y, rows, hooks.signal)},
      async (band, bandHooks) => encodePicture(band, await settle(band), bandHooks, helpers, webgpu), async function* (band, shared) {
        const settled = await settle(band); return yield* recodeBand(band, settled, shared, HDR, ...bandCoders(settled));
      }, drain, hooks);
    if (exact) resultFacts(options, {kept: 'pixels', measurements: []});
    return bytes;
  }
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  const features = own(options.features, maxPixels, budget);
  const settle = picture => reader.read(codec, picture, {exactAllowed: features === undefined && target === undefined &&
    picture.orientation === undefined && picture.extraChannels === undefined}) ?? reader.project(codec, picture);
  if (isTexture(input)) input = await readTexture(input, maxPixels);
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  const read = blob ? null : pixels(input, {readAs}, maxPixels, true);
  let captured = blob ? null : own({input: read, codec, features, target}, maxPixels, budget);
  if (captured) resultReference(options, captured.input);
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels, journal};
  if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100 || target !== undefined, codec.effort);
  if (captured) captured.codec = await settle(captured.input);
  if (blob && codec.quality === 100 && target === undefined && readAs === undefined && features === undefined) {
    const head = new Uint8Array(await input.slice(0, 2).arrayBuffer());
    check(hooks.signal);
    if (head[0] === 255 && head[1] === 216) throw fail('JXL_OPTIONS', JPEG_ELSEWHERE);
  }
  if (blob) {
    const picture = await journaled(journal, 'decode', () => image(input, {readAs}, {...hooks, phone: inspectPhone, deep: async () => ({readSource: readPNG16, orient: orientSamples})}));
    captured = own({input: picture, codec, features, target}, maxPixels, budget);
    resultReference(options, captured.input, input);
    captured.codec = await settle(captured.input);
  }
  const {data, width, height, ...source} = captured.input;
  check(hooks.signal);
  const settings = {...source, ...captured.codec};
  if (settings.quality === 100) resultFacts(options, {kept: 'pixels', measurements: []});
  const featured = captured.features !== undefined || source.orientation !== undefined || source.extraChannels !== undefined;
  if (width * height > WHOLE && (captured.target !== undefined || featured))
    throw fail('JXL_UNSUPPORTED', 'Over 40 megapixels a picture is coded in bands: no measured fidelity, orientation, extra channels or features.');
  if (captured.target !== undefined) {
    if (featured)
      throw fail('JXL_INPUT', 'A measured fidelity takes no orientation, extra channels or features.');
    const answer = await scoreTarget(data, width, height, source, settings, captured.target, hooks, webgpu);
    resultFacts(options, answer.facts);
    return answer.bytes;
  }
  if (featured) {
    if (settings.quality === 100 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fail('JXL_UNSUPPORTED', FEATURED);
    await acceleration(webgpu, 0, 0, settings.effort, 'codestream features');
    const measured = await measuredFeatures(captured.input, captured.features, settings, codec.qualityIntent, hooks);
    if (measured) { resultFacts(options, {kept: 'lossy', measurements: measured.measurements}); return measured.bytes; }
    return drain(encodePhotoSteps(data, width, height, {...settings, ...captured.features}), hooks);
  }
  if (needsBands(width, height, settings, data)) return encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
    (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers, webgpu), (band, target) => recodeBand(band, captured.codec, target, HDR, ...bandCoders(captured.codec)), drain, hooks);
  return encodePicture(captured.input, captured.codec, hooks, helpers, webgpu, codec.qualityIntent,
    facts => resultFacts(options, facts));
}

const bandCoders = codec => [codec.effort >= 6 ? photoAnsSteps : undefined, codec.effort >= 8 ? searchV6 : undefined];

async function encodePicture({data, width, height, ...source}, codec, hooks, helpers, webgpu, intent, selected) {
  const settings = {...source, ...codec}, lossy = settings.quality < 100;
  const gpu = await acceleration(webgpu, width, height, lossy ? settings.effort : 0, describedRoute(data, settings));
  check(hooks.signal);
  const target = stillPhotoTargetSteps(data, width, height, settings, {intent, signal: hooks.signal, selected, maxPixels: hooks.maxPixels,
    exact: () => effortJob(data, width, height, {...settings, quality: 100, effort: 4}, false,
      undefined, undefined, undefined, DEEP, HDR)});
  const low = target ?? lowPhotoSteps(data, width, height, settings);
  const steps = low ?? (settings.effort === 1 ? coreSteps(data, width, height, settings)
    : effortJob(data, width, height, settings, !!gpu, undefined, lossy && settings.effort >= 8 ? searchV6 : undefined,
        lossy && settings.effort >= 6 ? photoAnsSteps : undefined, DEEP, HDR));
  return helpers && (low || settings.effort !== 1) ? driveSteps(steps, hooks, gpu, width * height, helpers, low ? null : parallelJob) : drain(steps, hooks, gpu);
}

async function regioned(run, input, options, helpers) {
  const {region, options: rest} = takeFirstRegion(options);
  return orderRegion(await run(input, rest, helpers, region), region);
}
