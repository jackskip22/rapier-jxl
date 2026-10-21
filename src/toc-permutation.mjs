// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {ceilLog2, floorLog2} from './bits.mjs';
import {buildCode, canonicalCodes, uintConfig, countToken, writeHybrid, writeHistograms} from './prefix.mjs';

const invalid = message => fault('JXL_FRAMING', message);
const need = (condition, message = 'Invalid JPEG XL TOC permutation.') => { if (!condition) throw invalid(message); };
const CONFIG = uintConfig(0);

function available(size) {
  const tree = new Uint32Array(size + 1);
  for (let i = 1; i <= size; i++) tree[i] = i & -i;
  const remove = value => { for (let i = value + 1; i <= size; i += i & -i) tree[i]--; };
  return {
    rank(value) { let rank = 0; for (let i = value; i; i -= i & -i) rank += tree[i]; remove(value); return rank; },
    select(rank) {
      let value = 0;
      for (let step = 1 << floorLog2(size); step; step >>= 1) {
        const next = value + step;
        if (next <= size && tree[next] <= rank) { value = next; rank -= tree[next]; }
      }
      need(value < size); remove(value); return value;
    },
  };
}

export function writeTOCPermutation(writer, permutation) {
  if (permutation.every((value, index) => value === index)) { writer.write(1, 0); return; }
  writer.write(1, 1);
  const unused = available(permutation.length), ranks = permutation.map(value => unused.rank(value));
  let end = ranks.length; while (end && ranks[end - 1] === 0) end--;
  const values = [end, ...ranks.slice(0, end)], frequencies = new Uint32Array(18);
  for (const value of values) countToken(CONFIG, value, frequencies);
  const code = buildCode(frequencies);
  writeHistograms(writer, {contextMap: new Uint8Array(8), histograms: [{config: CONFIG, code}]});
  for (const value of values) writeHybrid(writer, code, CONFIG, value);
}

function symbolReader(lengths, explicit) {
  const codes = explicit ?? canonicalCodes(lengths), byLength = [];
  let used = 0, only = 0, max = 0;
  for (let symbol = 0; symbol < lengths.length; symbol++) if (lengths[symbol]) {
    const length = lengths[symbol]; (byLength[length] ??= new Map()).set(codes[symbol], symbol);
    used++; only = symbol; max = Math.max(max, length);
  }
  need(used > 0);
  if (used === 1) return () => only;
  return reader => {
    let bits = 0;
    for (let length = 1; length <= max; length++) {
      bits += reader.read(1) << (length - 1);
      const value = byLength[length]?.get(bits); if (value !== undefined) return value;
    }
    throw invalid('Invalid permutation prefix code.');
  };
}

function readPrefix(reader, size) {
  if (size === 1) return () => 0;
  const lengths = new Uint8Array(size), form = reader.read(2);
  if (form === 1) {
    const count = reader.read(2) + 1, symbols = Array.from({length: count}, () => reader.read(ceilLog2(size)));
    need(new Set(symbols).size === count && symbols.every(value => value < size));
    if (count === 1) return () => symbols[0];
    const depths = count === 2 ? [1, 1] : count === 3 ? [1, 2, 2] : reader.read(1) ? [1, 2, 3, 3] : [2, 2, 2, 2];
    for (let i = 0; i < count; i++) lengths[symbols[i]] = depths[i];
  } else {
    const order = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const fixed = symbolReader([2, 4, 3, 2, 2, 4], [0, 7, 3, 2, 1, 15]), codeLengths = new Uint8Array(18);
    let space = 32;
    for (let i = form; i < order.length && space > 0; i++) {
      const length = fixed(reader); codeLengths[order[i]] = length; if (length) space -= 32 >> length;
    }
    need(space === 0);
    const next = symbolReader(codeLengths); let at = 0, previous = 8, repeated = -1, repeat = 0;
    space = 32768;
    while (at < size && space > 0) {
      const symbol = next(reader);
      if (symbol < 16) {
        lengths[at++] = symbol; if (symbol) { previous = symbol; space -= 32768 >> symbol; }
        repeated = -1; repeat = 0;
      } else {
        const value = symbol === 16 ? previous : 0, bits = symbol === 16 ? 2 : 3;
        if (value !== repeated) repeat = 0;
        const old = repeat; repeat = (repeat ? (repeat - 2) * (1 << bits) : 0) + reader.read(bits) + 3;
        const amount = repeat - old; need(amount >= 0 && at + amount <= size);
        lengths.fill(value, at, at + amount); at += amount; repeated = value;
        if (value) space -= amount * (32768 >> value);
      }
      need(space >= 0);
    }
    need(space === 0);
  }
  return symbolReader(lengths);
}

export function readTOCPermutation(reader, size) {
  need(Number.isInteger(size) && size >= 1 && size <= 65536);
  need(reader.read(1) === 0, 'Delivery reads prefix permutations without LZ77.');
  need(reader.read(1) === 1 && reader.read(2) === 0, 'Delivery reads a single shared permutation histogram.');
  need(reader.read(1) === 1, 'Delivery reads prefix-coded permutations; ANS permutations are not supported.');
  need(reader.read(4) === 0, 'Delivery reads hybrid integer configuration 0,0,0.');
  const alphabet = reader.read(1) ? (bits => (1 << bits) + reader.read(bits) + 1)(reader.read(4)) : 1;
  need(alphabet <= 18);
  const symbol = readPrefix(reader, alphabet), value = () => {
    const token = symbol(reader); return token === 0 ? 0 : (1 << (token - 1)) + reader.read(token - 1);
  };
  const end = value(); need(end <= size);
  const unused = available(size), permutation = [];
  for (let i = 0; i < size; i++) {
    const rank = i < end ? value() : 0; need(rank < size - i); permutation.push(unused.select(rank));
  }
  return permutation;
}
