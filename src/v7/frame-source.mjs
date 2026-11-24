// SPDX-License-Identifier: MIT
import {isPlainRecord} from './records.mjs';
import {fail, callers, abortable} from './primitives.mjs';

const DECLARED_CODE = /^JXL_(?:CLOSED|DECODE|DIMENSIONS|INPUT|INTERNAL|IO|JPEG|LIMIT|MEMORY|OPTIONS|PLATFORM|RECONSTRUCTION|SETUP|TARGET|UNSUPPORTED|WASM|WEBGPU|WORKER)$/;
const failure = error => {
  let code = 'JXL_INPUT', message = 'video read failed';
  try { if (typeof error?.code === 'string' && DECLARED_CODE.test(error.code)) code = error.code; } catch {}
  try { const value = error?.message ?? error; if (value === null || typeof value !== 'object' && typeof value !== 'function') message = String(value); } catch {}
  return {code, message};
};

export function frameBridge({width, height, loops = 0, window, description, next, stop, reopen}) {
  const {port1, port2} = new MessageChannel();
  let closed = false, reject;
  const refused = new Promise((_, no) => { reject = no; });
  refused.catch(() => {});
  const close = () => { if (closed) return; closed = true; port1.close(); stop?.(); };
  port1.onmessage = async ({data: ask}) => {
    if (closed) return;
    try {
      if (ask?.restart) {
        await stop?.();
        ({next, stop} = await reopen());
        if (!closed) port1.postMessage({restarted: true});
        return;
      }
      const frame = await next();
      if (closed) return;
      if (!frame) port1.postMessage({done: true});
      else port1.postMessage({data: frame.data, duration: frame.duration, read: frame.read}, [frame.data.buffer]);
    } catch (error) {
      if (closed) return;
      reject(error);
      port1.postMessage({error: failure(error)});
    }
  };
  return {record: {width, height, loops, ...(window && {window}), ...(description && Object.keys(description).length && {description}), framesPort: port2}, close, refused,
    wait: job => Promise.race([Promise.resolve(job).finally(close), refused])};
}

export const FRAME_BUDGET = 2 ** 28;
export const WINDOW_BYTES = 2 ** 30;
export const SEARCH_WINDOW_FRAMES = 31;
export function windowFrames(width, height, reserve = 0) {
  const frame = width * height * 4, frames = Math.min(Math.floor((WINDOW_BYTES - reserve) / frame), Math.floor(FRAME_BUDGET / frame)) - 1;
  if (frames < 1) throw fail('JXL_MEMORY', `video: two ${width} x ${height} frames do not fit one window; use a smaller frame size.`);
  return frames;
}

export const windowNeed = (width, height, codec = {}) =>
  FRAME_BUDGET + 2 ** 28 + (codec.effort >= 6 && codec.quality < 100 ? 320 : 200) * width * height;
function hostMemory() {
  let gigabytes;
  try { gigabytes = globalThis.navigator?.deviceMemory; } catch {}
  if (gigabytes > 0) return gigabytes * 2 ** 29;
  const constrained = globalThis.process?.constrainedMemory?.();
  if (constrained > 0 && constrained < Number.MAX_SAFE_INTEGER) return constrained;
  const os = globalThis.process?.getBuiltinModule?.('node:os');
  return os ? os.totalmem() : Infinity;
}
const mib = bytes => Math.ceil(bytes / 2 ** 20).toLocaleString('en-US');
const short = (width, height, need, have) => fail('JXL_MEMORY',
  `video: a ${width} x ${height} clip needs about ${mib(need)} MiB to code${Number.isFinite(have) ? `; this device gives ${mib(have)} MiB` : ''}. Use a smaller frame size.`);
export function admitWindow(width, height, codec) {
  windowFrames(width, height);
  const need = windowNeed(width, height, codec), have = hostMemory();
  if (need > have) throw short(width, height, need, have);
}
export const memoryFault = (error, width, height, codec) =>
  error instanceof RangeError && /allocat|memory|Array buffer/i.test(error.message) ? short(width, height, windowNeed(width, height, codec)) : error;

export const FRAME_SOURCES = new WeakSet();
export const isFrameBridge = input => {
  try { return isPlainRecord(input) && typeof MessagePort === 'function' && input.framesPort instanceof MessagePort; }
  catch (error) { throw callers(error); }
};
export function bridgedFrames({framesPort, width, height, loops, window, description}) {
  let signal;
  const ask = (message, answer) => abortable(new Promise((resolve, reject) => {
    framesPort.onmessage = ({data}) => {
      if (!data || typeof data !== 'object') { reject(fail('JXL_INPUT', 'frame bridge: message object')); return; }
      if (data.error) {
        const code = typeof data.error?.code === 'string' && DECLARED_CODE.test(data.error.code) ? data.error.code : 'JXL_INPUT';
        reject(fail(code, typeof data.error?.message === 'string' ? data.error.message : 'video read failed'));
        return;
      }
      try { resolve(answer(data)); } catch (error) { reject(error); }
    };
    framesPort.postMessage(message);
  }).finally(() => { framesPort.onmessage = null; }), signal);
  const source = {width, height, loops, window, description,
    bind(s) { signal = s; },
    next: () => ask(0, data => data.done ? null : {data: data.data, duration: data.duration, read: data.read}),
    restart: () => ask({restart: true}, () => undefined)};
  FRAME_SOURCES.add(source);
  return source;
}

export function readerSource(reader) {
  const source = {width: reader.width, height: reader.height, loops: reader.loops, window: undefined, description: reader.description,
    next: async () => { const frame = await reader.next(); return frame && {data: frame.data, duration: frame.duration, read: frame.read}; },
    restart: () => reader.reopen(), stop: () => reader.stop()};
  FRAME_SOURCES.add(source);
  return source;
}
