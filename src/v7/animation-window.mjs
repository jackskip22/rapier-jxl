// SPDX-License-Identifier: MIT
import {ANIMATION_FORM, ANIMATION_PLAIN, additiveBytes, codedModes} from '../animation-frames.mjs';
import {windowJoin} from '../animation-join.mjs';
import {readImageHeader} from '../framing.mjs';
import {check, fail} from './primitives.mjs';
import {windowFrames, WINDOW_BYTES, SEARCH_WINDOW_FRAMES, admitWindow, memoryFault} from './frame-source.mjs';

function admitFrame(frame, width, height) {
  if (!frame || !(frame.data instanceof Uint8ClampedArray || frame.data instanceof Uint8Array) || frame.data.length !== width * height * 4)
    throw fail('JXL_INPUT', `video frame: ${width} x ${height} RGBA`);
  if (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xFFFFFFFF)
    throw fail('JXL_INPUT', 'video frame duration: milliseconds >= 0');
  return frame;
}

export async function codeWindows(source, codec, code, hooks) {
  admitWindow(source.width, source.height, codec);
  const measured = async (...args) => {
    const answer = await code(...args);
    if (answer.measurements?.some(m => m.score !== undefined && !Number.isFinite(m.score))) throw fail('JXL_INPUT', 'score: finite number');
    return answer;
  };
  try { return await codeTwice(source, codec, measured, hooks); }
  catch (error) { throw memoryFault(error, source.width, source.height, codec); }
}
async function codeTwice(source, codec, code, hooks) {
  const first = await codeOnce(source, codec, code, hooks);
  if (!first.unprovable) return first;
  await source.restart();
  const exact = await codeOnce(source, {...codec, quality: 100, qualityIntent: undefined}, code, hooks);
  return {...exact, unproved: first.unprovable};
}

function windowing({width, height}, codec) {
  const additive = codec.effort >= 8 && codec.quality < 100 ? additiveBytes(width, height) : 0;
  if (additive > WINDOW_BYTES / 2) codec = {...codec, [ANIMATION_PLAIN]: true};
  return [codec, additive];
}
function windowSize(source, codec) {
  const {width, height} = source, additive = windowing(source, codec)[1];
  return Math.min(windowFrames(width, height, codec[ANIMATION_PLAIN] ? 0 : additive),
    codec.effort >= 7 && codec.quality < 100 ? SEARCH_WINDOW_FRAMES : Infinity, source.window > 0 ? source.window : Infinity);
}
export const overWindow = (width, height, count, codec) => count > windowSize({width, height}, codec);

async function codeOnce(source, codec, code, {signal, onProgress, preview, ...hooks}) {
  const {width, height, loops = 0} = source;
  [codec] = windowing(source, codec);
  const size = windowSize(source, codec);
  const join = windowJoin(loops), durations = [];
  let windows = 0;
  let window = [], next = await source.next(), read = 0, exact = true, form, measurements = [], unproved = [], before = 0;
  if (!next) throw fail('JXL_INPUT', 'video frames: missing');
  admitFrame(next, width, height);
  const report = onProgress && ((from, to) => fraction => onProgress(Math.min(0.99, from + (to - from) * fraction)));
  for (;;) {
    check(signal);
    if (next) { window.push(next); durations.push(next.duration); }
    const at = next?.read ?? 1;
    next = next && await source.next();
    if (next) admitFrame(next, width, height);
    if (next && window.length < size) continue;
    const last = !next, animation = {width, height, loops: last ? loops : 0, frames: window};
    const progress = report?.(read, at);
    if (last && !windows) {
      const answer = await code(animation, codec, {...hooks, signal, onProgress: progress, preview});
      return {...answer, durations};
    }
    if (!form) form = {colour: 3};
    const coding = !windows ? {...codec, [ANIMATION_FORM]: form}
      : exact ? {...codec, quality: 100, qualityIntent: undefined, [ANIMATION_FORM]: form} : {...codec, [ANIMATION_FORM]: {...form, page: false}};
    const answer = await code(animation, coding, {...hooks, signal, onProgress: progress});
    check(signal);
    if (!windows) {
      exact = answer.exact;
      form = {...form, alpha: readImageHeader(answer.bytes, {}).alpha, ...(!exact && {mode: codedModes.get(answer.bytes) ?? ((codec.colorSpace ?? 'srgb') === 'srgb' ? 'xyb' : 'ycbcr')})};
    } else if (!exact && answer.exact) {
      const frames = answer.unproved?.length ? answer.unproved.map(({frame}) => before + frame) : window.map((_, k) => before + k);
      return {unprovable: frames.map(frame => ({frame, done: 'exact file'}))};
    }
    for (const {frame, done} of answer.unproved ?? []) unproved.push({frame: before + frame, done});
    before += window.length;
    join.add(answer.bytes, last); windows++;
    const score = list => list.find(m => m.metric === 'ssimulacra2')?.score ?? Infinity;
    if (!exact && answer.measurements?.length && (!measurements.length || score(answer.measurements) < score(measurements))) measurements = answer.measurements;
    window = []; read = at;
    if (last) break;
  }
  return {bytes: join.finish(), exact, measurements: exact ? [] : measurements, durations, ...(unproved.length && {unproved})};
}
