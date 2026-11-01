import {effortJob} from '../effort-job.mjs';
import {EXACT_LADDER as DEEP} from '../exact-ladder.mjs';
import {photoAnsSteps} from '../photo-v6-blocks.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {encodePhotoSteps} from '../photo-advanced.mjs';
import {encodeToScoreSteps} from '../score.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {readPNG16} from '../source.mjs';
import {compileCaptureKernels} from '../capture-codec.mjs';
import {coreSteps} from './instant.mjs';
import {bytes, check, fail, declared, callers, isCaller} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions, targetSource} from './common.mjs';
import {parallelJob} from '../parallel-drive.mjs';
import {DRIVE} from './drive.mjs';
import {takeFirstRegion, orderRegion} from './first-region.mjs';
import {image, pixels, jpegDimensions} from './input.mjs';
import {own, DEFAULT_INPUT_BYTES} from './ownership.mjs';
import {encodeBands, WHOLE} from './bands.mjs';
import {needsBands} from './band-size.mjs';
import {recodeBand} from './band-recode.mjs';
import {HDR} from '../photo-hdr.mjs';
import {isRowSource, admitRows, readBand} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {isPlainRecord} from './records.mjs';
import {isDecoded, fromDecoded} from './describe.mjs';
import {acceleration, describedRoute} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {capture, prepare as prepareCapture} from './capture.mjs';
export {capture};
export {supported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';

const FEATURED = 'Orientation, extra channels and features need an 8-bit lossy encode in this version; exact and deeper samples write them in a later 8.x.';

let prepared;
export function prepare(operation = 'encode') {
  if (operation === 'capture') return prepareCapture();
  if (operation !== 'encode') return Promise.reject(fail('JXL_OPTIONS', 'prepare names encode or capture.'));
  return prepared ||= (async () => { await acceleration(false, 0, 0); await compileCaptureKernels(); })()
    .catch(error => { prepared = undefined; throw declared(error); });
}

export const encode = (input, options) => regioned(encodeHere, input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
encode[DRIVE] = (input, options, helpers) => regioned(encodeHere, input, options, helpers).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function encodeHere(input, options = {}, helpers = null) {
  const {codec: {target, ...codec}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  const readAs = options.readAs;
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  if (isRowSource(input)) {
    if (readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source names its own space (colorSpace).');
    if (target !== undefined || options.features !== undefined) throw fail('JXL_UNSUPPORTED', 'A picture given in bands takes no measured fidelity or features in this version.');
    const source = admitRows(input, maxPixels), report = options.onProgress;
    const hooks = {signal: options.signal ?? new AbortController().signal, maxPixels, onProgress: report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } })};
    if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100, codec.effort);
    return encodeBands({width: source.width, height: source.height, read: (y, rows) => readBand(source, y, rows, hooks.signal)},
      (band, bandHooks) => encodePicture(band, codec, bandHooks, helpers, webgpu), (band, shared) => recodeBand(band, codec, shared, HDR, ...bandCoders(codec)), drain, hooks);
  }
  const budget = Math.max(DEFAULT_INPUT_BYTES, maxPixels * 16);
  const features = own(options.features, maxPixels, budget);
  if (isTexture(input)) input = await readTexture(input, maxPixels);
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  let captured = blob ? null : own({input: pixels(input, {readAs}, maxPixels, true), codec, features, target}, maxPixels, budget);
  const report = options.onProgress, onProgress = report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } });
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels};
  if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100 || target !== undefined, codec.effort);
  let carried = null;
  if (blob && codec.quality === 100 && target === undefined && readAs === undefined && features === undefined) {
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
    captured = own({input: picture, codec, features, target}, maxPixels, budget);
  }
  const {data, width, height, ...source} = captured.input;
  check(hooks.signal);
  const settings = {...source, ...captured.codec};
  const featured = captured.features !== undefined || source.orientation !== undefined || source.extraChannels !== undefined;
  if (width * height > WHOLE && (captured.target !== undefined || featured))
    throw fail('JXL_UNSUPPORTED', 'Above 40 megapixels a picture is coded in bands, which take no measured fidelity, orientation, extra channels or features in this version.');
  if (captured.target !== undefined) {
    if (source.orientation !== undefined || source.extraChannels !== undefined)
      throw fail('JXL_INPUT', 'A measured fidelity takes 8-bit straight sRGB RGBA, without orientation or extra channels.');
    targetSource(data, source, settings);
    await acceleration(webgpu, 0, 0, settings.effort, 'a measured fidelity');
    return (await drain(encodeToScoreSteps(data, width, height, {target: captured.target, effort: settings.effort}), hooks)).bytes;
  }
  if (featured) {
    if (settings.quality === 100 || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw fail('JXL_UNSUPPORTED', FEATURED);
    await acceleration(webgpu, 0, 0, settings.effort, 'codestream features');
    return drain(encodePhotoSteps(data, width, height, {...settings, ...captured.features}), hooks);
  }
  if (needsBands(width, height, settings, data)) return encodeBands({width, height, read: (y, rows) => ({...source, data: data.subarray(y * width * 4, (y + rows) * width * 4), width, height: rows})},
    (band, bandHooks) => encodePicture(band, captured.codec, bandHooks, helpers, webgpu), (band, target) => recodeBand(band, captured.codec, target, HDR, ...bandCoders(captured.codec)), drain, hooks);
  return encodePicture(captured.input, captured.codec, hooks, helpers, webgpu);
}

const bandCoders = codec => [codec.effort >= 6 ? photoAnsSteps : undefined, codec.effort >= 8 ? searchV6 : undefined];

async function encodePicture({data, width, height, ...source}, codec, hooks, helpers, webgpu) {
  const settings = {...source, ...codec}, lossy = settings.quality < 100;
  const gpu = await acceleration(webgpu, width, height, lossy ? settings.effort : 0, describedRoute(data, settings));
  check(hooks.signal);
  const steps = settings.effort === 1 ? coreSteps(data, width, height, settings)
    : effortJob(data, width, height, settings, !!gpu, undefined, lossy && settings.effort >= 8 ? searchV6 : undefined,
        lossy && settings.effort >= 6 ? photoAnsSteps : undefined, DEEP, HDR);
  return helpers && settings.effort !== 1 ? driveSteps(steps, hooks, gpu, width * height, helpers, parallelJob) : drain(steps, hooks, gpu);
}

async function carry(jpeg, effort, hooks) {
  bytes(jpeg); jpegDimensions(jpeg, hooks.maxPixels); check(hooks.signal);
  await acceleration(false, 0, 0);
  return drain(ansTranscodeSteps(jpeg, {effort}), hooks);
}

async function regioned(run, input, options, helpers) {
  const {region, options: rest} = takeFirstRegion(options);
  return orderRegion(await run(input, rest, helpers), region);
}
