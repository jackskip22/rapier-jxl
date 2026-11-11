import {resultOperation, resultReference, resultFacts, RAW_OPERATION} from './result-operation.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {encodeAnimationJob} from '../animation-steps.mjs';
import {useMeasuredSearch} from '../animation-frames.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {described, isDecoded, fromDecoded} from './describe.mjs';
import {isPlainRecord} from './records.mjs';
import {surface} from './surface.mjs';
import {check, dimensions, fail, declared, callers, progressOf, admitSignal} from './primitives.mjs';
import {drain, encodeOptions, callOptions} from './common.mjs';
import {own, withCost} from './ownership.mjs';
import {untilAborted} from './rows.mjs';
import {acceleration} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {encode as encodeStill} from './still.mjs';
import {DRIVE} from './drive.mjs';
import {featureless} from './first-region-option.mjs';
import {animationPhoto} from './animation-photo.mjs';
import {readGifBytes} from './gif-source.mjs';
import {isBlob} from './result-identity.mjs';
export {supported, configureWasm, prepare} from './still.mjs';

const read = input => isPlainRecord(input) && isDecoded(input) ? fromDecoded(input) : input;
const admitted = input => { try { return {input: read(input)}; } catch (error) { return {refused: Promise.reject(declared(error))}; } };
const GIF = [71, 73, 70];
async function gifFrames(blob, options, signal) {
  check(signal);
  if (options?.readAs !== undefined || blob.size < 13) return null;
  const head = new Uint8Array(await untilAborted(blob.slice(0, 3).arrayBuffer(), signal));
  check(signal);
  if (!GIF.every((b, i) => head[i] === b)) return null;
  const bytes = new Uint8Array(await untilAborted(blob.arrayBuffer(), signal));
  check(signal);
  const read = readGifBytes(bytes, 'input.gif', options?.maxPixels ?? 40000000);
  if (read.kind !== 'animation') return null;
  for (const {data} of read.animation.frames) withCost(data, data.byteLength);
  return read.animation;
}
const gifOr = (input, options, animated, still) => (async () => {
  const signal = admitSignal(options?.signal);
  let frames;
  try { frames = await gifFrames(input, options, signal); } catch (error) { check(signal); throw declared(error); }
  return frames ? animated(frames) : still();
})();
const encodeBytes = (input, options) => {
  if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), () => encodeStill[RAW_OPERATION](input, options));
  const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture;
  let frames;
  try { frames = Array.isArray(input?.frames); } catch (error) { return Promise.reject(callers(error)); }
  return frames ? animate(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); })
    : encodeStill[RAW_OPERATION](input, options);
};
encodeBytes[DRIVE] = (input, options, helpers) => { if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), () => encodeStill[RAW_OPERATION][DRIVE](input, options, helpers)); const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture; return Array.isArray(input?.frames) ? encodeBytes(input, options) : encodeStill[RAW_OPERATION][DRIVE](input, options, helpers); };

export const encode = resultOperation(encodeBytes, {preview: previewCall});
export {resultJSON} from './result.mjs';
async function animate(input, options = {}) {
  options = featureless(options);
  const {codec: {target, ...settings}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  check(options.signal);
  if (target !== undefined || options.features !== undefined) throw fail('JXL_OPTIONS', 'An animation takes exact or a quality, and no features.');
  if (input.orientation !== undefined || input.extraChannels !== undefined) throw fail('JXL_INPUT', 'An animation takes no orientation or extra channels.');
  const read = surface(input, {maxPixels, readAs: options.readAs});
  dimensions(read.width, read.height, maxPixels);
  const animation = own(read, maxPixels), codec = {...described(animation), ...settings};
  resultReference(options, animation);
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels,
    ...(options[PREVIEW] && {preview: options[PREVIEW]})};
  if (webgpu === 'required') await requireWebGPU('required', codec.quality < 100, codec.effort);
  await acceleration(webgpu, 0, 0, codec.quality < 100 ? codec.effort : 0, 'an animation');
  check(hooks.signal);
  if (codec.quality < 100 && codec.effort >= 8) useMeasuredSearch(searchV6);
  const answer = await animationPhoto(animation, codec,
    (coding, onProgress) => drain(encodeAnimationJob(animation, coding), {...hooks, onProgress}), hooks);
  resultFacts(options, {kept: answer.exact ? 'pixels' : 'lossy', measurements: answer.measurements});
  return answer.bytes;
}
