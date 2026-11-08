// SPDX-License-Identifier: MIT
import {check, dimensions, fail, LARGEST} from './primitives.mjs';
import {arrayBufferBytes, copyBytes, typedName} from './bytes.mjs';
import {described, fromDecoded, isDecoded} from './describe.mjs';
import {pixels} from './input.mjs';
import {admitRows, readBand} from './rows.mjs';
import {isTexture, readTexture} from './texture.mjs';
import {own} from './ownership.mjs';
import {admitSampleKind} from './verify-samples.mjs';
import {stable, sampleDescription} from './identity-record.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
export {sampleDescription};

export class SampleHash {
  constructor() { this.state = sha256Start(); }
  update(bytes) {
    if (this.done) throw fail('JXL_INTERNAL', 'A completed identity cannot accept more samples.');
    this.state = sha256Update(this.state, bytes);
    return this;
  }
  digest() { return this.done ??= 'sha256:' + sha256Finish(this.state); }
}

export async function digestBytes(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return 'sha256:' + [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  return new SampleHash().update(bytes).digest();
}
const littleEndian = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;
export function sampleBytes(data) {
  if (!ArrayBuffer.isView(data) || arrayBufferBytes(data.buffer) === null) throw fail('JXL_INPUT', 'Samples need an ordinary, attached ArrayBuffer.');
  let bytes; try { bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); }
  catch { throw fail('JXL_INPUT', 'The sample buffer is detached.'); }
  const size = data.BYTES_PER_ELEMENT;
  if (littleEndian || size === 1) return bytes;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += size) for (let j = 0; j < size; j++) out[i + j] = bytes[i + size - j - 1];
  return out;
}
const recordDigest = value => digestBytes(new TextEncoder().encode(JSON.stringify(stable(value))));
export const isIdentity = value => value && ['bytes', 'pixels'].includes(value.kind) && /^sha256:[a-f0-9]{64}$/.test(value.digest);
export const isBlob = value => typeof Blob === 'function' && value instanceof Blob;
export async function encodedSourceBytes(source) {
  if (isBlob(source)) return new Uint8Array(await source.arrayBuffer());
  return typedName.call(source) === 'Uint8Array' ? source : null;
}
export const isRows = value => value && typeof value.rows === 'function' && value.data === undefined;

function descriptionCopy(value) {
  const description = described(value);
  if (value.colorEncoding !== undefined) description.colorEncoding = value.colorEncoding;
  return own(description, LARGEST, Number.MAX_SAFE_INTEGER);
}
const sampleKinds = {Uint8Array, Uint8ClampedArray, Uint16Array, Float32Array};
function copiedSamples(data, description) {
  const name = admitSampleKind(data, description);
  sampleBytes(data);
  if (name === 'Float16Array') {
    return new Uint16Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer);
  }
  return new sampleKinds[name](data);
}
export function snapshotSource(source, options = {}) {
  check(options.signal);
  const maxPixels = options.maxPixels ?? LARGEST;
  if (isIdentity(source)) return {...source};
  if (isBlob(source)) return source;
  if (typedName.call(source) === 'Uint8Array') return copyBytes(source);
  if (isRows(source)) {
    const admitted = source.description ? source : admitRows(source, maxPixels);
    dimensions(admitted.width, admitted.height, maxPixels);
    return {width: admitted.width, height: admitted.height, rows: admitted.rows, description: descriptionCopy(admitted.description)};
  }
  if (isTexture(source)) return readTexture(source, maxPixels).then(value => snapshotSource(value, options));
  if (isDecoded(source)) source = fromDecoded(source);
  if (source?.frames) {
    dimensions(source.width, source.height, maxPixels);
    if (!Array.isArray(source.frames) || !source.frames.length || !Number.isSafeInteger(source.loops ?? 0) || (source.loops ?? 0) < 0)
      throw fail('JXL_INPUT', 'An animation needs frames and a nonnegative whole loop count.');
    const description = descriptionCopy(source);
    if (typedName.call(source.frames[0]?.data) === 'Float16Array') description.sampleFormat ??= 'float16';
    return {width: source.width, height: source.height, loops: source.loops ?? 0, ...description,
      frames: source.frames.map(frame => {
        if (!frame || !ArrayBuffer.isView(frame.data) || frame.data.length !== source.width * source.height * 4)
          throw fail('JXL_INPUT', 'A frame has width times height times four samples.');
        if (!Number.isFinite(frame.duration) || frame.duration < 0) throw fail('JXL_INPUT', 'A frame duration is a finite nonnegative number of milliseconds.');
        return {data: copiedSamples(frame.data, description), duration: frame.duration};
      })};
  }
  if (!source || !ArrayBuffer.isView(source.data)) source = pixels(source, {readAs: options.readAs}, maxPixels, true);
  dimensions(source.width, source.height, maxPixels);
  if (source.data.length !== source.width * source.height * 4) throw fail('JXL_INPUT', 'A picture has width times height times four samples.');
  const description = descriptionCopy(source);
  if (typedName.call(source.data) === 'Float16Array') description.sampleFormat ??= 'float16';
  return {width: source.width, height: source.height, ...description, data: copiedSamples(source.data, description)};
}

export async function describedIdentity(picture, payload, data, hashICC = digestBytes) {
  const record = {width: picture.width, height: picture.height, ...sampleDescription(picture, data), ...payload};
  if (picture.icc) record.icc = hashICC(picture.icc);
  if (picture.colorEncoding) record.colorEncoding = stable(picture.colorEncoding);
  if (picture.extraChannels?.length) record.extraChannels = picture.extraChannels.map(({data, ...channel}) =>
    ({...stable(channel), data: digestBytes(sampleBytes(data))}));
  if (record.data !== undefined) record.data = await record.data;
  if (record.icc) record.icc = await record.icc;
  if (record.frames) record.frames = await Promise.all(record.frames.map(async frame => ({...frame, data: await frame.data})));
  if (record.extraChannels) record.extraChannels = await Promise.all(record.extraChannels.map(async channel => ({...channel, data: await channel.data})));
  return {kind: 'pixels', digest: await recordDigest(record)};
}
export async function rowsIdentity(source, {signal, consume} = {}) {
  const hash = new SampleHash(); let first;
  for (let y = 0; y < source.height; y += 256) {
    check(signal);
    const band = await readBand(source, y, Math.min(256, source.height - y), signal);
    first ??= {...band, data: new band.data.constructor(0)};
    if (JSON.stringify(sampleDescription(first)) !== JSON.stringify(sampleDescription(band))) throw fail('JXL_INPUT', 'Every band has the same sample description.');
    hash.update(sampleBytes(band.data));
    if (consume) await consume(band, y);
  }
  return describedIdentity({...first, width: source.width, height: source.height}, {data: hash.digest()});
}
export async function identityOfSnapshot(source, options = {}) {
  if (source && typeof source.then === 'function') source = await source;
  check(options.signal);
  if (isIdentity(source)) return {...source};
  if (isBlob(source)) source = new Uint8Array(await source.arrayBuffer());
  if (typedName.call(source) === 'Uint8Array') return {kind: 'bytes', digest: await digestBytes(source)};
  if (isRows(source)) return rowsIdentity(source, options);
  if (source.frames) {
    const frames = source.frames.map(frame => { check(options.signal); return {duration: frame.duration, data: digestBytes(sampleBytes(frame.data))}; });
    return describedIdentity(source, {loops: source.loops ?? 0, frames});
  }
  return describedIdentity(source, {data: digestBytes(sampleBytes(source.data))});
}
export function sourceIdentity(original, options = {}) {
  try { return identityOfSnapshot(snapshotSource(original, options), options); } catch (error) { return Promise.reject(error); }
}

