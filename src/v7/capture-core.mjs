import {resultOperationWith} from './result-operation.mjs';
import {PREVIEW, previewCall} from './preview.mjs';
import {unmeasuredResult} from './result-record.mjs';
import {runCapture, prepareCapture} from './run-capture.mjs';
import {captureDomain} from '../capture-domain.mjs';
import {admitCapture} from './capture-options.mjs';
import {CAPTURE_LEAN, carriedBy} from './capture-levels.mjs';
import {check, fail, callers, pixelLimit, dimensions, admitSignal, PIXELS, progressOf, plainCopy, blobBytes, isBlob, abortable, snapshotOptions, snapshotArray, filePassed, unreadInput} from './primitives.mjs';
import {arrayBufferBytes} from './bytes.mjs';
import {surface} from './surface.mjs';
import {isPlainRecord} from './records.mjs';
import {isRowSource, admitRows} from './rows.mjs';
import {JOURNAL} from '../step-journal.mjs';
import {pngChunks, pngHeader} from './input-native.mjs';
import {withRenderingIntent} from './header-intent.mjs';
import {captureExact, markCaptureExact} from '../capture-codec.mjs';
import {CAPTURE_RECORD} from './capture-facts.mjs';
import {withArenaLease} from '../call-scope.mjs';
export {prepareCapture};
const LEAN = carriedBy('rapier-jxl/capture', CAPTURE_LEAN);
const exactDriver = {admit: options => ({maxError: admitCapture(options, LEAN)}), run: runCapture};
export const captureWith = (readTexture, driver = exactDriver, record = unmeasuredResult, device = false) => resultOperationWith(record, (input, options) => {
  return captureHere(input, options, readTexture, driver);
}, {fidelity: 'exact', capture: true, preview: previewCall, device});
const RECT = ['x', 'y', 'width', 'height', 'solidText', 'edge'];
async function captureHere(input, options = {}, readTexture, driver) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('JXL_OPTIONS', "options: object");
  const {signal, onProgress, [CAPTURE_RECORD]: onEncoded, [JOURNAL]: journal, [PREVIEW]: preview, ...rest} = options;
  if (rest.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', "firstRegion: use encode");
  admitSignal(signal);
  if (onProgress !== undefined && typeof onProgress !== 'function') throw fail('JXL_OPTIONS', "onProgress: function");
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true)) for (const name of ['exactRects', 'photoRects']) if (Array.isArray(rest[name]))
    rest[name] = snapshotArray(rest[name], name).map(r => {
      if (!isPlainRecord(r)) return r;
      const item = snapshotOptions(r, name, [], true);
      for (const key of Object.keys(item)) if (!RECT.includes(key)) throw fail('JXL_OPTIONS', `${name}.${key}: {x, y, width, height, solidText, edge}`);
      const {x, y, width, height, solidText, edge} = item;
      return {x, y, width, height, ...(solidText !== undefined && {solidText}), ...(edge !== undefined && {edge})};
    });
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && rest.withoutText && typeof rest.withoutText === 'object') {
    for (const key of Object.keys(rest.withoutText)) if (!['data', 'width', 'height', 'rects'].includes(key))
      throw fail('JXL_OPTIONS', "withoutText: unknown key; use {data, width, height, rects}");
    const {data, width, height, rects} = rest.withoutText;
    rest.withoutText = {data, width, height, ...(rects !== undefined && {rects: Array.isArray(rects) ? Array.from(rects, r => {
      if (!r || typeof r !== 'object') return r;
      for (const key of Object.keys(r)) if (!RECT.slice(0, 4).includes(key)) throw fail('JXL_OPTIONS', `withoutText.rects.${key}: {x, y, width, height}`);
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
    if (width > Math.floor(maxPixels / height)) throw fail('JXL_DIMENSIONS', "withoutText: over maxPixels");
    if (arrayBufferBytes(data.buffer) === null)
      throw fail('JXL_INPUT', data.buffer?.detached ? "ArrayBuffer: live and sized" : "shared buffer: copy to ArrayBuffer");
    try { rest.withoutText = {...rest.withoutText, data: plainCopy(data)}; }
    catch { throw fail('JXL_INPUT', "ArrayBuffer: live and sized"); }
  }
  let normalizedRects;
  const rectangles = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && driver.rectangles && (rest.exactRects !== undefined || rest.photoRects !== undefined || rest.withoutText !== undefined)
    ? ({width, height}) => {
      if (normalizedRects?.width === width && normalizedRects?.height === height) return;
      Object.assign(rest, driver.rectangles(rest, width, height));
      normalizedRects = {width, height, normalize: driver.rectangles, exactRects: rest.exactRects, photoRects: rest.photoRects};
    } : undefined;
  if (isPlainRecord(input) && input.texture !== undefined && input.device !== undefined) {
    if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || !readTexture) throw fail('JXL_UNSUPPORTED', "texture: use jpegxl/capture-complete or jpegxl");
    input = await abortable(readTexture(input, maxPixels, rectangles && (take => { rectangles(input.texture); return take(); })), signal);
  }
  const blob = isBlob(input);
  if (isRowSource(input) && rest.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: row source uses colorSpace");
  const owned = blob ? input : isRowSource(input) ? admitRows(input, maxPixels)
    : journal ? journalPicture(input, maxPixels, rectangles)
    : ownPixels(input, surface(input, {readAs: rest.readAs, maxPixels, admitSurface: rectangles}), maxPixels, rectangles);
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) && !blob && !isRowSource(input) && !ArrayBuffer.isView(input?.data) && holdsContent(rest) && blankSamples(owned?.data))
    throw fail('JXL_PLATFORM', "canvas blank: redraw");
  if (!blob) delete rest.readAs;
  const {intent, readAs} = blob && rest.readAs === undefined ? await statedColor(input, signal, maxPixels) : {};
  if (readAs) rest.readAs = readAs;
  const report = progressOf(onProgress, signal);
  const record = onEncoded && (value => { try { onEncoded(value); } catch (error) { throw callers(error); } });
  const bytes = await withArenaLease(signal, outsideArena => driver.run(owned, rest, {signal: signal ?? new AbortController().signal, onProgress: report, onEncoded: record, outsideArena,
    ...(normalizedRects && {normalizedRects}), ...(journal && {journal}), ...(preview && {preview})}));
  const stated = withRenderingIntent(bytes, intent);
  return stated !== bytes && captureExact(bytes) ? markCaptureExact(stated) : stated;
}

const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];
const elsewhere = what => fail('JXL_UNSUPPORTED', `PNG ${what}: use jpegxl/upload or jpegxl`);
async function statedColor(blob, signal, maxPixels) {
  const head = await blobBytes(blob, signal, 0, 32);
  if (!pngHeader(head, maxPixels)) return {};
  const chunks = await pngChunks(blob, signal, Infinity);
  if (chunks.names.has('cICP')) {
    if (!chunks.cicp) throw fail('JXL_INPUT', 'PNG cICP: 4 bytes required');
    const [primaries, transfer, matrix, full] = chunks.cicp;
    if (transfer === 13 && matrix === 0 && full === 1 && primaries === 1) return {};
    if (transfer === 13 && matrix === 0 && full === 1 && primaries === 12) return {readAs: 'display-p3'};
    throw elsewhere('cICP not sRGB or Display P3');
  }
  if (chunks.names.has('iCCP')) throw elsewhere('iCCP chunk');
  if (chunks.names.has('sRGB')) {
    const intent = typeof chunks.intent === 'number' && Object.hasOwn(INTENTS, chunks.intent) ? INTENTS[chunks.intent] : undefined;
    if (!intent) throw fail('JXL_INPUT', 'PNG sRGB intent: 0-3');
    return {intent};
  }
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
  if (picture === input) throw fail('JXL_INPUT', filePassed(input) ?? unreadInput(input));
  const data = picture?.data, caller = input?.data;
  if (!ArrayBuffer.isView(data) || data instanceof DataView || !ArrayBuffer.isView(caller) || data.buffer !== caller.buffer) return picture;
  dimensions(picture.width, picture.height, maxPixels);
  if (arrayBufferBytes(data.buffer) === null) throw fail('JXL_INPUT', "shared buffer: copy to ArrayBuffer");
  captureDomain(picture);
  rectangles?.(picture);
  try { return {...picture, data: plainCopy(picture.data)}; }
  catch { throw fail('JXL_INPUT', "ArrayBuffer: live and sized"); }
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
