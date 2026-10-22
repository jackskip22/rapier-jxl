// SPDX-License-Identifier: MIT
import {BitWriter, floorLog2, ceilLog2} from './bits.mjs';
import {buildCode, canonicalCodes, writePrefixCode} from './prefix.mjs';
import {fault} from './fault.mjs';

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
  const maximum = options.maxOutputLength ?? Number.MAX_SAFE_INTEGER;
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

function matcher(data) {
  const heads = new Int32Array(65536).fill(-1), previous = new Int32Array(65536).fill(-1);
  const hash = at => Math.imul((data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24), 0x1e35a7bd) >>> 16;
  return {
    insert(at) { if (at + 3 < data.length) { const key = hash(at); previous[at & 65535] = heads[key]; heads[key] = at; } },
    find(at, end) {
      if (at + 4 > end) return {length: 0, distance: 0};
      let probe = heads[hash(at)], length = 3, distance = 0, attempts = 32;
      const oldest = Math.max(0, at - 65520), available = end - at;
      while (probe >= oldest && attempts--) {
        if (data[probe] === data[at] && data[probe + 1] === data[at + 1] && data[probe + 2] === data[at + 2] && data[probe + length] === data[at + length]) {
          let count = 3; while (count < available && data[probe + count] === data[at + count]) count++;
          if (count > length) { length = count; distance = at - probe; if (length === available) break; }
        }
        const next = previous[probe & 65535]; if (next >= probe) break; probe = next;
      }
      return {length: distance ? length : 0, distance};
    },
  };
}

function commandsFor(data, start, end, matches) {
  const commands = [], literalFrequencies = new Uint32Array(256), commandFrequencies = new Uint32Array(704), distanceFrequencies = new Uint32Array(64);
  let at = start, literals = start;
  const push = (position, count, distance) => {
    const insert = position - literals, insertCode = lengthCode(insert, INSERT_BASE), copyCode = lengthCode(count || 2, COPY_BASE);
    const code = COMMAND_GROUP[(insertCode >> 3) * 3 + (copyCode >> 3)] + ((insertCode & 7) << 3) + (copyCode & 7);
    const command = {start: literals, insert, count, insertCode, copyCode, code};
    for (let i = literals; i < position; i++) literalFrequencies[data[i]]++;
    if (count) {
      const bits = floorLog2(distance + 3) - 1, high = (distance + 3) >>> bits & 1;
      command.distanceCode = 16 + 2 * (bits - 1) + high; command.distanceBits = bits;
      command.distanceExtra = distance - ((2 + high) * (1 << bits) - 3); distanceFrequencies[command.distanceCode]++;
    }
    commands.push(command); commandFrequencies[code]++;
  };
  while (at < end) {
    const match = matches.find(at, end); matches.insert(at);
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
function compressedBlock(data, start, end, matches) {
  const plan = commandsFor(data, start, end, matches), writer = new BitWriter();
  blockHeader(writer, end - start, 0);
  writer.write(3, 0);
  writer.write(6, 0);
  writer.write(2, 0);
  writer.write(2, 0);
  for (const code of [plan.literal, plan.command, plan.distance]) writePrefixCode(writer, code);
  for (const command of plan.commands) {
    symbol(writer, plan.command, command.code);
    writer.write(INSERT_BITS[command.insertCode], command.insert - INSERT_BASE[command.insertCode]);
    writer.write(COPY_BITS[command.copyCode], (command.count || 2) - COPY_BASE[command.copyCode]);
    for (let at = command.start; at < command.start + command.insert; at++) symbol(writer, plan.literal, data[at]);
    if (command.count) { symbol(writer, plan.distance, command.distanceCode); writer.write(command.distanceBits, command.distanceExtra); }
  }
  return writer;
}

export function compressBrotli(bytes, options = {}) {
  const maximum = admission(bytes, options), writer = new BitWriter(), matches = bytes.length ? matcher(bytes) : null;
  writer.write(1, 0);
  for (let start = 0; start < bytes.length; start += 65536) {
    const end = Math.min(bytes.length, start + 65536), compressed = compressedBlock(bytes, start, end, matches);
    const rawBits = 20 + ((8 - (writer.bitLength + 20) % 8) % 8) + (end - start) * 8;
    const chosenBits = Math.min(rawBits, compressed.bitLength);
    if (Math.ceil((writer.bitLength + chosenBits + 2) / 8) > maximum) throw tooLarge();
    if (compressed.bitLength < rawBits) writer.append(compressed);
    else {
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
function distanceValue(reader, code, history) {
  if (code < 4) return history[code];
  if (code < 16) { const group = code < 10 ? 0 : 1, delta = code < 10 ? code - 4 : code - 10; return history[group] + ((delta & 1) ? 1 : -1) * ((delta >> 1) + 1); }
  const bits = 1 + ((code - 16) >> 1); return (2 + (code & 1)) * (1 << bits) - 3 + reader.read(bits);
}

export function decompressBrotli(bytes, options = {}) {
  const maximum = admission(bytes, options), reader = new Reader(bytes), window = (1 << windowBits(reader)) - 16;
  const history = [4,11,15,16]; let output = new Uint8Array(0), at = 0, last = false;
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
    need(reader.read(1) === 0 && reader.read(1) === 0 && reader.read(1) === 0, 'multiple block types require a full decoder.');
    need(reader.read(6) === 0, 'postfix and direct distance codes require a full decoder.');
    reader.read(2);
    need(reader.read(1) === 0 && reader.read(1) === 0, 'multiple context trees require a full decoder.');
    const literal = readTree(reader, 256), command = readTree(reader, 704), distance = readTree(reader, 64);
    while (at < end) {
      const code = command(reader), group = code >> 6, insertCode = INSERT_GROUP[group] + ((code >> 3) & 7), copyCode = COPY_GROUP[group] + (code & 7);
      const insert = INSERT_BASE[insertCode] + reader.read(INSERT_BITS[insertCode]), copy = COPY_BASE[copyCode] + reader.read(COPY_BITS[copyCode]);
      need(insert <= end - at, 'literal run exceeds the meta-block.');
      for (let i = 0; i < insert; i++) output[at++] = literal(reader);
      if (at === end) break;
      const distanceCode = code < 128 ? 0 : distance(reader), backward = distanceValue(reader, distanceCode, history);
      need(backward > 0, 'backward distance must be positive.');
      need(backward <= Math.min(window, at), 'static dictionary references require a full decoder.');
      need(copy <= end - at, 'copy run exceeds the meta-block.');
      if (distanceCode) { history.pop(); history.unshift(backward); }
      for (let i = 0; i < copy; i++, at++) output[at] = output[at - backward];
    }
  }
  reader.pad(); need(reader.pos === bytes.length * 8, 'bytes follow the final meta-block.'); return output.slice(0, at);
}
