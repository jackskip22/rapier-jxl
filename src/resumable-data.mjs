// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {sha256Start, sha256Update, sha256Finish} from './sha256.mjs';

const RECORD_BYTES = 1 << 20, TOTAL_BYTES = 2 ** 32;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const byteOffsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset').get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const bufferLengthOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const invalid = message => fault('JXL_INPUT', message);

function checked(run) {
  try { return run(); }
  catch (error) { if (error?.code === 'JXL_INPUT') throw error; throw invalid('checkpoint data'); }
}

function bytesOf(value, limit = TOTAL_BYTES) {
  if (!(value instanceof Uint8Array)) throw invalid('checkpoint: Uint8Array');
  const length = byteLengthOf.call(value), buffer = bufferOf.call(value), offset = byteOffsetOf.call(value);
  bufferLengthOf.call(buffer);
  if (length > limit) throw invalid('checkpoint: too large');
  return new Uint8Array(buffer, offset, length);
}

function fields(value) {
  if (value === null || typeof value !== 'object') throw invalid('checkpoint record: plain object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid('checkpoint record: plain object');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string'))
    throw invalid('checkpoint fields');
  const entries = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('checkpoint: plain fields only');
    return [key, descriptor.value];
  });
  return entries;
}

function arrayValues(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid('checkpoint: plain array');
  const length = value.length;
  if (length > (RECORD_BYTES >> 1) || Reflect.ownKeys(value).length !== length + 1) throw invalid('checkpoint array');
  const values = new Array(length);
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid('checkpoint array: no holes');
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

const PLAIN = /^[ !#-[\]-~]*$/;
function canonicalText(value, checkFields) {
  const active = new Set(), over = () => invalid('checkpoint record: max 1 MiB');
  const quoted = text => PLAIN.test(text) ? '"' + text + '"' : JSON.stringify(text);
  let out = '';
  const append = text => { if ((out += text).length > RECORD_BYTES) throw over(); };
  const stack = [];
  const open = v => {
    if (v === null) return append('null');
    const type = typeof v;
    if (type === 'boolean') return append(v ? 'true' : 'false');
    if (type === 'number') {
      if (!Number.isFinite(v)) throw invalid('checkpoint number: finite');
      return append(Object.is(v, -0) ? '0' : '' + v);
    }
    if (type === 'string') {
      if (v.length > RECORD_BYTES) throw over();
      return append(quoted(v));
    }
    if (type !== 'object' || checkFields && active.has(v)) throw invalid('checkpoint: unsupported value or cycle');
    if (checkFields) active.add(v);
    if (Array.isArray(v)) { append('['); stack.push({v, items: checkFields ? arrayValues(v) : v, record: false, at: 0}); return; }
    const items = checkFields ? fields(v) : Object.keys(v).map(key => [key, v[key]]);
    if (items.length > RECORD_BYTES / 5) throw over();
    items.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    append('{'); stack.push({v, items, record: true, at: 0});
  };
  open(value);
  while (stack.length) {
    const frame = stack[stack.length - 1], {items, record} = frame;
    if (frame.at === items.length) {
      append(record ? '}' : ']'); stack.pop();
      if (checkFields) active.delete(frame.v);
      continue;
    }
    const item = items[frame.at];
    if (frame.at++) append(',');
    if (record) {
      if (item[0].length > RECORD_BYTES) throw over();
      append(quoted(item[0]) + ':'); open(item[1]);
    } else open(item);
  }
  return out;
}

export function encodeData(value) {
  return checked(() => {
    const bytes = encoder.encode(canonicalText(value, true));
    if (bytes.length > RECORD_BYTES) throw invalid('checkpoint record: max 1 MiB');
    return bytes;
  });
}

export function writeData(value, text = null) {
  return checked(() => {
    const bytes = encoder.encode(text ?? JSON.stringify(value));
    if (bytes.length > RECORD_BYTES) throw invalid('checkpoint record: max 1 MiB');
    return bytes;
  });
}

export function parseData(bytes) {
  return checked(() => JSON.parse(decoder.decode(bytesOf(bytes, RECORD_BYTES))));
}

export function decodeData(bytes) {
  return checked(() => {
    const text = decoder.decode(bytesOf(bytes, RECORD_BYTES)), value = JSON.parse(text);
    if (text !== canonicalText(value, false)) throw invalid('checkpoint JSON: not canonical');
    return value;
  });
}

export async function digest(bytes) {
  const input = checked(() => bytesOf(bytes));
  try {
    if (!globalThis.crypto?.subtle) return sha256Finish(sha256Update(sha256Start(), input));
    const result = await globalThis.crypto.subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    if (error?.code === 'JXL_INPUT') throw error;
    throw invalid('checkpoint hash failed');
  }
}

export async function part(bytes) {
  const input = checked(() => bytesOf(bytes)), length = input.length;
  return {hash: await digest(input), length};
}
