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
import {image, pixels, jpegDimensions} from './input.mjs';
import {own} from './ownership.mjs';
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

export const encode = (input, options) => encodeHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
encode[DRIVE] = (input, options, helpers) => encodeHere(input, options, helpers).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function encodeHere(input, options = {}, helpers = null) {
  const {codec: {target, ...codec}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  check(options.signal);
  if (isPlainRecord(input) && isDecoded(input)) input = fromDecoded(input);
  if (Array.isArray(input?.frames)) throw fail('JXL_UNSUPPORTED', 'An animation is encoded by rapier-jxl/animation.');
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  let captured = blob ? null : own({input: pixels(input, options, maxPixels), codec, features: options.features, target}, maxPixels);
  const report = options.onProgress, onProgress = report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } });
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels};
  if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100 || target !== undefined, codec.effort);
  let carried = null;
  if (blob && codec.quality === 100 && target === undefined && options.readAs === undefined && options.features === undefined) {
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
    captured = own({input: picture, codec, features: options.features, target}, maxPixels);
  }
  const {data, width, height, ...source} = captured.input;
  check(hooks.signal);
  const settings = {...source, ...captured.codec};
  const featured = captured.features !== undefined || source.orientation !== undefined || source.extraChannels !== undefined;
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
  const lossy = settings.quality < 100;
  const gpu = await acceleration(webgpu, width, height, lossy ? settings.effort : 0, describedRoute(data, settings));
  check(hooks.signal);
  const steps = settings.effort === 1 ? coreSteps(data, width, height, settings)
    : effortJob(data, width, height, settings, !!gpu, undefined, lossy && settings.effort >= 8 ? searchV6 : undefined,
        lossy && settings.effort >= 6 ? photoAnsSteps : undefined, DEEP);
  return helpers && settings.effort !== 1 ? driveSteps(steps, hooks, gpu, width * height, helpers, parallelJob) : drain(steps, hooks, gpu);
}

async function carry(jpeg, effort, hooks) {
  bytes(jpeg); jpegDimensions(jpeg, hooks.maxPixels); check(hooks.signal);
  await acceleration(false, 0, 0);
  return drain(ansTranscodeSteps(jpeg, {effort}), hooks);
}
