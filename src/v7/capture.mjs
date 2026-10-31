import {runCapture, prepareCapture} from './run-capture.mjs';
import {admitCapture} from './capture-options.mjs';
import {check, fail, declared, callers, pixelLimit, dimensions, admitSignal} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {surface} from './surface.mjs';
import {captureSupported} from './capture-support.mjs';
export {configureWasm} from '../wasm-modules.mjs';
export const supported = feature => captureSupported(feature);

export const prepare = () => prepareCapture().catch(error => { throw declared(error); });

export const capture = (input, options) => captureHere(input, options).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function captureHere(input, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const {signal, onProgress, ...rest} = options;
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  admitCapture(rest);
  check(signal);
  const maxPixels = pixelLimit(rest.maxPixels);
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  const owned = blob ? input : ownPixels(input, surface(input, {readAs: rest.readAs, maxPixels}), maxPixels);
  if (!blob) delete rest.readAs;
  const report = onProgress && (fraction => { try { onProgress(fraction); } catch (error) { throw callers(error); } });
  return runCapture(owned, rest, {signal: signal ?? new AbortController().signal, onProgress: report});
}

function ownPixels(input, picture, maxPixels) {
  const data = picture?.data;
  if (!ArrayBuffer.isView(data) || data instanceof DataView || data !== input?.data) return picture;
  dimensions(picture.width, picture.height, maxPixels);
  if (arrayBufferBytes(data.buffer) === null) throw fail('JXL_INPUT', 'Shared buffers are not inputs; copy the pixels to an ArrayBuffer.');
  try { return {...picture, data: picture.data.slice()}; }
  catch { throw fail('JXL_INPUT', 'The array buffer is detached or smaller than its view; pass a live ArrayBuffer.'); }
}
