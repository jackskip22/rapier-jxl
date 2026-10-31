import {check, declared, callers, fail, object, admitSignal} from './primitives.mjs';
import {header as readHeader} from './inspect.mjs';
import {headerFields} from './header-fields.mjs';
import {streamContainer} from '../container-stream.mjs';
import {viewBytes} from './bytes.mjs';

const BOUNDS = ['maxPixels', 'maxDimension', 'maxInputBytes', 'maxBoxes'];
function bounds(options) {
  let settings;
  try { settings = {...object(options)}; } catch (error) { throw callers(error); }
  for (const key of Object.keys(settings)) if (!BOUNDS.includes(key)) throw fail('JXL_OPTIONS', `Unknown header option: ${key}.`);
  return settings;
}

export function header(input, options) {
  try {
    const settings = bounds(options);
    return headerFields(readHeader(viewBytes(input), settings));
  } catch (error) { throw declared(error); }
}

export {inspect, edit} from './inspect-edit.mjs';

function watched(source) {
  let iterable;
  try { iterable = !!source && (typeof source[Symbol.asyncIterator] === 'function' || typeof source[Symbol.iterator] === 'function'); }
  catch (error) { throw callers(error); }
  if (!iterable) return source;
  return (async function* () { try { yield* source; } catch (error) { throw callers(error); } })();
}
const STREAM = ['chunkSize', 'maxBytes', 'maxBoxes', 'signal', 'level'];
function streamOptions(options) {
  let settings;
  try { settings = {...object(options)}; } catch (error) { throw callers(error); }
  for (const key of Object.keys(settings)) if (!STREAM.includes(key)) throw fail('JXL_OPTIONS', `Unknown stream option: ${key}.`);
  for (const key of ['chunkSize', 'maxBytes', 'maxBoxes'])
    if (settings[key] !== undefined && !(Number.isSafeInteger(settings[key]) && settings[key] > 0)) throw fail('JXL_OPTIONS', `${key} is a positive safe integer.`);
  if (settings.level !== undefined && settings.level !== 5 && settings.level !== 10) throw fail('JXL_OPTIONS', 'level is 5 or 10.');
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
    } catch (error) { throw error === settings?.signal?.reason ? error : declared(error); }
  })();
}
