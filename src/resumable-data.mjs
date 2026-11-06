// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';

const RECORD_BYTES = 1 << 20, CHUNK_BYTES = 1 << 16, TOTAL_BYTES = 2 ** 32;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const byteOffsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset').get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const bufferLengthOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const invalid = message => fault('JXL_INPUT', message);

function checked(run) {
  try { return run(); }
  catch (error) { if (error?.code === 'JXL_INPUT') throw error; throw invalid('Invalid checkpoint data.'); }
}

function bytesOf(value, limit = TOTAL_BYTES) {
  if (!(value instanceof Uint8Array)) throw invalid('Checkpoint bytes must be a Uint8Array.');
  const length = byteLengthOf.call(value), buffer = bufferOf.call(value), offset = byteOffsetOf.call(value);
  bufferLengthOf.call(buffer);
  if (length > limit) throw invalid('Checkpoint bytes exceed their limit.');
  return new Uint8Array(buffer, offset, length);
}

function fields(value, names) {
  if (value === null || typeof value !== 'object') throw invalid('A checkpoint record must contain plain data.');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid('A checkpoint record must contain plain data.');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || names && (keys.length !== names.length || keys.some(key => !names.includes(key))))
    throw invalid('Invalid checkpoint fields.');
  const entries = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('Checkpoint accessors and hidden fields are unsupported.');
    return [key, descriptor.value];
  });
  return entries;
}

function arrayValues(value, limit = RECORD_BYTES) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid('A checkpoint array must contain plain data.');
  const length = value.length;
  if (length > limit || Reflect.ownKeys(value).length !== length + 1) throw invalid('Invalid checkpoint array.');
  const values = new Array(length);
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('Checkpoint arrays must be dense data arrays.');
    values[i] = descriptor.value;
  }
  return values;
}

function utf8Length(text) {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) length++;
    else if (c < 2048) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

function canonicalText(value, checkFields) {
  const chunks = [], active = new Set(), stack = [{value}];
  let length = 0;
  const append = text => {
    length += utf8Length(text);
    if (length > RECORD_BYTES) throw invalid('A checkpoint record exceeds 1 MiB.');
    chunks.push(text);
  };
  while (stack.length) {
    const item = stack.pop();
    if (item.leave !== undefined) { active.delete(item.leave); append(item.text); continue; }
    if (item.text !== undefined) { append(item.text); continue; }
    const v = item.value;
    if (v === null) { append('null'); continue; }
    const type = typeof v;
    if (type === 'boolean') { append(v ? 'true' : 'false'); continue; }
    if (type === 'number') {
      if (!Number.isFinite(v)) throw invalid('Checkpoint numbers must be finite.');
      append(JSON.stringify(v)); continue;
    }
    if (type === 'string') {
      if (v.length > RECORD_BYTES) throw invalid('A checkpoint record exceeds 1 MiB.');
      append(JSON.stringify(v)); continue;
    }
    if (type !== 'object' || active.has(v)) throw invalid('Checkpoints cannot contain unsupported values or cycles.');
    active.add(v);
    if (Array.isArray(v)) {
      const values = checkFields ? arrayValues(v, RECORD_BYTES >> 1) : v;
      append('['); stack.push({leave: v, text: ']'});
      for (let i = values.length - 1; i >= 0; i--) {
        stack.push({value: values[i]});
        if (i) stack.push({text: ','});
      }
    } else {
      const entries = checkFields ? fields(v) : Object.keys(v).map(key => [key, v[key]]);
      if (entries.length > RECORD_BYTES / 5) throw invalid('A checkpoint record exceeds 1 MiB.');
      entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      append('{'); stack.push({leave: v, text: '}'});
      for (let i = entries.length - 1; i >= 0; i--) {
        const [key, child] = entries[i];
        if (key.length > RECORD_BYTES) throw invalid('A checkpoint record exceeds 1 MiB.');
        stack.push({value: child}); stack.push({text: JSON.stringify(key) + ':'});
        if (i) stack.push({text: ','});
      }
    }
  }
  return chunks.join('');
}

export function encodeData(value) {
  return checked(() => encoder.encode(canonicalText(value, true)));
}

export function decodeData(bytes) {
  return checked(() => {
    const text = decoder.decode(bytesOf(bytes, RECORD_BYTES)), value = JSON.parse(text);
    if (text !== canonicalText(value, false)) throw invalid('Checkpoint JSON is not canonical.');
    return value;
  });
}

export async function digest(bytes) {
  const input = checked(() => bytesOf(bytes));
  try {
    if (!globalThis.crypto?.subtle) throw invalid('SHA-256 is unavailable.');
    const result = await globalThis.crypto.subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    if (error?.code === 'JXL_INPUT') throw error;
    throw invalid('Cannot hash checkpoint bytes.');
  }
}

export async function part(bytes) {
  const input = checked(() => bytesOf(bytes)), length = input.length;
  return {hash: await digest(input), length};
}

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const ROUND = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);
const rotate = (value, bits) => value >>> bits | value << (32 - bits);

export function hashStart() { return {version: 1, length: 0, h: INITIAL.slice(), tail: []}; }

function stateOf(state) {
  const record = Object.fromEntries(fields(state, ['version', 'length', 'h', 'tail']));
  if (record.version !== 1 || !Number.isSafeInteger(record.length) || record.length < 0 || record.length > TOTAL_BYTES)
    throw invalid('Invalid SHA-256 checkpoint version or length.');
  const h = arrayValues(record.h, 8), tail = arrayValues(record.tail, 63);
  if (h.length !== 8 || h.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff) ||
      tail.length !== record.length % 64 || tail.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
      record.length < 64 && h.some((word, i) => word !== INITIAL[i]))
    throw invalid('Invalid SHA-256 checkpoint words or tail.');
  return {version: 1, length: record.length, h, tail};
}

function compress(h, input, offset, w) {
  for (let i = 0; i < 16; i++) {
    const at = offset + i * 4;
    w[i] = input[at] << 24 | input[at + 1] << 16 | input[at + 2] << 8 | input[at + 3];
  }
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3, s1 = rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, j] = h;
  for (let i = 0; i < 64; i++) {
    const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25), choose = e & f ^ ~e & g;
    const t1 = (j + s1 + choose + ROUND[i] + w[i]) >>> 0;
    const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22), majority = a & b ^ a & c ^ b & c;
    const t2 = (s0 + majority) >>> 0;
    j = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  const words = [a, b, c, d, e, f, g, j];
  for (let i = 0; i < 8; i++) h[i] = (h[i] + words[i]) >>> 0;
}

export function hashUpdate(state, bytes) {
  return checked(() => {
    const next = stateOf(state), input = bytesOf(bytes, CHUNK_BYTES);
    if (next.length + input.length > TOTAL_BYTES) throw invalid('SHA-256 input exceeds 2^32 bytes.');
    next.length += input.length;
    const w = new Uint32Array(64);
    let at = 0;
    if (next.tail.length) {
      const take = Math.min(64 - next.tail.length, input.length), block = new Uint8Array(64);
      block.set(next.tail); block.set(input.subarray(0, take), next.tail.length); at += take;
      if (next.tail.length + take < 64) { next.tail = Array.from(block.subarray(0, next.tail.length + take)); return next; }
      compress(next.h, block, 0, w);
    }
    for (; at + 64 <= input.length; at += 64) compress(next.h, input, at, w);
    next.tail = Array.from(input.subarray(at));
    return next;
  });
}

export function hashFinish(state) {
  return checked(() => {
    const {h, tail, length} = stateOf(state), bytes = new Uint8Array(tail.length < 56 ? 64 : 128);
    bytes.set(tail); bytes[tail.length] = 0x80;
    const view = new DataView(bytes.buffer), end = bytes.length;
    view.setUint32(end - 8, Math.floor(length / 0x20000000)); view.setUint32(end - 4, (length * 8) >>> 0);
    const w = new Uint32Array(64);
    compress(h, bytes, 0, w); if (bytes.length === 128) compress(h, bytes, 64, w);
    return h.map(word => word.toString(16).padStart(8, '0')).join('');
  });
}
