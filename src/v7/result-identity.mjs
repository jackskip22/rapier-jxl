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
export {sampleDescription};

const K = Uint32Array.of(0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2);
const rotate = (value, bits) => value >>> bits | value << 32 - bits;
export class SampleHash {
  constructor() {
    this.state = Uint32Array.of(0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19);
    this.block = new Uint8Array(64); this.words = new Uint32Array(64); this.used = 0; this.length = 0;
  }
  compress(bytes, at) {
    const w = this.words;
    for (let i = 0; i < 16; i++, at += 4) w[i] = bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotate(a,7) ^ rotate(a,18) ^ a >>> 3) + w[i - 7] + (rotate(b,17) ^ rotate(b,19) ^ b >>> 10);
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + (e & f ^ ~e & g) + K[i] + w[i];
      const t2 = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + (a & b ^ a & c ^ b & c);
      h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) this.state[i] += value;
  }
  update(bytes) {
    if (this.done) throw fail('JXL_INTERNAL', 'A completed identity cannot accept more samples.');
    this.length += bytes.length; let at = 0;
    if (this.used) {
      const count = Math.min(64 - this.used, bytes.length);
      this.block.set(bytes.subarray(0, count), this.used); this.used += count; at = count;
      if (this.used === 64) { this.compress(this.block, 0); this.used = 0; }
    }
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) { this.block.set(bytes.subarray(at), 0); this.used = bytes.length - at; }
    return this;
  }
  digest() {
    if (this.done) return this.done;
    const tail = new Uint8Array(this.used < 56 ? 64 : 128); tail.set(this.block.subarray(0, this.used)); tail[this.used] = 128;
    const view = new DataView(tail.buffer); view.setUint32(tail.length - 8, Math.floor(this.length / 0x20000000));
    view.setUint32(tail.length - 4, this.length * 8 >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);
    return this.done = 'sha256:' + [...this.state].map(value => value.toString(16).padStart(8, '0')).join('');
  }
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

async function describedIdentity(picture, payload, data) {
  const record = {width: picture.width, height: picture.height, ...sampleDescription(picture, data), ...payload};
  if (picture.icc) record.icc = digestBytes(picture.icc);
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

