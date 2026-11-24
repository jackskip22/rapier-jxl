// SPDX-License-Identifier: MIT
import {JOURNAL, JOURNAL_FILE, JOIN, SAVED, journaled, journalFact} from '../step-journal.mjs';
import {configuredDecoder, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {sha256Start, sha256Update, sha256Finish} from '../sha256.mjs';
import {fail, unknownOption, dimensions, pixelLimit, PIXELS} from './primitives.mjs';
import {sourceColor} from './header-intent.mjs';

export function fileSize(bytes) {
  try {
    const word = i => (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
    let stream = bytes[0] === 255 && bytes[1] === 10 ? bytes : null;
    for (let at = 0; !stream && at + 8 <= bytes.length;) {
      let length = word(at), body = at + 8;
      const type = word(at + 4);
      if (length === 1) { length = word(at + 8) * 4294967296 + word(at + 12); body += 8; } else if (!length) length = bytes.length - at;
      const end = at + length;
      if (end < body || end > bytes.length) return null;
      if (type === 0x6a786c63) stream = bytes.subarray(body, end);
      else if (type === 0x6a786c70 && end - body >= 4 && !(word(body) & 0x7fffffff)) stream = bytes.subarray(body + 4, end);
      at = end;
    }
    if (!stream) return null;
    let bit = 0;
    const read = n => { let v = 0; for (let i = 0; i < n; i++, bit++) { if (bit >> 3 >= stream.length) throw 0; v += (stream[bit >> 3] >> (bit & 7) & 1) * 2 ** i; } return v; };
    const u32 = () => read([9, 13, 18, 30][read(2)]) + 1;
    if (read(16) !== 0x0aff) return null;
    const small = read(1), height = small ? (read(5) + 1) * 8 : u32(), ratio = read(3);
    return {height, width: ratio ? Math.floor(height * [0, 1, 12, 4, 3, 16, 5, 2][ratio] / [1, 1, 10, 3, 2, 9, 4, 1][ratio]) : small ? (read(5) + 1) * 8 : u32()};
  } catch { return null; }
}
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const encoded = value => JSON.stringify(value, (key, item) => item === undefined ? null : record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
async function rebuilt(imageResult, bytes, facts, original) {
  if (!record(facts)) throw fail('JXL_INPUT', "finished record: job result record");
  const {width, height, format = 'jxl', fidelity, kept, measurements, transform, readAs, originalBytes, usedWebGPU, otherDecoders} = facts, shown = transform ?? {width, height};
  if (originalBytes !== undefined && original.kind === 'file' && originalBytes !== original.byteLength)
    throw fail('JXL_INPUT', "finished record: original size required");
  if (bytes && format === 'jxl') {
    const size = fileSize(bytes);
    if (!size || !(size.width === shown.width && size.height === shown.height || size.width === shown.height && size.height === shown.width))
      throw fail('JXL_INPUT', "finished record: file mismatch");
  }
  let made;
  try {
    made = await imageResult(bytes, {width, height}, {fidelity, measurements, format, ...(bytes && kept !== undefined && {kept}),
      ...(transform !== undefined && {transform}), ...(readAs !== undefined && {readAs}), ...(originalBytes !== undefined && {originalBytes}),
      ...(usedWebGPU !== undefined && {usedWebGPU}), ...(bytes && otherDecoders !== undefined && {otherDecoders}), owned: true});
  } catch { throw fail('JXL_INPUT', "finished record: job result record"); }
  for (const key of new Set([...Object.keys(facts), ...Object.keys(made)])) if (key !== 'bytes' && key !== 'source' && encoded(made[key]) !== encoded(facts[key]))
    throw fail('JXL_INPUT', "finished record: file mismatch");
  const source = original.kind === 'decode' ? facts.source : undefined;
  if (source === undefined) return made;
  if (!record(source) || source.kind !== 'bytes' || !/^sha256:[0-9a-f]{64}$/.test(source.digest) || Object.keys(source).length !== 2)
    throw fail('JXL_INPUT', "finished record: original required");
  return {...made, source: {kind: 'bytes', digest: source.digest}};
}
function plain(value, depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(item => plain(item, depth + 1));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => plain(item, depth + 1));
}

async function decoded(bytes, snap) {
  const {decode, restore} = (snap !== undefined ? snap : configuredDecoder()) ?? {};
  if (!decode) throw fail('JXL_PLATFORM', "decoder: configureDecoder(decode) with decode from jpegxl/decode");
  const picture = await decode(bytes);
  if (picture.format !== 'uint8' || typeof picture.colorSpace !== 'string' && !picture.rgbaICC)
    throw fail('JXL_UNSUPPORTED', 'decoded pixels: 8-bit, a named colorSpace or rgbaICC');
  let source;
  if (restore && picture.header?.reconstruction) {
    const jpeg = (await restore(bytes)).bytes;
    source = 'sha256:' + sha256Finish(sha256Update(sha256Start(), jpeg));
  }
  return {data: new Uint8Array(picture.data.buffer, picture.data.byteOffset, picture.data.length), width: picture.width, height: picture.height,
    ...(picture.rgbaICC ? {icc: picture.rgbaICC} : picture.colorEncoding?.renderingIntent === 0 || picture.colorEncoding?.renderingIntent > 1 ? {colorEncoding: picture.colorEncoding} : {colorSpace: picture.colorSpace}), ...(source && {source})};
}
const named = async (source, pending) => {
  const made = await pending;
  if (!made.facts.record) return made;
  const {source: _pixels, ...record} = made.facts.record;
  return {...made, facts: {...made.facts, record: source ? {...record, source: {kind: 'bytes', digest: source}} : record}};
};
const pictureOf = ({source, ...picture}) => picture;
const input = (data, source, files) => (source.kind ?? 'pixels') === 'file' ? files ? {[JOURNAL_FILE]: data} : new Blob([data])
  : {data, width: source.width, height: source.height, ...sourceColor(source)};
async function made(pending) {
  const result = await pending;
  if (Array.isArray(result)) {
    const records = result.map(({bytes, ...facts}) => ({...facts, length: bytes ? bytes.length : null}));
    const bytes = new Uint8Array(records.reduce((n, r) => n + (r.length ?? 0), 0));
    let at = 0;
    for (const item of result) if (item.bytes) { bytes.set(item.bytes, at); at += item.bytes.length; }
    return {bytes, facts: {records}};
  }
  const {bytes, ...facts} = result;
  return {bytes: bytes ?? new Uint8Array(0), facts: {record: facts, missed: !bytes}};
}
const HEAD = 65536, PIECE = 1048576;
async function pieced(pending, journal) {
  const made = await pending, {bytes} = made;
  if (!journal || bytes.length <= HEAD || journalFact(bytes, JOIN)) return made;
  const pieces = [];
  for (let at = 0; at < bytes.length; at = Math.min(bytes.length, at ? at + PIECE : HEAD)) {
    const to = Math.min(bytes.length, at ? at + PIECE : HEAD), saved = await journal({unit: 'output-piece', cold: true});
    if (saved && Object.hasOwn(saved, SAVED)) { pieces.push(saved[SAVED]); continue; }
    const piece = bytes.slice(at, to);
    await journal({unitDone: 'output-piece', value: piece});
    pieces.push(piece);
  }
  return {...made, bytes: journal.join(pieces)};
}
async function sized(pending, source) {
  const made = await pending, record = made.facts?.record;
  if ((source.kind ?? 'pixels') !== 'file' || !record || record.originalBytes !== undefined || !Number.isSafeInteger(source.byteLength) || !made.bytes.length) return made;
  return {...made, facts: {...made.facts, record: {...record, originalBytes: source.byteLength, largerThanOriginal: made.bytes.length > source.byteLength}}};
}
export function verbSteps({id, verb, taken, admit = () => {}, rows = false, files = false, result: imageResult}) {
  return Object.freeze({id,
    eager: source => source.kind === 'decode' || ((source.kind ?? 'pixels') === 'file' ? !files : !rows),
    normalize(options, source) {
      if (!record(options) || !plain(options)) throw fail('JXL_OPTIONS', "resumable options: plain data");
      const unknown = Object.keys(options).find(key => !taken.includes(key));
      if (unknown) throw unknownOption(unknown, options, 'option', `; use ${taken.join(', ')}`);
      const kind = source.kind ?? 'pixels';
      if (kind === 'pixels') {
        const {width, height} = source;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4)
          throw fail('JXL_INPUT', "pixels: width*height*4 RGBA8 or kind:file");
        dimensions(width, height, pixelLimit(options.maxPixels));
      } else if (kind !== 'file' && kind !== 'decode') throw fail('JXL_INPUT', "source kind: pixels|file|decode");
      admit(options);
      return {options: {...options}};
    },
    async run(plan, data, source, journal) {
      if (source.kind !== 'decode') return pieced(sized(made(verb(input(data, source, files), {...plan.options, [JOURNAL]: journal})), source), journal);
      const snap = journal?.host && DECODER_SNAPSHOT in journal.host ? journal.host[DECODER_SNAPSHOT] : configuredDecoder();
      const picture = await journaled(journal, 'decode', () => decoded(data, snap));
      return pieced(named(picture.source, made(verb(pictureOf(picture), {...plan.options, [JOURNAL]: journal}))), journal);
    },
    async straight(plan, data, source, signal, _part, host) {
      if (source.kind !== 'decode') return sized(made(verb(input(data, source, false), {...plan.options, signal})), source);
      const snap = host && DECODER_SNAPSHOT in host ? host[DECODER_SNAPSHOT] : configuredDecoder();
      const picture = await decoded(data, snap);
      return named(picture.source, made(verb(pictureOf(picture), {...plan.options, signal})));
    },
    async record(bytes, plan, source, facts) {
      if (!record(facts)) throw fail('JXL_INPUT', "finished record: job result record");
      if (facts.records !== undefined) {
        if (!Array.isArray(facts.records) || !facts.records.length) throw fail('JXL_INPUT', "finished records: nonempty array");
        let at = 0;
        const made = [];
        for (const {length, ...facts1} of facts.records) {
          if (length !== null && (!Number.isSafeInteger(length) || length < 1 || at + length > bytes.length))
            throw fail('JXL_INPUT', "finished records: incomplete file");
          made.push(await rebuilt(imageResult, length === null ? null : bytes.slice(at, at += length), facts1, source));
        }
        if (at !== bytes.length) throw fail('JXL_INPUT', "finished records: incomplete file");
        return made;
      }
      if (typeof facts.missed !== 'boolean' || facts.missed && bytes.length) throw fail('JXL_INPUT', "finished record: file mismatch");
      return rebuilt(imageResult, facts.missed ? null : bytes, facts.record, source);
    }});
}
