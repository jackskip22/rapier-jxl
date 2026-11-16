import {resultOperation, resultReference, resultFacts, RAW_OPERATION} from './result-operation.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {encodeAnimationJob} from '../animation-steps.mjs';
import {useMeasuredSearch, animationTiming} from '../animation-frames.mjs';
import {displayedAnimationFrames} from '../animation-timeline.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {described, isDecoded, fromDecoded} from './describe.mjs';
import {isPlainRecord} from './records.mjs';
import {surface, admitFrames} from './surface.mjs';
import {check, dimensions, fail, declared, callers, progressOf, admitSignal, blobBytes} from './primitives.mjs';
import {drain, encodeOptions, callOptions} from './common.mjs';
import {own, withCost, RETAIN_INPUT} from './ownership.mjs';
import {acceleration} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {encode as encodeStill} from './still.mjs';
import {DRIVE} from './drive.mjs';
import {featureless} from './first-region-option.mjs';
import {animationPhoto} from './animation-photo.mjs';
import {readGifTape, READ_GIFS} from './gif-source.mjs';
import {isBlob} from './result-identity.mjs';
import {videoHead} from './video.mjs';
export {supported} from './still.mjs';
import {prepare} from './still.mjs';

const read = input => isPlainRecord(input) && isDecoded(input) ? fromDecoded(input) : input;
const admitted = input => { try { return {input: read(input)}; } catch (error) { return {refused: Promise.reject(declared(error))}; } };
const GIF = [71, 73, 70];
async function gifFrames(blob, options, signal) {
  check(signal);
  if (blob.size < 13) return null;
  const head = await blobBytes(blob, signal, 0, 32);
  if (videoHead(blob.type, head)) throw fail('JXL_PLATFORM', "Video is read by a browser page; call encode on the page, or pass decoded frames {width, height, frames}.");
  if (!GIF.every((b, i) => head[i] === b)) return null;
  const bytes = await blobBytes(blob, signal);
  const read = await readGifTape(bytes, 'input.gif', options?.maxPixels, undefined, options?.[RETAIN_INPUT]);
  if (read.kind !== 'animation') { if (options?.readAs !== undefined) return null; withCost(read.picture.data, read.picture.data.byteLength); return {still: read.picture}; }
  if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs does not apply to an animated GIF; remove readAs.");
  return read.animation;
}
const READ = READ_GIFS;
const gifOr = (input, options, animated, still) => (async () => {
  const signal = admitSignal(options?.signal);
  let frames;
  try { encodeOptions(options); resultFacts(options, {originalBytes: input.size}); frames = await gifFrames(input, options, signal); } catch (error) { check(signal); throw declared(error); }
  return frames?.still ? still(frames.still) : frames ? animated(frames) : still(input);
})();
const animated = input => {
  const field = input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'frames') : undefined;
  if (field && !('value' in field)) throw fail('JXL_INPUT', "Queue records contain accessors; pass plain data values.");
  return Array.isArray(field ? field.value : input?.frames);
};
const encodeBytes = (input, options) => {
  if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), picture => encodeStill[RAW_OPERATION](picture, options));
  const {input: picture, refused} = READ.has(input) ? {input} : admitted(input); if (refused) return refused; input = picture;
  let frames;
  try { frames = READ.has(input) || animated(input); } catch (error) { return Promise.reject(error?.code ? error : callers(error)); }
  return frames ? animate(input, options).catch(error => { throw declared(error); })
    : encodeStill[RAW_OPERATION](input, options);
};
encodeBytes[DRIVE] = (input, options, helpers) => { if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), picture => encodeStill[RAW_OPERATION][DRIVE](picture, options, helpers)); const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture; let frames; try { frames = animated(input); } catch (error) { return Promise.reject(error?.code ? error : callers(error)); } return frames ? encodeBytes(input, options) : encodeStill[RAW_OPERATION][DRIVE](input, options, helpers); };

const encode = resultOperation(encodeBytes, {preview: previewCall, device: true});
export {configureDecoder} from '../shown-picture.mjs';
async function animate(input, options = {}) {
  options = featureless(options);
  const {codec: {target, ...settings}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  check(options.signal);
  if (target !== undefined || options.features !== undefined) throw fail('JXL_OPTIONS', "Animation options are incompatible; use fidelity 'exact' or {quality} and remove features.");
  if (input.orientation !== undefined || input.extraChannels !== undefined) throw fail('JXL_INPUT', "An animation cannot carry orientation or extra channels; remove those fields.");
  const read = READ.has(input) ? input : surface(input, {maxPixels, readAs: options.readAs});
  dimensions(read.width, read.height, maxPixels);
  if (!READ.has(input)) admitFrames(read);
  const animation = READ.has(input) ? input : own(read, maxPixels, Number.MAX_SAFE_INTEGER);
  const codec = {...described(animation), ...settings};
  resultReference(options, animation);
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels,
    ...(options[PREVIEW] && {preview: options[PREVIEW]})};
  await acceleration(webgpu, 0, 0, codec.quality < 100 ? codec.effort : 0, 'an animation');
  check(hooks.signal);
  if (codec.quality < 100 && codec.effort >= 8) useMeasuredSearch(searchV6);
  const answer = await animationPhoto(animation, codec,
    (coding, onProgress) => drain(encodeAnimationJob(animation, coding, true), {...hooks, onProgress}), hooks);
  resultFacts(options, {kept: answer.exact ? 'pixels' : 'lossy', measurements: answer.measurements,
    timing: animationTiming(displayedAnimationFrames(animation).map(frame => frame.duration))});
  return answer.bytes;
}

import * as self from './animation.mjs';
import {serveRole, ownFile, roleName} from './module-roles.mjs';
import {moduleRuntime} from './module-runtime.mjs';
import {install, workerPort} from './worker-runtime.mjs';
import {previewHub} from './preview-relay.mjs';
import * as pool from '../helper-pool.mjs';
import {serveHelper} from '../helper-runtime.mjs';
import {WORKER_PROTOCOL} from './protocol.mjs';
import {serveBlockSplit} from '../block-split.mjs';
import {serveParallel} from '../parallel-serve.mjs';
const NAME = 'rapier-jxl/animation';
serveRole(NAME, {
  worker: () => install(workerPort(), [], moduleRuntime(self, {name: NAME, gpu: requireWebGPU, helpers: async () => pool, helper: ownFile(roleName(NAME, 'helper'))}), previewHub),
  helper: () => {
    const runtime = moduleRuntime(self, {name: NAME, gpu: requireWebGPU});
    serveHelper(() => ({name: NAME, protocol: WORKER_PROTOCOL, run: (...call) => runtime.run(...call), serveSplit: serveBlockSplit, serveParallel}));
  }});

import {inPlace} from './module-roles.mjs';
const here = inPlace('rapier-jxl/animation', {encode, prepare}, {gpu: requireWebGPU, pool, url: () => new URL(import.meta.url), prepareOp: 'encode'});
const encodeIn = here.wrap('encode'), prepareIn = here.wrap('prepare');
export {encodeIn as encode, prepareIn as prepare};
export const {configure, close} = here;
