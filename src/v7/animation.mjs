import {encodeAnimationJob} from '../animation-steps.mjs';
import {useMeasuredSearch} from '../animation-frames.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {described, isDecoded, fromDecoded} from './describe.mjs';
import {isPlainRecord} from './records.mjs';
import {surface} from './surface.mjs';
import {check, dimensions, fail, declared, callers} from './primitives.mjs';
import {drain, encodeOptions, callOptions} from './common.mjs';
import {own} from './ownership.mjs';
import {acceleration} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {encode as encodeStill} from './still.mjs';
import {DRIVE} from './drive.mjs';
export {capture, prepare, supported, configureWasm} from './still.mjs';

const read = input => isPlainRecord(input) && isDecoded(input) ? fromDecoded(input) : input;
const admitted = input => { try { return {input: read(input)}; } catch (error) { return {refused: Promise.reject(declared(error))}; } };
export const encode = (input, options) => {
  const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture;
  let frames;
  try { frames = Array.isArray(input?.frames); } catch (error) { return Promise.reject(callers(error)); }
  return frames ? animate(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); })
    : encodeStill(input, options);
};
encode[DRIVE] = (input, options, helpers) => { const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture; return Array.isArray(input?.frames) ? encode(input, options) : encodeStill[DRIVE](input, options, helpers); };

async function animate(input, options = {}) {
  const {codec: {target, ...settings}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  check(options.signal);
  if (target !== undefined || options.features !== undefined) throw fail('JXL_OPTIONS', 'An animation takes exact or a quality, and no features.');
  if (input.orientation !== undefined || input.extraChannels !== undefined) throw fail('JXL_INPUT', 'An animation takes no orientation or extra channels.');
  const read = surface(input, {maxPixels, readAs: options.readAs});
  dimensions(read.width, read.height, maxPixels);
  const animation = own(read, maxPixels), codec = {...described(animation), ...settings};
  const report = options.onProgress, onProgress = report && (fraction => { try { report(fraction); } catch (error) { throw callers(error); } });
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels};
  if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100, codec.effort);
  await acceleration(webgpu, 0, 0, codec.quality < 100 ? codec.effort : 0, 'an animation');
  check(hooks.signal);
  if (codec.quality < 100 && codec.effort >= 8) useMeasuredSearch(searchV6);
  return drain(encodeAnimationJob(animation, codec), hooks);
}
