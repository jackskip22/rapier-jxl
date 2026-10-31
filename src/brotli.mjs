// SPDX-License-Identifier: MIT
import {BitWriter, floorLog2, ceilLog2} from './bits.mjs';
import {buildCode, canonicalCodes, writePrefixCode} from './prefix.mjs';
import {fault} from './fault.mjs';
import {populationBits} from './entropy.mjs';

const invalid = message => fault('JXL_INPUT', 'Portable Brotli: ' + message);
const need = (value, message = 'invalid compressed data.') => { if (!value) throw invalid(message); };
const tooLarge = () => fault('JXL_SIZE', 'The Brotli result exceeds maxOutputLength.');
const INSERT_BITS = [0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,12,14,24];
const COPY_BITS = [0,0,0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,24];
const INSERT_GROUP = [0,0,0,0,8,8,0,16,8,16,16], COPY_GROUP = [0,8,0,8,0,8,16,0,16,8,16];
const COMMAND_GROUP = [128,192,384,256,320,512,448,576,640];
const bases = (bits, start) => bits.map(count => { const value = start; start += 1 << count; return value; });
const INSERT_BASE = bases(INSERT_BITS, 0), COPY_BASE = bases(COPY_BITS, 2);

function admission(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw invalid('bytes are a Uint8Array.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('options are an object.');
  const maximum = options.maxOutputLength ?? 67108864;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw invalid('maxOutputLength is a nonnegative safe integer.');
  return maximum;
}
function lengthCode(length, base) {
  let low = 0, high = base.length;
  while (low + 1 < high) { const middle = (low + high) >> 1; if (length < base[middle]) high = middle; else low = middle; }
  return low;
}
function tree(frequencies, alphabetSize) {
  if (!frequencies.some(value => value)) frequencies[0] = 1;
  return {...buildCode(frequencies), alphabetSize};
}
const symbol = (writer, code, value) => writer.write(code.lengths[value], code.codes[value]);

function matcher(data, windowBits) {
  const span = 1 << Math.min(windowBits, Math.max(16, ceilLog2(data.length))), mask = span - 1, reach = (1 << windowBits) - 16;
  const heads = new Int32Array(65536).fill(-1), previous = new Int32Array(span).fill(-1);
  const hash = at => Math.imul((data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24), 0x1e35a7bd) >>> 16;
  return {
    history: [4, 11, 15, 16],
    insert(at) { if (at + 3 < data.length) { const key = hash(at); previous[at & mask] = heads[key]; heads[key] = at; } },
    find(at, end, cache) {
      if (at + 4 > end) return {length: 0, distance: 0};
      let probe = heads[hash(at)], length = 3, distance = 0, attempts = 32;
      const oldest = Math.max(0, at - reach), available = end - at;
      while (probe >= oldest && attempts--) {
        if (data[probe] === data[at] && data[probe + 1] === data[at + 1] && data[probe + 2] === data[at + 2] && data[probe + length] === data[at + length]) {
          let count = 3; while (count < available && data[probe + count] === data[at + count]) count++;
          if (count > length) { length = count; distance = at - probe; if (length === available) break; }
        }
        const next = previous[probe & mask]; if (next >= probe) break; probe = next;
      }
      if (cache) for (const d of this.history) {
        if (d > at - oldest || d === distance) continue;
        let count = 0; while (count < available && data[at - d + count] === data[at + count]) count++;
        if (count > 3 && count >= length) { length = count; distance = d; }
      }
      return {length: distance ? length : 0, distance};
    },
  };
}

function shortCode(history, distance) {
  for (let k = 0; k < 4; k++) if (history[k] === distance) return k;
  for (let c = 4; c < 16; c++) {
    const delta = c < 10 ? c - 4 : c - 10;
    if (history[c < 10 ? 0 : 1] + ((delta & 1) ? 1 : -1) * ((delta >> 1) + 1) === distance) return c;
  }
  return -1;
}
function commandsFor(data, start, end, matches, cache) {
  const commands = [], literalFrequencies = new Uint32Array(256), commandFrequencies = new Uint32Array(704), distanceFrequencies = new Uint32Array(64);
  let at = start, literals = start;
  const push = (position, count, distance) => {
    const insert = position - literals, insertCode = lengthCode(insert, INSERT_BASE), copyCode = lengthCode(count || 2, COPY_BASE);
    const code = COMMAND_GROUP[(insertCode >> 3) * 3 + (copyCode >> 3)] + ((insertCode & 7) << 3) + (copyCode & 7);
    const command = {start: literals, insert, count, insertCode, copyCode, code};
    for (let i = literals; i < position; i++) literalFrequencies[data[i]]++;
    const short = count && cache ? shortCode(matches.history, distance) : -1;
    if (short === 0 && insertCode < 8 && copyCode < 16) {
      command.code = (copyCode >= 8 ? 64 : 0) + (insertCode << 3) + (copyCode & 7); command.implicit = true;
    } else if (short >= 0) {
      command.distanceCode = short; command.distanceBits = 0; command.distanceExtra = 0; distanceFrequencies[short]++;
    } else if (count) {
      const bits = floorLog2(distance + 3) - 1, high = (distance + 3) >>> bits & 1;
      command.distanceCode = 16 + 2 * (bits - 1) + high; command.distanceBits = bits;
      command.distanceExtra = distance - ((2 + high) * (1 << bits) - 3); distanceFrequencies[command.distanceCode]++;
    }
    if (count && short !== 0) { matches.history.pop(); matches.history.unshift(distance); }
    commands.push(command); commandFrequencies[command.code]++;
  };
  while (at < end) {
    const match = matches.find(at, end, cache); matches.insert(at);
    if (match.length < 4) { at++; continue; }
    push(at, match.length, match.distance);
    for (let i = at + 1; i < at + match.length; i++) matches.insert(i);
    at += match.length; literals = at;
  }
  if (literals < end) push(end, 0, 0);
  return {commands, literal: tree(literalFrequencies, 256), command: tree(commandFrequencies, 704), distance: tree(distanceFrequencies, 64)};
}

function blockHeader(writer, length, uncompressed) {
  writer.write(1, 0); writer.write(2, 0); writer.write(16, length - 1); writer.write(1, uncompressed);
}
function histogramBits(a, b) {
  let total = 0, bits = 0, used = 0;
  for (let s = 0; s < 256; s++) { const f = b ? a[s] + b[s] : a[s]; if (f) { total += f; bits -= populationBits(f); used++; } }
  return bits + populationBits(total) + (used > 1 ? 16 + 5 * used : 8);
}
function literalModel(data, commands, kernels) {
  const single = new Uint32Array(256);
  for (const command of commands) for (let at = command.start; at < command.start + command.insert; at++) single[data[at]]++;
  let best = {mode: 0, map: new Uint8Array(64), bits: histogramBits(single), trees: 1, histograms: [single]};
  for (let mode = 0; mode < 4; mode++) {
    const histograms = Array.from({length: 64}, () => new Uint32Array(256));
    for (const command of commands) for (let at = command.start; at < command.start + command.insert; at++)
      histograms[literalContext(mode, at ? data[at - 1] : 0, at > 1 ? data[at - 2] : 0)][data[at]]++;
    const clusters = histograms.map((freqs, i) => ({freqs, contexts: [i], bits: histogramBits(freqs)})).filter(c => c.freqs.some(Boolean));
    if (clusters.length < 2) continue;
    let kept;
    if (kernels) kept = kernels.literalClusters(clusters);
    else {
      const n = clusters.length, gains = new Float64Array(n * n), alive = new Uint8Array(n).fill(1);
      const gain = (i, j) => clusters[i].bits + clusters[j].bits - histogramBits(clusters[i].freqs, clusters[j].freqs);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) gains[i * n + j] = gain(i, j);
      let count = n;
      while (count > 1) {
        let pi = -1, pj = -1, pg = -Infinity;
        for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && gains[i * n + j] > pg) { pg = gains[i * n + j]; pi = i; pj = j; }
        if (pg <= 0 && count <= 256) break;
        const a = clusters[pi], b = clusters[pj];
        for (let s = 0; s < 256; s++) a.freqs[s] += b.freqs[s];
        a.contexts.push(...b.contexts); a.bits = histogramBits(a.freqs); alive[pj] = 0; count--;
        for (let k = 0; k < n; k++) if (alive[k] && k !== pi) gains[Math.min(k, pi) * n + Math.max(k, pi)] = gain(Math.min(k, pi), Math.max(k, pi));
      }
      kept = clusters.filter((_, i) => alive[i]);
    }
    const map = new Uint8Array(64);
    kept.forEach((cluster, k) => { for (const c of cluster.contexts) map[c] = k; });
    const bits = kept.reduce((total, c) => total + c.bits, 0) + (kept.length > 1 ? 64 * Math.max(1, ceilLog2(kept.length)) : 0);
    if (bits < best.bits) best = {mode, map, bits, trees: kept.length, histograms: kept.map(c => c.freqs)};
  }
  return best;
}
function writeVarLenUint8(writer, value) {
  if (!value) { writer.write(1, 0); return; }
  const n = floorLog2(value); writer.write(1, 1); writer.write(3, n); writer.write(n, value - (1 << n));
}
function compressedBlock(data, start, end, matches, contexts, kernels) {
  const plan = commandsFor(data, start, end, matches, contexts), single = writeBlock(data, start, end, plan, {mode: 0, map: new Uint8Array(64), trees: 1, histograms: [plan.literal]});
  if (!contexts) return single;
  const model = literalModel(data, plan.commands, kernels);
  if (model.trees === 1) return single;
  const modelled = writeBlock(data, start, end, plan, model);
  return single.bitLength <= modelled.bitLength ? single : modelled;
}
function writeBlock(data, start, end, plan, model) {
  const writer = new BitWriter();
  const literals = model.histograms.map(freqs => freqs.lengths ? freqs : tree(Uint32Array.from(freqs), 256));
  blockHeader(writer, end - start, 0);
  writer.write(3, 0);
  writer.write(6, 0);
  writer.write(2, model.mode);
  writeVarLenUint8(writer, model.trees - 1);
  if (model.trees > 1) {
    const counts = new Uint32Array(model.trees);
    for (const k of model.map) counts[k]++;
    const code = tree(counts, model.trees);
    writer.write(1, 0); writePrefixCode(writer, code);
    for (const k of model.map) symbol(writer, code, k);
    writer.write(1, 0);
  }
  writer.write(1, 0);
  for (const code of [...literals, plan.command, plan.distance]) writePrefixCode(writer, code);
  for (const command of plan.commands) {
    symbol(writer, plan.command, command.code);
    writer.write(INSERT_BITS[command.insertCode], command.insert - INSERT_BASE[command.insertCode]);
    writer.write(COPY_BITS[command.copyCode], (command.count || 2) - COPY_BASE[command.copyCode]);
    for (let at = command.start; at < command.start + command.insert; at++)
      symbol(writer, literals[model.trees > 1 ? model.map[literalContext(model.mode, at ? data[at - 1] : 0, at > 1 ? data[at - 2] : 0)] : 0], data[at]);
    if (command.count && !command.implicit) { symbol(writer, plan.distance, command.distanceCode); writer.write(command.distanceBits, command.distanceExtra); }
  }
  return writer;
}

export function compressBrotli(bytes, options = {}) {
  const maximum = admission(bytes, options);
  const windowBits = options.literalContexts ? Math.min(24, Math.max(16, ceilLog2(bytes.length + 16))) : 16;
  const writer = new BitWriter(), matches = bytes.length ? matcher(bytes, windowBits) : null;
  if (windowBits === 16) writer.write(1, 0);
  else if (windowBits === 17) { writer.write(1, 1); writer.write(3, 0); writer.write(3, 0); }
  else { writer.write(1, 1); writer.write(3, windowBits - 17); }
  for (let start = 0; start < bytes.length; start += 65536) {
    const ring = matches?.history.slice(), end = Math.min(bytes.length, start + 65536), compressed = compressedBlock(bytes, start, end, matches, options.literalContexts, options.kernels);
    const rawBits = 20 + ((8 - (writer.bitLength + 20) % 8) % 8) + (end - start) * 8;
    const chosenBits = Math.min(rawBits, compressed.bitLength);
    if (Math.ceil((writer.bitLength + chosenBits + 2) / 8) > maximum) throw tooLarge();
    if (compressed.bitLength < rawBits) writer.append(compressed);
    else {
      matches.history = ring;
      blockHeader(writer, end - start, 1); writer.zeroPadToByte();
      writer.append({bytes: bytes.subarray(start, end), at: end - start, pending: 0, acc: 0});
    }
  }
  writer.write(2, 3);
  const output = writer.finish(); if (output.length > maximum) throw tooLarge(); return output;
}

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  read(count) {
    need(this.pos + count <= this.bytes.length * 8, 'the compressed stream is truncated.');
    let value = 0, shift = 0;
    while (count) {
      const available = Math.min(count, 8 - (this.pos & 7));
      value += ((this.bytes[this.pos >> 3] >> (this.pos & 7)) & ((1 << available) - 1)) * (1 << shift);
      this.pos += available; count -= available; shift += available;
    }
    return value;
  }
  pad() { need(this.read((8 - this.pos % 8) % 8) === 0, 'padding bits must be zero.'); }
}
function prefixReader(lengths, explicit) {
  const codes = explicit ?? canonicalCodes(lengths), levels = []; let used = 0, only = 0, maximum = 0, space = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    const count = lengths[i]; need(count <= 15);
    (levels[count] ??= new Map()).set(codes[i], i); maximum = Math.max(maximum, count); space += 32768 >> count; used++; only = i;
  }
  need(used > 0 && (used === 1 || space === 32768), 'invalid prefix-code lengths.');
  if (used === 1) return () => only;
  return reader => {
    let value = 0;
    for (let count = 1; count <= maximum; count++) {
      value |= reader.read(1) << (count - 1); const symbol = levels[count]?.get(value); if (symbol !== undefined) return symbol;
    }
    throw invalid('invalid prefix symbol.');
  };
}
function readTree(reader, alphabet) {
  const form = reader.read(2), lengths = new Uint8Array(alphabet);
  if (form === 1) {
    const count = reader.read(2) + 1, symbols = Array.from({length: count}, () => reader.read(ceilLog2(alphabet)));
    need(new Set(symbols).size === count && symbols.every(value => value < alphabet), 'invalid simple prefix tree.');
    if (count === 1) return () => symbols[0];
    const depths = count === 2 ? [1,1] : count === 3 ? [1,2,2] : reader.read(1) ? [1,2,3,3] : [2,2,2,2];
    for (let i = 0; i < count; i++) lengths[symbols[i]] = depths[i];
  } else {
    const order = [1,2,3,4,0,5,17,6,16,7,8,9,10,11,12,13,14,15], codeLengths = new Uint8Array(18);
    const fixed = prefixReader([2,4,3,2,2,4], [0,7,3,2,1,15]); let space = 32, used = 0;
    for (let i = form; i < order.length && space > 0; i++) {
      const length = fixed(reader); codeLengths[order[i]] = length;
      if (length) { space -= 32 >> length; used++; }
    }
    need(space === 0 || used === 1, 'invalid code-length prefix tree.');
    const next = prefixReader(codeLengths); let at = 0, previous = 8, repeated = -1, repeat = 0;
    space = 32768;
    while (at < alphabet && space > 0) {
      const value = next(reader);
      if (value < 16) {
        lengths[at++] = value; if (value) { previous = value; space -= 32768 >> value; }
        repeated = -1; repeat = 0;
      } else {
        const length = value === 16 ? previous : 0, bits = value === 16 ? 2 : 3;
        if (length !== repeated) repeat = 0;
        const old = repeat; repeat = (repeat ? (repeat - 2) * (1 << bits) : 0) + reader.read(bits) + 3;
        const amount = repeat - old; need(amount > 0 && at + amount <= alphabet, 'prefix repeat exceeds the alphabet.');
        lengths.fill(length, at, at + amount); at += amount; repeated = length;
        if (length) space -= amount * (32768 >> length);
      }
      need(space >= 0, 'oversubscribed prefix tree.');
    }
    need(space === 0, 'incomplete prefix tree.');
  }
  return prefixReader(lengths);
}
function windowBits(reader) {
  if (!reader.read(1)) return 16;
  const high = reader.read(3); if (high) return 17 + high;
  const low = reader.read(3); need(low !== 1, 'invalid window size.'); return low ? 8 + low : 17;
}
function distanceValue(reader, code, history, postfix = 0, direct = 0) {
  if (code < 4) return history[code];
  if (code < 16) { const group = code < 10 ? 0 : 1, delta = code < 10 ? code - 4 : code - 10; return history[group] + ((delta & 1) ? 1 : -1) * ((delta >> 1) + 1); }
  if (code < 16 + direct) return code - 15;
  const d = code - direct - 16, bits = 1 + (d >> (postfix + 1)), offset = ((2 + ((d >> postfix) & 1)) << bits) - 4;
  return ((offset + reader.read(bits)) << postfix) + (d & ((1 << postfix) - 1)) + direct + 1;
}

const DICT_BITS = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5, 0, 0, 0, 0, 0, 0, 0];
const DICT_OFFSETS = [0, 0, 0, 0, 0, 4096, 9216, 21504, 35840, 44032, 53248, 63488, 74752, 87040, 93696, 100864, 104704, 106752, 108928, 113536, 115968, 118528, 119872, 121280, 122016, 122784, 122784, 122784, 122784, 122784, 122784, 122784];
const AFFIX = Uint8Array.from([1,32,2,44,32,8,32,111,102,32,116,104,101,32,4,32,111,102,32,2,115,32,1,46,5,32,97,110,100,32,4,32,105,110,32,1,34,4,32,116,111,32,2,34,62,1,10,2,46,32,1,93,5,32,102,111,114,32,3,32,97,32,6,32,116,104,97,116,32,1,39,6,32,119,105,116,104,32,6,32,102,114,111,109,32,4,32,98,121,32,1,40,6,46,32,84,104,101,32,4,32,111,110,32,4,32,97,115,32,4,32,105,115,32,4,105,110,103,32,2,10,9,1,58,3,101,100,32,2,61,34,4,32,97,116,32,3,108,121,32,1,44,2,61,39,5,46,99,111,109,47,7,46,32,84,104,105,115,32,5,32,110,111,116,32,3,101,114,32,3,97,108,32,4,102,117,108,32,4,105,118,101,32,5,108,101,115,115,32,4,101,115,116,32,4,105,122,101,32,2,194,160,4,111,117,115,32,5,32,116,104,101,32,2,101,32,0]);
const AFFIX_AT = [0,2,5,14,19,22,24,30,35,37,42,45,47,50,52,58,62,69,71,78,85,90,92,99,104,109,114,119,122,124,128,131,136,140,142,145,151,159,165,169,173,178,183,189,194,199,202,207,213,216];
const WORD_FORMS = Uint8Array.from([49,0,49,49,0,0,0,0,0,49,12,49,49,10,0,49,0,47,0,0,49,4,0,0,49,0,3,49,10,49,49,0,6,49,13,49,49,1,49,1,0,0,49,0,1,0,10,0,49,0,7,49,0,9,48,0,0,49,0,8,49,0,5,49,0,10,49,0,11,49,3,49,49,0,13,49,0,14,49,14,49,49,2,49,49,0,15,49,0,16,0,10,49,49,0,12,5,0,49,0,0,1,49,15,49,49,0,18,49,0,17,49,0,19,49,0,20,49,16,49,49,17,49,47,0,49,49,4,49,49,0,22,49,11,49,49,0,23,49,0,24,49,0,25,49,7,49,49,1,26,49,0,27,49,0,28,0,0,12,49,0,29,49,20,49,49,18,49,49,6,49,49,0,21,49,10,1,49,8,49,49,0,31,49,0,32,47,0,3,49,5,49,49,9,49,0,10,1,49,10,8,5,0,21,49,11,0,49,10,10,49,0,30,0,0,5,35,0,49,47,0,2,49,10,17,49,0,36,49,0,33,5,0,0,49,10,21,49,10,5,49,0,37,0,0,30,49,0,38,0,11,0,49,0,39,0,11,49,49,0,34,49,11,8,49,10,12,0,0,21,49,0,40,0,10,12,49,0,41,49,0,42,49,11,17,49,0,43,0,10,5,49,11,10,0,0,34,49,10,33,49,0,44,49,11,5,45,0,49,0,0,33,49,10,30,49,11,30,49,0,46,49,11,1,49,10,34,0,10,33,0,11,30,0,11,1,49,11,33,49,11,21,49,11,12,0,11,5,49,11,34,0,11,12,0,10,30,0,11,34,0,10,34]);
function affix(id) { const at = AFFIX_AT[id], n = AFFIX[at]; return AFFIX.subarray(at + 1, at + 1 + n); }
function upperStep(word, at) {
  const b = word[at];
  if (b < 0xC0) { if (b >= 97 && b <= 122) word[at] ^= 32; return 1; }
  if (b < 0xE0) { word[at + 1] ^= 32; return 2; }
  word[at + 2] ^= 5; return 3;
}
function dictionaryWord(dict, offset, length, form) {
  if (!form) return dict.subarray(offset, offset + length);
  const prefix = affix(WORD_FORMS[form * 3]), kind = WORD_FORMS[form * 3 + 1], suffix = affix(WORD_FORMS[form * 3 + 2]);
  let skip = 0, keep = length;
  if (kind <= 9) keep -= kind;
  else if (kind >= 12 && kind <= 20) { skip = kind - 11; keep -= skip; }
  need(skip >= 0 && keep >= 0, 'invalid dictionary transform.');
  const out = new Uint8Array(prefix.length + keep + suffix.length);
  out.set(prefix); out.set(dict.subarray(offset + skip, offset + skip + keep), prefix.length); out.set(suffix, prefix.length + keep);
  const start = prefix.length;
  if (kind === 10) upperStep(out, start);
  else if (kind === 11) for (let i = 0, left = keep; left > 0;) { const step = upperStep(out, start + i); i += step; left -= step; }
  return out;
}

function varLenUint8(reader) {
  if (reader.read(1) === 0) return 0;
  const bits = reader.read(3);
  return bits === 0 ? 1 : (1 << bits) + reader.read(bits);
}
const BLOCK_LEN_OFFSET = [1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433, 16625];
const BLOCK_LEN_BITS = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];
function blockLength(reader, tree) {
  const code = tree(reader);
  need(code < 26, 'invalid block length symbol.');
  return BLOCK_LEN_OFFSET[code] + reader.read(BLOCK_LEN_BITS[code]);
}
function inverseMoveToFront(values) {
  const list = Uint8Array.from({length: 256}, (_, i) => i);
  for (let i = 0; i < values.length; i++) {
    const index = values[i], value = list[index];
    values[i] = value;
    if (index) list.copyWithin(1, 0, index);
    list[0] = value;
  }
}
function brotliContextMap(reader, size) {
  const trees = varLenUint8(reader) + 1, map = new Uint8Array(size);
  if (trees === 1) return {trees, map};
  const runPrefix = reader.read(1) ? reader.read(4) + 1 : 0, symbols = readTree(reader, trees + runPrefix);
  for (let i = 0; i < size;) {
    const code = symbols(reader);
    if (code === 0) map[i++] = 0;
    else if (code > runPrefix) { need(code - runPrefix < trees, 'invalid context map item.'); map[i++] = code - runPrefix; }
    else {
      const reps = (1 << code) + reader.read(code);
      need(i + reps <= size, 'context map repeat exceeds the map.');
      i += reps;
    }
  }
  if (reader.read(1)) inverseMoveToFront(map);
  return {trees, map};
}
const CONTEXT_TEXT = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+PwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEBAQICAgIDAwMDBAQEBAUFBQUGBgYGBwcHBwgICAgJCQkJCgoKCgsLCwsMDAwMDQ0NDQ4ODg4PDw8PEBAQEBERERESEhISExMTExQUFBQVFRUVFhYWFhcXFxcYGBgYGRkZGRoaGhobGxsbHBwcHB0dHR0eHh4eHx8fHyAgICAhISEhIiIiIiMjIyMkJCQkJSUlJSYmJiYnJycnKCgoKCkpKSkqKioqKysrKywsLCwtLS0tLi4uLi8vLy8wMDAwMTExMTIyMjIzMzMzNDQ0NDU1NTU2NjY2Nzc3Nzg4ODg5OTk5Ojo6Ojs7Ozs8PDw8PT09PT4+Pj4/Pz8/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAEAAAAAAAAAAAAAAAAAAAAAAAACAwQDAwUDBAYHAwMIAwkDCwsLCwsLCwsLCwgIBgoHAwMMDQ0NDA0NDQwNDQ0NDQwNDQ0NDQwNDQ0NDQYDBwMDAw4PDw8ODw8PDg8PDw8PDg8PDw8PDg8PDw8PBgMHAwAAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQABAAEAAQIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQEBAQEBAQEBAQEBAQECAgICAgICAgICAQEBAQEBAQICAgICAgICAgICAgICAgICAgICAgICAgICAQEBAQEBAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMBAQEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAgICAgICAgICAgICAgICBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBggICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoMDAwMDAwMDAwMDAwMDAwOAABAQEBAQEBAQEBAQEBAQECAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQYGBgYGBgYGBgYGBgYGBgc=";
const CONTEXT = Uint8Array.from(atob(CONTEXT_TEXT), char => char.charCodeAt(0));
const literalContext = (mode, previous, older) => {
  const base = mode << 9;
  return CONTEXT[base + previous] | CONTEXT[base + 256 + older];
};
export function decompressBrotli(bytes, options = {}) {
  const maximum = admission(bytes, options), maxBlocks = options.maxBlocks ?? 65536;
  need(Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'maxBlocks is a positive safe integer.');
  const reader = new Reader(bytes), window = (1 << windowBits(reader)) - 16;
  const history = [4,11,15,16]; let output = new Uint8Array(0), at = 0, last = false, blocks = 0;
  const reserve = end => {
    if (end > maximum) throw tooLarge();
    if (end > output.length) {
      const capacity = Math.min(maximum, Math.max(end, output.length * 2));
      let next;
      try { next = new Uint8Array(capacity); }
      catch (error) { if (!(error instanceof RangeError) || capacity === end) throw error; next = new Uint8Array(end); }
      next.set(output.subarray(0, at)); output = next;
    }
  };
  while (!last) {
    if (++blocks > maxBlocks) throw fault('JXL_SIZE', 'The Brotli stream exceeds maxBlocks.');
    last = reader.read(1) === 1; if (last && reader.read(1)) break;
    const nibbles = reader.read(2) + 4;
    if (nibbles === 7) {
      need(reader.read(1) === 0, 'metadata reserved bit must be zero.');
      const count = reader.read(2), value = reader.read(count * 8);
      need(count <= 1 || value >= (1 << (8 * (count - 1))), 'noncanonical metadata length.');
      reader.pad(); const size = count ? value + 1 : 0;
      need(reader.pos / 8 + size <= bytes.length, 'metadata block is truncated.'); reader.pos += size * 8; continue;
    }
    const length = reader.read(4 * nibbles) + 1;
    need(nibbles === 4 || length > (1 << (4 * (nibbles - 1))), 'noncanonical meta-block length.');
    const end = at + length; reserve(end);
    if (!last && reader.read(1)) {
      reader.pad(); need(reader.pos / 8 + length <= bytes.length, 'stored block is truncated.');
      output.set(bytes.subarray(reader.pos / 8, reader.pos / 8 + length), at); reader.pos += length * 8; at = end; continue;
    }
    const categories = [0, 1, 2].map(() => {
      const numTypes = varLenUint8(reader) + 1;
      need(numTypes >= 1 && numTypes <= 256, 'invalid block-type count.');
      if (numTypes === 1) return {numTypes, length: 1 << 28, ring: [1, 0]};
      const typeTree = readTree(reader, numTypes + 2), lenTree = readTree(reader, 26);
      return {numTypes, length: blockLength(reader, lenTree), ring: [1, 0], typeTree, lenTree};
    });
    const switchBlock = category => {
      let symbol = category.typeTree(reader);
      let type = symbol === 0 ? category.ring[0] : symbol === 1 ? category.ring[1] + 1 : symbol - 2;
      if (type >= category.numTypes) type -= category.numTypes;
      category.ring[0] = category.ring[1]; category.ring[1] = type;
      category.length = blockLength(reader, category.lenTree);
    };
    const postfix = reader.read(2), direct = reader.read(4) << postfix;
    const contextModes = Uint8Array.from({length: categories[0].numTypes}, () => reader.read(2));
    const literalMap = brotliContextMap(reader, categories[0].numTypes << 6), distanceMap = brotliContextMap(reader, categories[2].numTypes << 2);
    const literal = Array.from({length: literalMap.trees}, () => readTree(reader, 256));
    const command = Array.from({length: categories[1].numTypes}, () => readTree(reader, 704));
    const distanceTrees = Array.from({length: distanceMap.trees}, () => readTree(reader, 16 + direct + (48 << postfix)));
    const [literalBlocks, commandBlocks, distanceBlocks] = categories;
    const useBlocks = category => category.numTypes > 1;
    while (at < end) {
      if (useBlocks(commandBlocks) && commandBlocks.length === 0) switchBlock(commandBlocks);
      const code = command[commandBlocks.ring[1]](reader), group = code >> 6, insertCode = INSERT_GROUP[group] + ((code >> 3) & 7), copyCode = COPY_GROUP[group] + (code & 7);
      if (useBlocks(commandBlocks)) commandBlocks.length--;
      const insert = INSERT_BASE[insertCode] + reader.read(INSERT_BITS[insertCode]), copy = COPY_BASE[copyCode] + reader.read(COPY_BITS[copyCode]);
      need(insert <= end - at, 'literal run exceeds the meta-block.');
      for (let i = 0; i < insert; i++) {
        if (useBlocks(literalBlocks) && literalBlocks.length === 0) switchBlock(literalBlocks);
        const type = literalBlocks.ring[1];
        const context = literalMap.trees === 1 ? 0 : literalContext(contextModes[type], at ? output[at - 1] : 0, at > 1 ? output[at - 2] : 0);
        output[at++] = literal[literalMap.map[(type << 6) + context]](reader);
        if (useBlocks(literalBlocks)) literalBlocks.length--;
      }
      if (at === end) break;
      let distanceCode = 0;
      if (code >= 128) {
        if (useBlocks(distanceBlocks) && distanceBlocks.length === 0) switchBlock(distanceBlocks);
        const context = distanceMap.trees === 1 ? 0 : copy > 4 ? 3 : copy - 2;
        distanceCode = distanceTrees[distanceMap.map[(distanceBlocks.ring[1] << 2) + context]](reader);
      }
      if (code >= 128 && useBlocks(distanceBlocks)) distanceBlocks.length--;
      const backward = distanceValue(reader, distanceCode, history, postfix, direct);
      need(backward > 0, 'backward distance must be positive.');
      const maxDistance = Math.min(window, at);
      if (backward > maxDistance) {
        const dict = options.dictionary;
        if (!dict) throw Object.assign(invalid('static dictionary references require a full decoder or the dictionary.'), {dictionary: true});
        need(backward <= 0x7ffffffc && copy >= 4 && copy <= 24 && DICT_BITS[copy], 'invalid static dictionary reference.');
        const shift = DICT_BITS[copy], address = backward - maxDistance - 1, form = address >>> shift;
        need(form < 121, 'invalid dictionary transform.');
        const word = dictionaryWord(dict, DICT_OFFSETS[copy] + (address & ((1 << shift) - 1)) * copy, copy, form);
        need(word.length <= end - at && !(word.length === 0 && backward <= 120), 'invalid dictionary transform.');
        output.set(word, at); at += word.length;
      } else {
        need(copy <= end - at, 'copy run exceeds the meta-block.');
        if (distanceCode) { history.pop(); history.unshift(backward); }
        for (let i = 0; i < copy; i++, at++) output[at] = output[at - backward];
      }
    }
  }
  reader.pad(); need(reader.pos === bytes.length * 8, 'bytes follow the final meta-block.'); return output.slice(0, at);
}
