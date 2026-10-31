import {author, admitFormat} from './author.mjs';
import {object, fail, declared, callers, pixelLimit} from './primitives.mjs';
import {own} from './ownership.mjs';
import {acceleration} from './acceleration.mjs';
import {prepare as prepareStill} from './still.mjs';
export {encode, capture, supported, configureWasm} from './still.mjs';
export const prepare = (operation = 'format') => operation === 'format' ? acceleration(false, 0, 0).then(() => {}, error => { throw declared(error); }) : prepareStill(operation);

export const format = (input, options) => formatHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function formatHere(input, options = {}) {
  object(options);
  const {signal, onProgress, maxPixels: limit, ...rest} = options, maxPixels = pixelLimit(limit);
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw fail('JXL_OPTIONS', 'signal must be an AbortSignal.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  admitFormat(input, rest);
  const request = own(input, maxPixels), owned = own(rest, maxPixels);
  const report = onProgress && (fraction => { try { onProgress(fraction); } catch (error) { throw callers(error); } });
  await acceleration(false, 0, 0);
  return author(request, owned, {signal: signal ?? new AbortController().signal, onProgress: report, maxPixels});
}
