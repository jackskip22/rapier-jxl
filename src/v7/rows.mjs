import {fail, check, dimensions, callers, plainCopy, snapshotOptions, abortable} from './primitives.mjs';
import {isPlainRecord} from './records.mjs';
import {DESCRIPTION, described} from './describe.mjs';
import {surface} from './surface.mjs';

const FIELDS = new Set(['width', 'height', 'rows', ...DESCRIPTION]);
export function untilAborted(promise, signal) {
  return abortable(promise, signal, discardFrame);
}
const discardFrame = value => { if (typeof VideoFrame === 'function' && value instanceof VideoFrame) value.close(); };
export const isRowSource = input => isPlainRecord(input) && typeof input.rows === 'function' && input.data === undefined;
export const isRowBridge = input => isPlainRecord(input) && typeof MessagePort === 'function' && input.rowsPort instanceof MessagePort;

export function admitRows(source, maxPixels) {
  for (const key of Object.keys(source)) if (!FIELDS.has(key))
    throw fail('JXL_INPUT', `Unknown row source field ${key}; remove it.`);
  dimensions(source.width, source.height, maxPixels);
  const description = described(source);
  if (description.orientation !== undefined || description.extraChannels !== undefined)
    throw fail('JXL_UNSUPPORTED', 'A row source takes no orientation or extra channels: give the picture as pixels, a canvas or a Blob.');
  return {width: source.width, height: source.height, rows: source.rows, description};
}

export async function readBand({width, rows, description}, y, count, signal) {
  let band;
  try { band = await untilAborted(rows(y, count), signal); } catch (error) { throw callers(error); }
  check(signal);
  if (isPlainRecord(band)) {
    band = snapshotOptions(band, 'The row band', ['data']);
    if (Object.keys(band).some(key => key !== 'data')) throw fail('JXL_INPUT', "Invalid band description; pass {data} and set size and color on the row source.");
    const {data} = band;
    if (!ArrayBuffer.isView(data) || data instanceof DataView || data.length !== width * count * 4)
      throw fail('JXL_INPUT', `Wrong band sample count; pass ${width} x ${count} x 4 samples.`);
    const pixels = surface({...description, data, width, height: count});
    try { pixels.data = plainCopy(pixels.data); } catch { throw fail('JXL_INPUT', "Band's buffer is detached or too small; pass an attached buffer covering the view."); }
    return pixels;
  }
  const space = description.colorSpace ?? 'srgb';
  if (space !== 'srgb' && space !== 'display-p3' || description.icc || description.sampleFormat || description.bitDepth || description.transferFunction)
    throw fail('JXL_INPUT', 'The canvas, bitmap or video frame band has an unsupported color format; provide 8-bit sRGB or Display P3 pixels.');
  const read = surface(band, {readAs: space, maxPixels: width * count});
  if (read === band || read.width !== width || read.height !== count) throw fail('JXL_INPUT', `Invalid band shape; pass {data} or a canvas, bitmap, or video frame of ${width} x ${count}.`);
  return {...description, data: read.data, width, height: count};
}

function rowFailure(error) {
  let code = 'JXL_INPUT', message = "Row source failed; check its callback.";
  try { const value = error?.code; if (typeof value === 'string') code = value; } catch {}
  try {
    const value = error?.message ?? error;
    if (value === null || typeof value !== 'object' && typeof value !== 'function') message = String(value);
  } catch {}
  return {code, message};
}

export function rowBridge(source) {
  const {port1, port2} = new MessageChannel();
  let closed = false, reject;
  const refused = new Promise((resolve, fail) => { reject = fail; });
  refused.catch(() => {});
  const close = () => { closed = true; port1.close(); };
  port1.onmessage = async ({data: {y, count}}) => {
    if (closed) return;
    try {
      let {data, sampleFormat} = await readBand(source, y, count);
      if (closed) return;
      if (sampleFormat === 'float16' && source.description.sampleFormat === undefined)
        data = new Float16Array(data.buffer, data.byteOffset, data.length);
      port1.postMessage({data}, [data.buffer]);
    }
    catch (error) {
      if (closed) return;
      reject(error);
      port1.postMessage({error: rowFailure(error)});
    }
  };
  return {
    record: {width: source.width, height: source.height, ...source.description, rowsPort: port2}, close,
    wait: job => Promise.race([Promise.resolve(job).finally(close), refused]),
  };
}
export function bridgedRows({rowsPort, ...record}) {
  let pending = Promise.resolve();
  const ask = (y, count) => new Promise((resolve, reject) => {
    rowsPort.onmessage = ({data}) => data.error ? reject(Object.assign(new Error(data.error.message), {code: data.error.code ?? 'JXL_INPUT'})) : resolve({data: data.data});
    rowsPort.postMessage({y, count});
  });
  return {...record, rows: (y, count) => (pending = pending.then(() => ask(y, count), () => ask(y, count)))};
}
