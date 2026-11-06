import {author, admitFormat} from './author.mjs';
import {object, fail, declared, pixelLimit, progressOf} from './primitives.mjs';
import {own} from './ownership.mjs';
import {acceleration} from './acceleration.mjs';
import {prepare as prepareStill} from './with-capture.mjs';
import {imageResult} from './result.mjs';
import {readImageHeader, codestreamOf} from '../framing.mjs';
export {encode, supported, configureWasm} from './still.mjs';
export {capture, configureDecoder} from './with-capture.mjs';
export const prepare = (operation = 'format') => operation === 'format' ? acceleration(false, 0, 0).then(() => {}, error => { throw declared(error); }) : prepareStill(operation);

export const format = (input, options) => formatHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function formatHere(input, options = {}) {
  object(options);
  const {signal, onProgress, maxPixels: limit, ...rest} = options, maxPixels = pixelLimit(limit);
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) throw fail('JXL_OPTIONS', 'signal must be an AbortSignal.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  admitFormat(input, rest);
  const request = own(input, maxPixels), owned = own(rest, maxPixels);
  const report = progressOf(onProgress, signal);
  await acceleration(false, 0, 0);
  const hooks = {signal: signal ?? new AbortController().signal, onProgress: report, maxPixels};
  const bytes = await author(request, owned, hooks);
  return imageResult(bytes, formatSize(request), {...formatFidelity(request.kind, owned), signal: hooks.signal, owned: true});
}

function formatSize(request) {
  if (request.kind !== 'patch-composition') {
    const image = request.image ?? request;
    return {width: image.width, height: image.height, ...(image.orientation !== undefined && {orientation: image.orientation})};
  }
  const base = request.image.base;
  return base.image ?? readImageHeader(codestreamOf(base.bytes).codestream);
}
const LOSSY_KINDS = new Set(['photo', 'splines', 'hybrid']);
function formatFidelity(kind, options) {
  const asked = options.fidelity;
  if (asked !== undefined) return {fidelity: asked === 'exact' || asked.quality === 100 ? 'exact' : {quality: asked.quality}};
  if (LOSSY_KINDS.has(kind)) return {fidelity: {quality: 90}};
  const preset = options.preset ?? 'exact';
  const bound = kind === 'graphics' ? options.maxColorError ?? (preset === 'screen' ? 2 : preset === 'dither' ? 8 : 0)
    : kind === 'patches' ? options.baseError ?? 0 : 0;
  return bound > 0 || kind === 'graphics' && (options.undither ?? preset === 'dither')
    ? {fidelity: {maxError: bound}, kept: 'lossy'} : {fidelity: 'exact'};
}

export {resultJSON} from './result.mjs';
