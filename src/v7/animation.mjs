import './engines.mjs';
import {resultOperation, resultReference, resultFacts, RAW_OPERATION} from './result-operation.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {encodeAnimationJob} from '../animation-steps.mjs';
import {useMeasuredSearch, animationTiming} from '../animation-frames.mjs';
import {displayedAnimationFrames} from '../animation-timeline.mjs';
import {searchV6} from '../photo-v6-search.mjs';
import {described, isDecoded, fromDecoded} from './describe.mjs';
import {isPlainRecord} from './records.mjs';
import {surface, admitFrames} from './surface.mjs';
import {check, dimensions, fail, declared, callers, progressOf, admitSignal, blobBytes, PIXELS} from './primitives.mjs';
import {drain, encodeOptions, callOptions} from './common.mjs';
import {own, withCost, RETAIN_INPUT} from './ownership.mjs';
import {withArenaLease} from '../call-scope.mjs';
import {acceleration} from './acceleration.mjs';
import {requireWebGPU} from './webgpu.mjs';
import {encode as encodeStill} from './still.mjs';
import {DRIVE} from './drive.mjs';
import {featureless} from './first-region-option.mjs';
import {animationPhoto} from './animation-photo.mjs';
import {readGifTape, READ_GIFS} from './gif-source.mjs';
import {isBlob} from './result-identity.mjs';
import {videoHead} from './video.mjs';
import {FRAME_SOURCES, isFrameBridge, bridgedFrames, readerSource} from './frame-source.mjs';
import {isFrameStream, iterableReader, gifReader, decoderReader, arrayWindowable, arrayReader} from './frame-stream.mjs';
import {codeWindows, overWindow} from './animation-window.mjs';
export {supported} from './still.mjs';
import {prepare} from './still.mjs';

const read = input => {
  let decoded;
  try { decoded = isPlainRecord(input) && isDecoded(input); } catch (error) { throw callers(error); }
  return decoded ? fromDecoded(input) : input;
};
const admitted = input => { try { return {input: read(input)}; } catch (error) { return {refused: Promise.reject(declared(error))}; } };
const GIF = [71, 73, 70];
async function gifFrames(blob, options, signal) {
  check(signal);
  if (blob.size < 13) return null;
  const head = await blobBytes(blob, signal, 0, 32);
  if (videoHead(blob.type, head)) throw fail('JXL_PLATFORM', "video: browser page or decoded frames {width, height, frames}");
  if (!GIF.every((b, i) => head[i] === b)) {
    const reader = options?.readAs === undefined && await decoderReader(blob, head, options?.maxPixels ?? PIXELS, signal);
    return reader ? readerSource(reader) : null;
  }
  const bytes = await blobBytes(blob, signal);
  const stream = options?.readAs === undefined && await gifReader(bytes, options?.maxPixels);
  if (stream) return readerSource(stream);
  const read = await readGifTape(bytes, 'input.gif', options?.maxPixels, undefined, options?.[RETAIN_INPUT]);
  if (read.kind !== 'animation') { if (options?.readAs !== undefined) return null; withCost(read.picture.data, read.picture.data.byteLength); return {still: read.picture}; }
  if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: not with GIF");
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
  let field, frames;
  try {
    field = input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'frames') : undefined;
    frames = Array.isArray(field ? field.value : input?.frames);
  } catch (error) { throw callers(error); }
  if (field && !('value' in field)) throw fail('JXL_INPUT', "queue records: plain values");
  return frames;
};
const bridged = (input, options) => { const source = bridgedFrames(input); return animate(source, options).catch(error => { throw declared(error); }).finally(() => input.framesPort.close()); };
const streamed = (input, options) => {
  let source;
  try { source = readerSource(iterableReader(input)); } catch (error) { return Promise.reject(declared(error)); }
  return animate(source, options).catch(error => { throw declared(error); }).finally(() => source.stop());
};
const encodeBytes = (input, options) => {
  if (isFrameBridge(input)) return bridged(input, options);
  let stream; try { stream = isFrameStream(input); } catch (error) { return Promise.reject(callers(error)); }
  if (stream) return streamed(input, options);
  if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), picture => encodeStill[RAW_OPERATION](picture, options));
  const {input: picture, refused} = READ.has(input) || FRAME_SOURCES.has(input) ? {input} : admitted(input); if (refused) return refused; input = picture;
  let frames;
  try { frames = READ.has(input) || FRAME_SOURCES.has(input) || animated(input); } catch (error) { return Promise.reject(error); }
  return frames ? animate(input, options).catch(error => { throw declared(error); }).finally(() => FRAME_SOURCES.has(input) && input.stop?.())
    : encodeStill[RAW_OPERATION](input, options);
};
encodeBytes[DRIVE] = (input, options, helpers) => { if (isFrameBridge(input)) return bridged(input, options); let stream; try { stream = isFrameStream(input); } catch (error) { return Promise.reject(callers(error)); } if (stream) return streamed(input, options); if (isBlob(input)) return gifOr(input, options, frames => encodeBytes(frames, options), picture => encodeStill[RAW_OPERATION][DRIVE](picture, options, helpers)); const {input: picture, refused} = admitted(input); if (refused) return refused; input = picture; let frames; try { frames = animated(input); } catch (error) { return Promise.reject(error); } return frames ? encodeBytes(input, options) : encodeStill[RAW_OPERATION][DRIVE](input, options, helpers); };

const encode = resultOperation(encodeBytes, {preview: previewCall, device: true});
export {configureDecoder} from '../shown-picture.mjs';
async function animate(input, options = {}) {
  options = featureless(options);
  const {codec: {target, ...settings}, hooks: {webgpu, maxPixels}} = callOptions(encodeOptions(options));
  check(options.signal);
  if (target !== undefined || options.features !== undefined) throw fail('JXL_OPTIONS', "animation: fidelity 'exact' or {quality}, no features");
  if (options.progressive !== undefined) throw fail('JXL_OPTIONS', 'unknown option: progressive');
  if (input.orientation !== undefined || input.extraChannels !== undefined) throw fail('JXL_INPUT', "animation: no orientation or extraChannels");
  const source = FRAME_SOURCES.has(input) ? input : null;
  if (source && options.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs does not apply to video; remove readAs.');
  if (source && source.loops !== undefined && (!Number.isInteger(source.loops) || source.loops < 0 || source.loops > 0xffffffff))
    throw fail('JXL_INPUT', 'loops: integer 0-4294967295');
  const read = READ.has(input) || source ? input : surface(input, {maxPixels, readAs: options.readAs});
  dimensions(read.width, read.height, maxPixels);
  if (!READ.has(input) && !source) admitFrames(read);
  const animation = READ.has(input) || source ? input : own(read, maxPixels, Number.MAX_SAFE_INTEGER);
  const codec = {...described(source ? source.description ?? {} : animation), ...settings};
  resultReference(options, source ? {width: source.width, height: source.height} : animation);
  const windowed = !source && !READ.has(input) && overWindow(read.width, read.height, animation.frames.length, codec) && arrayWindowable(animation, read.width, read.height)
    ? readerSource(arrayReader(animation)) : null;
  const report = options.onProgress, onProgress = progressOf(report, options.signal);
  const hooks = {signal: options.signal ?? new AbortController().signal, onProgress, maxPixels,
    ...(options[PREVIEW] && {preview: options[PREVIEW]})};
  source?.bind?.(hooks.signal);
  return withArenaLease(options.signal, async () => {
    await acceleration(webgpu, 0, 0, codec.quality < 100 ? codec.effort : 0, 'an animation');
    check(hooks.signal);
    if (codec.quality < 100 && codec.effort >= 8) useMeasuredSearch(searchV6);
    const code = (clip, coding, own) => animationPhoto(clip, coding,
      (settings, onProgress) => drain(encodeAnimationJob(clip, settings, true), {...own, onProgress}), own);
    const answer = source || windowed ? await codeWindows(source ?? windowed, codec, code, hooks) : await code(animation, codec, hooks);
    resultFacts(options, {kept: answer.exact ? 'pixels' : 'lossy', measurements: answer.measurements, ...(answer.unproved?.length && {unproved: answer.unproved}),
      timing: animationTiming(source || windowed ? displayedAnimationFrames({frames: answer.durations.map(duration => ({duration})), loops: (source ?? windowed).loops}).map(frame => frame.duration)
        : displayedAnimationFrames(animation).map(frame => frame.duration))});
    return answer.bytes;
  });
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
