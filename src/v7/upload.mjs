import {effortJob} from '../effort-job.mjs';
import {ansTranscodeSteps} from '../jpeg-ans-effort.mjs';
import {readPNG16} from '../source.mjs';
import {coreSteps} from './instant.mjs';
import {bytes, check, fail, declared, callers, isCaller} from './primitives.mjs';
import {drain, driveSteps, encodeOptions, callOptions} from './common.mjs';
import {DRIVE} from './drive.mjs';
import {image, pixels, jpegDimensions} from './input.mjs';
import {own} from './ownership.mjs';
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
  let captured = blob ? null : own({input: pixels(input, options, maxPixels), codec}, maxPixels);
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

async function carry(jpeg, effort, hooks) {
  bytes(jpeg); jpegDimensions(jpeg, hooks.maxPixels); check(hooks.signal);
  await kernelsReady();
  return drain(ansTranscodeSteps(jpeg, {effort}), hooks);
}
