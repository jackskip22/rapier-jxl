import {resultOperationWith} from './result-operation.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {unmeasuredResult} from './result-record.mjs';
import {runCapture, prepareCapture} from './run-capture.mjs';
import {captureDomain} from '../capture-domain.mjs';
import {admitCapture} from './capture-options.mjs';
import {CAPTURE_LEAN, carriedBy} from './capture-levels.mjs';
import {check, fail, declared, callers, pixelLimit, dimensions, admitSignal, PIXELS, progressOf, plainCopy, blobBytes} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {surface} from './surface.mjs';
import {isPlainRecord} from './records.mjs';
import {isRowSource, admitRows} from './rows.mjs';
import {JOURNAL} from '../step-journal.mjs';
import {pngChunks} from './input-native.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {captureExact, markCaptureExact} from '../capture-codec.mjs';
import {CAPTURE_RECORD} from './capture-facts.mjs';
export {prepareCapture};
const LEAN = carriedBy('rapier-jxl/capture', CAPTURE_LEAN);
const exactDriver = {admit: options => ({maxError: admitCapture(options, LEAN)}), run: runCapture};
export const captureWith = (readTexture, driver = exactDriver, record = unmeasuredResult, device = false) => resultOperationWith(record, (input, options) => {
  const call = {};
  return captureHere(input, options, readTexture, driver, call).catch(error => { throw call.signal && error === call.signal.reason ? error : declared(error); });
}, {fidelity: 'exact', capture: true, preview: previewCall, device});
const RECT = ['x', 'y', 'width', 'height', 'solidText', 'edge'];
async function captureHere(input, options = {}, readTexture, driver, call) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', "Invalid encoding options; pass an object.");
  const {signal, onProgress, [CAPTURE_RECORD]: onEncoded, [JOURNAL]: journal, [PREVIEW]: preview, ...rest} = options;
  call.signal = signal;
  if (rest.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', "capture does not take firstRegion; use encode or remove firstRegion.");
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', "Invalid onProgress; pass a function.");
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) for (const name of ['exactRects', 'photoRects']) if (Array.isArray(rest[name]))
    rest[name] = Array.from(rest[name], r => {
      if (!r || typeof r !== 'object') return r;
      for (const key of Object.keys(r)) if (!RECT.includes(key)) throw fail('JXL_OPTIONS', `Unknown ${name} field: ${key}; use {x, y, width, height, solidText, edge}.`);
      const {x, y, width, height, solidText, edge} = r;
      return {x, y, width, height, ...(solidText !== undefined && {solidText}), ...(edge !== undefined && {edge})};
    });
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && rest.withoutText && typeof rest.withoutText === 'object') {
    const {data, width, height, rects} = rest.withoutText;
    rest.withoutText = {data, width, height, ...(rects !== undefined && {rects: Array.isArray(rects) ? Array.from(rects, r => {
      if (!r || typeof r !== 'object') return r;
      for (const key of Object.keys(r)) if (!RECT.slice(0, 4).includes(key)) throw fail('JXL_OPTIONS', `Unknown withoutText.rects field: ${key}; use {x, y, width, height}.`);
      const {x, y, width, height} = r;
      return {x, y, width, height};
    }) : rects})};
  }
  rest.fidelity = driver.admit(rest);
  if (rest.features !== undefined) rest.features = {};
  check(signal);
  const maxPixels = pixelLimit(rest.maxPixels);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && rest.withoutText !== undefined) {
    const {data, width, height} = rest.withoutText;
    if (width > Math.floor(maxPixels / height)) throw fail('JXL_DIMENSIONS', "withoutText exceeds maxPixels; resize it or raise maxPixels.");
    rest.withoutText = {...rest.withoutText, data: data.slice()};
  }
  let normalizedRects;
  const rectangles = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && driver.rectangles && (rest.exactRects !== undefined || rest.photoRects !== undefined || rest.withoutText !== undefined)
    ? ({width, height}) => {
      if (normalizedRects?.width === width && normalizedRects?.height === height) return;
      Object.assign(rest, driver.rectangles(rest, width, height));
      normalizedRects = {width, height, normalize: driver.rectangles, exactRects: rest.exactRects, photoRects: rest.photoRects};
    } : undefined;
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) {
    if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || !readTexture) throw fail('JXL_UNSUPPORTED', "This module cannot read GPU textures; use rapier-jxl/capture-complete or rapier-jxl.");
    input = await readTexture(input, maxPixels, rectangles && (take => { rectangles(input.texture); return take(); }));
  }
  const blob = typeof Blob !== 'undefined' && input instanceof Blob;
  if (isRowSource(input) && rest.readAs !== undefined) throw fail('JXL_OPTIONS', "A row source sets its own color; remove readAs and set colorSpace on the source.");
  const owned = blob ? input : isRowSource(input) ? admitRows(input, maxPixels)
    : journal ? journalPicture(input, maxPixels, rectangles)
    : ownPixels(input, surface(input, {readAs: rest.readAs, maxPixels, admitSurface: rectangles}), maxPixels, rectangles);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !blob && !isRowSource(input) && !ArrayBuffer.isView(input?.data) && holdsContent(rest) && blankSamples(owned?.data))
    throw fail('JXL_PLATFORM', "Canvas read back blank where its rectangles hold content; draw it again.");
  if (!blob) delete rest.readAs;
  const {intent, readAs} = blob && rest.readAs === undefined ? await statedColor(input, signal) : {};
  if (readAs) rest.readAs = readAs;
  const report = progressOf(onProgress, signal);
  const record = onEncoded && (value => { try { onEncoded(value); } catch (error) { throw callers(error); } });
  const bytes = await driver.run(owned, rest, {signal: signal ?? new AbortController().signal, onProgress: report, onEncoded: record,
    ...(normalizedRects && {normalizedRects}), ...(journal && {journal}), ...(preview && {preview})});
  const stated = withRenderingIntent(bytes, intent);
  return stated !== bytes && captureExact(bytes) ? markCaptureExact(stated) : stated;
}

const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];
const elsewhere = what => fail('JXL_UNSUPPORTED', `This PNG names its color in ${what}; encode it with rapier-jxl or rapier-jxl/upload.`);
async function statedColor(blob, signal) {
  const head = await blobBytes(blob, signal, 0, 8);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => head[i] === byte)) return {};
  const chunks = await pngChunks(blob, signal);
  if (!chunks) return {};
  if (chunks.names.has('cICP')) {
    const [primaries, transfer, matrix, full] = chunks.cicp ?? [];
    if (transfer === 13 && matrix === 0 && full === 1 && primaries === 1) return {};
    if (transfer === 13 && matrix === 0 && full === 1 && primaries === 12) return {readAs: 'display-p3'};
    throw elsewhere('a cICP chunk other than sRGB or Display P3');
  }
  if (chunks.names.has('iCCP')) throw elsewhere('an ICC profile (an iCCP chunk)');
  if (chunks.names.has('sRGB')) return {intent: INTENTS[chunks.intent]};
  const named = ['gAMA', 'cHRM'].filter(name => chunks.names.has(name));
  if (named.length) throw elsewhere(`a ${named.join(' and ')} chunk`);
  return {};
}

function journalPicture({data, width, height, colorSpace}, maxPixels, rectangles) {
  dimensions(width, height, maxPixels);
  const picture = {data, width, height, ...(colorSpace && {colorSpace})};
  captureDomain(picture);
  rectangles?.(picture);
  return picture;
}

function ownPixels(input, picture, maxPixels, rectangles) {
  const data = picture?.data, caller = input?.data;
  if (!ArrayBuffer.isView(data) || data instanceof DataView || !ArrayBuffer.isView(caller) || data.buffer !== caller.buffer) return picture;
  dimensions(picture.width, picture.height, maxPixels);
  if (arrayBufferBytes(data.buffer) === null) throw fail('JXL_INPUT', "Buffer is shared; copy its bytes to an ArrayBuffer.");
  captureDomain(picture);
  rectangles?.(picture);
  try { return {...picture, data: plainCopy(picture.data)}; }
  catch { throw fail('JXL_INPUT', "ArrayBuffer is detached or too small; pass a live one."); }
}

const holdsContent = ({photoRects, exactRects}) => !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) && [photoRects, exactRects].some(rects => Array.isArray(rects) && rects.some(r => r?.width > 0 && r?.height > 0));

function blankSamples(data) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length < 4 || data.length % 4) return false;
  let clear = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { clear = false; break; }
  if (clear) return true;
  const [r, g, b, a] = data;
  for (let i = 4; i < data.length; i += 4) if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a) return false;
  return true;
}
