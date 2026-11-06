// SPDX-License-Identifier: MIT
import {JOURNAL} from '../step-journal.mjs';
import {fail} from './primitives.mjs';
import {imageResult} from './result.mjs';
import {pictureSize} from './jpeg-size.mjs';

export const STEPS = Symbol.for('rapier-jxl.steps');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const encoded = value => JSON.stringify(value, (key, item) => item === undefined ? null : record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
async function rebuilt(bytes, facts) {
  if (!record(facts)) throw fail('JXL_INPUT', 'A finished job\'s record is a record.');
  const {width, height, format = 'jxl', fidelity, kept, measurements, transform, readAs} = facts, shown = transform ?? {width, height};
  if (bytes && format === 'jxl') {
    const size = pictureSize(bytes);
    if (!size || !(size.width === shown.width && size.height === shown.height || size.width === shown.height && size.height === shown.width))
      throw fail('JXL_INPUT', 'A finished job\'s record does not describe its file.');
  }
  let made;
  try {
    made = await imageResult(bytes, {width, height}, {fidelity, measurements, format, ...(bytes && kept !== undefined && {kept}),
      ...(transform !== undefined && {transform}), ...(readAs !== undefined && {readAs}), owned: true});
  } catch { throw fail('JXL_INPUT', 'A finished job\'s record is not a result record.'); }
  for (const key of new Set([...Object.keys(facts), ...Object.keys(made)])) if (key !== 'bytes' && key !== 'source' && encoded(made[key]) !== encoded(facts[key]))
    throw fail('JXL_INPUT', 'A finished job\'s record does not describe its file.');
  return made;
}
function plain(value, depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (depth > 8 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(item => plain(item, depth + 1));
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => plain(item, depth + 1));
}

export function verbSteps(id, verb, {taken, admit = () => {}}) {
  return Object.freeze({id,
    normalize(options, source) {
      if (!record(options) || !plain(options)) throw fail('JXL_OPTIONS', 'A resumable job\'s options are plain data.');
      const unknown = Object.keys(options).find(key => !taken.includes(key));
      if (unknown) throw fail('JXL_OPTIONS', `A resumable ${id} takes ${taken.join(', ')}; not ${unknown}.`);
      const kind = source.kind ?? 'pixels';
      if (kind === 'pixels') {
        const {width, height} = source;
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || source.byteLength !== width * height * 4)
          throw fail('JXL_INPUT', 'A resumable pixel source is straight RGBA8 rows: byteLength is width * height * 4.');
      } else if (kind !== 'file') throw fail('JXL_INPUT', 'A resumable source is pixels or a file.');
      admit(options);
      return {options: {...options}};
    },
    async run(plan, data, source, journal) {
      const input = (source.kind ?? 'pixels') === 'file' ? new Blob([data])
        : {data, width: source.width, height: source.height, ...(source.colorSpace && {colorSpace: source.colorSpace})};
      const result = await verb(input, {...plan.options, [JOURNAL]: journal});
      if (Array.isArray(result)) {
        const records = result.map(({bytes, ...facts}) => ({...facts, length: bytes ? bytes.length : null}));
        const bytes = new Uint8Array(records.reduce((n, r) => n + (r.length ?? 0), 0));
        let at = 0;
        for (const item of result) if (item.bytes) { bytes.set(item.bytes, at); at += item.bytes.length; }
        return {bytes, facts: {records}};
      }
      const {bytes, ...facts} = result;
      return {bytes: bytes ?? new Uint8Array(0), facts: {record: facts, missed: !bytes}};
    },
    async record(bytes, plan, source, facts) {
      if (!record(facts)) throw fail('JXL_INPUT', 'A finished job\'s record is a record.');
      if (facts.records !== undefined) {
        if (!Array.isArray(facts.records) || !facts.records.length) throw fail('JXL_INPUT', 'A finished job\'s records are a list.');
        let at = 0;
        const made = [];
        for (const {length, ...facts1} of facts.records) {
          if (length !== null && (!Number.isSafeInteger(length) || length < 1 || at + length > bytes.length))
            throw fail('JXL_INPUT', 'A finished job\'s records do not cover its file.');
          made.push(await rebuilt(length === null ? null : bytes.slice(at, at += length), facts1));
        }
        if (at !== bytes.length) throw fail('JXL_INPUT', 'A finished job\'s records do not cover its file.');
        return made;
      }
      if (typeof facts.missed !== 'boolean' || facts.missed && bytes.length) throw fail('JXL_INPUT', 'A finished job\'s record does not describe its file.');
      return rebuilt(facts.missed ? null : bytes, facts.record);
    }});
}
