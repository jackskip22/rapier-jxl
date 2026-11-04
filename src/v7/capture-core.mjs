import {runCapture, prepareCapture, captureDomain} from './run-capture.mjs';
import {admitCapture} from './capture-options.mjs';
import {CAPTURE_LEAN, carriedBy} from './capture-levels.mjs';
import {check, fail, declared, callers, pixelLimit, dimensions, admitSignal, LARGEST, progressOf, plainCopy} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {surface} from './surface.mjs';
import {isPlainRecord} from './records.mjs';
import {isRowSource, admitRows} from './rows.mjs';
export {prepareCapture};
const LEAN = carriedBy('rapier-jxl/capture', CAPTURE_LEAN);
const exactDriver = {admit: options => ({maxError: admitCapture(options, LEAN)}), run: runCapture};
export const captureWith = (readTexture, driver = exactDriver) => (input, options) => {
  const call = {};
  return captureHere(input, options, readTexture, driver, call).catch(error => { throw call.signal && error === call.signal.reason ? error : declared(error); });
};
async function captureHere(input, options = {}, readTexture, driver, call) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', 'JPEG XL options must be an object.');
  const {signal, onProgress, onEncoded, ...rest} = options;
  call.signal = signal;
  if (rest.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', 'firstRegion is for encode, not capture.');
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', 'onProgress must be a function.');
  if (onEncoded !== undefined && typeof onEncoded !== 'function') throw fail('JXL_OPTIONS', 'onEncoded must be a function.');
  for (const name of ['exactRects', 'photoRects']) if (Array.isArray(rest[name]) && rest[name].length <= 65536)
    rest[name] = Array.from(rest[name], r => {
      if (!r || typeof r !== 'object') return r;
      const {x, y, width, height, solidText, edge} = r;
      return {x, y, width, height, ...(solidText !== undefined && {solidText}), ...(edge !== undefined && {edge})};
    });
  rest.fidelity = driver.admit(rest);
  if (rest.features !== undefined) rest.features = {};
  check(signal);
  const maxPixels = pixelLimit(rest.maxPixels, LARGEST);
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) {
    if (!readTexture) throw fail('JXL_UNSUPPORTED', 'Capture GPU textures with rapier-jxl/capture-complete or rapier-jxl.');
    input = await readTexture(input, maxPixels);
  }
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  if (isRowSource(input) && rest.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads a canvas, bitmap or Blob; a row source sets colorSpace.');
  const owned = blob ? input : isRowSource(input) ? admitRows(input, maxPixels) : ownPixels(input, surface(input, {readAs: rest.readAs, maxPixels}), maxPixels);
  if (!blob) delete rest.readAs;
  const report = progressOf(onProgress, signal);
  const record = onEncoded && (value => { try { onEncoded(value); } catch (error) { throw callers(error); } });
  return driver.run(owned, rest, {signal: signal ?? new AbortController().signal, onProgress: report, onEncoded: record});
}

function ownPixels(input, picture, maxPixels) {
  const data = picture?.data, caller = input?.data;
  if (!ArrayBuffer.isView(data) || data instanceof DataView || !ArrayBuffer.isView(caller) || data.buffer !== caller.buffer) return picture;
  dimensions(picture.width, picture.height, maxPixels);
  if (arrayBufferBytes(data.buffer) === null) throw fail('JXL_INPUT', 'Copy shared buffers to an ArrayBuffer.');
  captureDomain(picture);
  try { return {...picture, data: plainCopy(picture.data)}; }
  catch { throw fail('JXL_INPUT', 'The ArrayBuffer is detached or too small; pass a live one.'); }
}
