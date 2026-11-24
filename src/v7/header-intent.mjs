// SPDX-License-Identifier: MIT
import {JxlBits, readSize} from '../jxl-size.mjs';
import {BitWriter} from '../bits.mjs';
import {JOIN, journalFact, sliceBytes} from '../step-journal.mjs';
import {profileFields} from '../icc-transform.mjs';

const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];
const WHITES = {1: 'd65', 10: 'e', 11: 'dci'}, PRIMARIES = {1: 'srgb', 11: 'display-p3', 9: 'rec2020'}, TRANSFERS = {1: 'bt709', 8: 'linear', 13: 'srgb', 17: 'dci'};
export const lossyProfileEncoding = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : function lossyProfileEncoding(icc) {
  const fields = profileFields(icc);
  if (!fields || fields.gray) return null;
  return {space: 'rgb', whitePoint: WHITES[fields.white.enum] ?? fields.white.xy,
    primaries: PRIMARIES[fields.primaries.enum] ?? fields.primaries.xy,
    ...(fields.gamma !== undefined ? {gamma: fields.gamma} : {transferFunction: TRANSFERS[fields.transfer]}), renderingIntent: INTENTS[fields.intent]};
};
function profileEncoding(picture, lossy) {
  const data = picture?.data;
  if (!lossy || !picture.icc || picture.colorEncoding !== undefined || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
      (picture.bitDepth ?? 8) !== 8 || (picture.sampleFormat ?? 'uint') !== 'uint' || (picture.colorSpace ?? 'srgb') !== 'srgb') return picture;
  const colorEncoding = lossyProfileEncoding(picture.icc);
  if (!colorEncoding) return picture;
  const {icc: _profile, colorSpace: _space, ...rest} = picture;
  return {...rest, colorEncoding};
}

export const sRGBWithIntent = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : function sRGBWithIntent(picture, {lossy = false} = {}) {
  picture = profileEncoding(picture, lossy);
  const e = picture?.colorEncoding;
  if (!e || !(e.space === 'rgb' || e.space === 'gray') || e.transferFunction !== 'srgb' || e.gamma !== undefined) return [picture, undefined];
  const named = Object.keys(e).every(key => ['space', 'transferFunction', 'renderingIntent'].includes(key)) ? 'srgb'
    : lossy && e.space === 'rgb' && (e.whitePoint ?? 'd65') === 'd65' && Object.keys(e).every(key => ['space', 'whitePoint', 'primaries', 'transferFunction', 'renderingIntent'].includes(key))
      ? {srgb: 'srgb', 'display-p3': 'display-p3'}[e.primaries ?? 'srgb'] : undefined;
  const intent = typeof e.renderingIntent === 'number' ? INTENTS[e.renderingIntent] : e.renderingIntent;
  if (!named || e.renderingIntent !== undefined && !INTENTS.includes(intent)) return [picture, undefined];
  if (e.space === 'gray' && !graySamples(picture.data)) throw Object.assign(new Error('GRAY: R=G=B each pixel'), {code: 'JXL_INPUT'});
  const {colorEncoding: _named, ...rest} = picture;
  return [{...rest, colorSpace: named, transferFunction: 'srgb'}, intent];
};
function graySamples(data) {
  if (!ArrayBuffer.isView(data) || data instanceof DataView) return true;
  const words = data instanceof Float32Array ? new Uint32Array(data.buffer, data.byteOffset, data.length)
    : typeof Float16Array === 'function' && data instanceof Float16Array ? new Uint16Array(data.buffer, data.byteOffset, data.length) : data;
  for (let i = 0; i + 2 < words.length; i += 4) if (words[i] !== words[i + 1] || words[i] !== words[i + 2]) return false;
  return true;
}
export function withRenderingIntent(bytes, intent, join) {
  if (!intent || intent === 'relative') return bytes;
  return bytes[0] === 0xff && bytes[1] === 0x0a ? codestream(bytes, intent, join) : boxed(bytes, intent);
}
const word = (b, at) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
function boxed(bytes, intent) {
  if ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true)) return bytes;
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
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) && extra) {
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
  let space = 0, primaries = 1;
  if (!bool()) {
    if (bool()) return null;
    space = r.u32(ENUM);
    if (space === 2 || space === 3) return null;
    if (r.u32(ENUM) !== 1) return null;
    if (space === 0 && (primaries = r.u32(ENUM)) !== 1 && primaries !== 11) return null;
    if (bool() || r.u32(ENUM) !== 13) return null;
    r.u32(ENUM);
  }
  const to = r.bit;
  if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) && extra && !bool()) { f16(2); r.skip(1); f16(1); }
  if (r.read(2)) return null;
  if (!bool() && !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true)) {
    if (xyb && !bool()) f16(16);
    const mask = r.read(3);
    for (const [bit, n] of [[1, 15], [2, 55], [4, 210]]) if (mask & bit) f16(n);
  }
  return {space: space === 1 ? 'gray' : 'rgb', primaries: primaries === 11 ? 'display-p3' : 'srgb', from, to, end: r.bit};
}
function codestream(bytes, intent, join) {
  if (bytes[0] !== 0xff || bytes[1] !== 0x0a) return bytes;
  let fields;
  try { fields = headerFields(bytes); } catch { return bytes; }
  if (!fields) return bytes;
  const {from, to, end} = fields, r = new JxlBits(bytes), w = new BitWriter(Math.ceil(end / 8) + 64);
  const copy = (a, b) => { r.bit = a; for (let left = b - a; left > 0; left -= 24) { const n = Math.min(24, left); w.write(n, r.read(n)); } };
  copy(0, from);
  w.write(2, 0); w.writeU32(ENUM, fields.space === 'rgb' ? 0 : 1); w.writeU32(ENUM, 1);
  if (fields.space === 'rgb') w.writeU32(ENUM, fields.primaries === 'display-p3' ? 11 : 1);
  w.write(1, 0); w.writeU32(ENUM, 13); w.writeU32(ENUM, INTENTS.indexOf(intent));
  copy(to, end);
  const head = w.finish(), tail = (typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) ? bytes.subarray(Math.ceil(end / 8)) : sliceBytes(bytes, Math.ceil(end / 8)), pieces = !(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true) && journalFact(tail, JOIN);
  if (pieces && join) return join([head, ...pieces]);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head); out.set(tail, head.length);
  return out;
}

export const sourceColor = ({colorSpace, renderingIntent}) => renderingIntent !== undefined && renderingIntent !== 1
  ? {colorEncoding: {space: 'rgb', whitePoint: 'd65', primaries: colorSpace ?? 'srgb', transferFunction: 'srgb', renderingIntent}}
  : colorSpace ? {colorSpace} : {};
