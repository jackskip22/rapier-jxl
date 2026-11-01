import {runCapture, prepareCapture} from './run-capture.mjs';
import {admitCapture} from './capture-options.mjs';
import {check, fail, declared, callers, pixelLimit, dimensions, admitSignal, LARGEST} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {surface} from './surface.mjs';
import {isPlainRecord} from './records.mjs';
import {isRowSource, admitRows} from './rows.mjs';
export {prepareCapture};
export const captureWith = readTexture => (input, options) => captureHere(input, options, readTexture).catch(error => { throw error === options?.signal?.reason ? error : declared(error); });
async function captureHere(input, options = {}, readTexture) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const {signal, onProgress, ...rest} = options;
  if (rest.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', 'firstRegion is offered by rapier-jxl\'s encode, not by capture, in this version.');
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  rest.fidelity = {maxError: admitCapture(rest)};
  if (rest.features !== undefined) rest.features = {};
  check(signal);
  const maxPixels = pixelLimit(rest.maxPixels, LARGEST);
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) {
    if (!readTexture) throw fail('JXL_UNSUPPORTED', 'A GPU texture is captured by rapier-jxl or rapier-jxl/capture.');
    input = await readTexture(input, maxPixels);
  }
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  if (isRowSource(input) && rest.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source names its own space (colorSpace).');
  const owned = blob ? input : isRowSource(input) ? admitRows(input, maxPixels) : ownPixels(input, surface(input, {readAs: rest.readAs, maxPixels}), maxPixels);
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
