import './engines.mjs';
import {check, declared, callers, fail, snapshotOptions, admitSignal} from './primitives.mjs';
import {header as readHeader} from './inspect.mjs';
import {headerFields} from './header-fields.mjs';
import {streamContainer} from '../container-stream.mjs';
import {viewBytes, arrayBufferBytes} from './bytes.mjs';
import {placeholder as rawPlaceholder, slice as rawSlice} from '../progressive-slice.mjs';

const BOUNDS = ['maxPixels', 'maxDimension', 'maxInputBytes', 'maxBoxes'];
function bounds(options) {
  const settings = snapshotOptions(options);
  for (const key of Object.keys(settings)) if (!BOUNDS.includes(key)) throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  return settings;
}

export function header(input, options) {
  try {
    const settings = bounds(options), bytes = viewBytes(input);
    return headerFields(readHeader(bytes, settings));
  } catch (error) { throw declared(error); }
}

export {inspect, edit} from './inspect-edit.mjs';
export {sourceMetadata} from './source-metadata.mjs';
export function placeholder(input, options) {
  try { return rawPlaceholder(input, options); } catch (error) { throw declared(error); }
}
export function slice(input, options) {
  try { return rawSlice(input, options); } catch (error) { throw declared(error); }
}

function watched(source) {
  if (ArrayBuffer.isView(source) || arrayBufferBytes(source) !== null)
    throw fail('JXL_INPUT', 'stream: iterable Uint8Array chunks');
  let method;
  try { method = source && (source[Symbol.asyncIterator] ?? source[Symbol.iterator]); }
  catch (error) { throw callers(error); }
  const invalid = () => fail('JXL_INPUT', "chunk iterator: {done, value: Uint8Array}");
  const record = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  if (typeof method !== 'function') throw invalid();
  return (async function* () {
    let iterator, next, close = false;
    try { iterator = method.call(source); } catch (error) { throw callers(error); }
    if (!record(iterator)) throw invalid();
    try { next = iterator.next; } catch (error) { throw callers(error); }
    if (typeof next !== 'function') throw invalid();
    try {
      for (;;) {
        close = false;
        let step, done, value;
        try { step = await next.call(iterator); } catch (error) { throw callers(error); }
        if (!record(step)) throw invalid();
        try { done = step.done; if (!done) value = await step.value; } catch (error) { throw callers(error); }
        if (done) return;
        close = true;
        yield viewBytes(value, true);
      }
    } finally {
      if (close) {
        let stop, result;
        try { stop = iterator.return; } catch (error) { throw callers(error); }
        if (stop != null) {
          if (typeof stop !== 'function') throw invalid();
          try { result = await stop.call(iterator); } catch (error) { throw callers(error); }
          if (!record(result)) throw invalid();
        }
      }
    }
  })();
}
const STREAM = ['chunkSize', 'maxBytes', 'maxBoxes', 'signal', 'level'];
function streamOptions(options) {
  const settings = snapshotOptions(options);
  for (const key of Object.keys(settings)) if (!STREAM.includes(key)) throw fail('JXL_OPTIONS', `unknown option: ${key}`);
  for (const key of ['chunkSize', 'maxBytes', 'maxBoxes'])
    if (settings[key] !== undefined && !(Number.isSafeInteger(settings[key]) && settings[key] > 0)) throw fail('JXL_OPTIONS', `${key}: positive safe integer`);
  if (settings.level !== undefined && settings.level !== 5 && settings.level !== 10) throw fail('JXL_OPTIONS', "level: 5 or 10");
  admitSignal(settings.signal);
  return settings;
}
export function stream(source, options = {}) {
  let settings, refused = false, refusal;
  try { settings = streamOptions(options); } catch (error) { refused = true; refusal = error; }
  return (async function* () {
    try {
      if (refused) throw refusal;
      check(settings.signal); yield* streamContainer(watched(source), settings);
    } catch (error) { throw declared(error); }
  })();
}
