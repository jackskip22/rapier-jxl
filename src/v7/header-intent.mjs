// SPDX-License-Identifier: MIT
import {JxlBits, readSize} from '../jxl-size.mjs';
import {prepareColorEncoding} from '../color-info.mjs';
import {BitWriter} from '../bits.mjs';

export function sRGBWithIntent(picture) {
  const e = picture?.colorEncoding;
  if (!e || !Object.keys(e).every(key => ['space', 'transferFunction', 'renderingIntent'].includes(key)) ||
      !(e.space === 'rgb' || e.space === 'gray') || e.transferFunction !== 'srgb') return [picture, undefined];
  const {colorEncoding: _named, ...rest} = picture;
  return [{...rest, colorSpace: 'srgb', transferFunction: 'srgb'}, e.renderingIntent];
}
export function withRenderingIntent(bytes, intent) {
  if (!intent || intent === 'relative') return bytes;
  return bytes[0] === 0xff && bytes[1] === 0x0a ? codestream(bytes, intent) : boxed(bytes, intent);
}
const word = (b, at) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
function boxed(bytes, intent) {
  for (let at = 0; at + 8 <= bytes.length;) {
    const size = word(bytes, at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size === 1 || size !== 0 && size < 8) return bytes;
    const end = size ? at + size : bytes.length;
    if (end > bytes.length) return bytes;
    if (type === 'jxlc' || type === 'jxlp') {
      const from = at + 8 + (type === 'jxlp' ? 4 : 0), payload = bytes.subarray(from, end), rewritten = codestream(payload, intent);
      if (rewritten === payload) return bytes;
      const out = new Uint8Array(bytes.length + rewritten.length - payload.length), length = from - at + rewritten.length;
      out.set(bytes.subarray(0, from)); out.set(rewritten, from); out.set(bytes.subarray(end), from + rewritten.length);
      if (size) new DataView(out.buffer).setUint32(at, length);
      return out;
    }
    at = end;
  }
  return bytes;
}
const ENUM = [[0, 0], [0, 1], [4, 2], [6, 18]], XY = [[19, 0], [19, 524288], [20, 1048576], [21, 2097152]];
function headerFields(bytes) {
  const r = new JxlBits(bytes), bool = () => r.read(1) === 1, f16 = n => r.skip(16 * n);
  readSize(r);
  if (bool()) return null;
  const extra = bool();
  if (extra) {
    r.skip(3);
    if (bool()) { const small = bool(); if (small) r.skip(5); else r.u32([[9, 1], [13, 1], [18, 1], [30, 1]]); if (!r.read(3)) { if (small) r.skip(5); else r.u32([[9, 1], [13, 1], [18, 1], [30, 1]]); } }
    if (bool() || bool()) return null;
  }
  const depth = () => { if (bool()) { r.u32([[0, 32], [0, 16], [0, 24], [6, 1]]); r.skip(4); } else r.u32([[0, 8], [0, 10], [0, 12], [6, 1]]); };
  depth();
  r.skip(1);
  for (let n = r.u32([[0, 0], [0, 1], [4, 2], [12, 1]]); n > 0; n--) {
    if (bool()) continue;
    const type = r.u32(ENUM);
    depth(); r.u32([[0, 0], [0, 3], [0, 4], [3, 1]]);
    r.skip(8 * r.u32([[0, 0], [4, 0], [5, 16], [10, 48]]));
    if (type === 0) r.skip(1); else if (type === 2) f16(4); else if (type === 5) r.u32([[0, 1], [2, 0], [4, 3], [8, 19]]);
  }
  const xyb = bool(), from = r.bit;
  let space = 0;
  if (!bool()) {
    if (bool()) return null;
    space = r.u32(ENUM);
    if (space === 2 || space === 3) return null;
    if (r.u32(ENUM) !== 1) return null;
    if (space === 0 && r.u32(ENUM) !== 1) return null;
    if (bool() || r.u32(ENUM) !== 13) return null;
    r.u32(ENUM);
  }
  const to = r.bit;
  if (extra && !bool()) { f16(2); r.skip(1); f16(1); }
  if (r.read(2)) return null;
  if (!bool()) {
    if (xyb && !bool()) f16(16);
    const mask = r.read(3);
    for (const [bit, n] of [[1, 15], [2, 55], [4, 210]]) if (mask & bit) f16(n);
  }
  return {space: space === 1 ? 'gray' : 'rgb', from, to, end: r.bit};
}
function codestream(bytes, intent) {
  if (bytes[0] !== 0xff || bytes[1] !== 0x0a) return bytes;
  let fields;
  try { fields = headerFields(bytes); } catch { return bytes; }
  if (!fields) return bytes;
  const {colorData} = prepareColorEncoding({space: fields.space, whitePoint: 'd65', ...(fields.space === 'rgb' && {primaries: 'srgb'}), transferFunction: 'srgb', renderingIntent: intent});
  const {from, to, end} = fields, r = new JxlBits(bytes), w = new BitWriter(bytes.length + 64);
  const copy = (a, b) => { r.bit = a; for (let left = b - a; left > 0; left -= 24) { const n = Math.min(24, left); w.write(n, r.read(n)); } };
  copy(0, from); w.append(colorData); copy(to, end);
  const head = w.finish(), tail = bytes.subarray(Math.ceil(end / 8)), out = new Uint8Array(head.length + tail.length);
  out.set(head); out.set(tail, head.length);
  return out;
}
