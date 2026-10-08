// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BitWriter} from '../src/bits.mjs';
import {codeLengths, canonicalCodes, buildCode, writePrefixCode} from '../src/prefix.mjs';

// A sorted object queue provides an independent tree and traversal for the numeric representation.
function referenceLengths(freqs, limit) {
  const lengths = new Uint8Array(freqs.length), symbols = [];
  for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) symbols.push(i);
  if (symbols.length < 2) { if (symbols.length) lengths[symbols[0]] = 1; return lengths; }
  for (let floor = 1; ; floor *= 2) {
    const compare = (a, b) => a.weight - b.weight || a.order - b.order;
    const queue = symbols.map(symbol => ({weight: Math.max(freqs[symbol], floor), order: symbol, symbol})).sort(compare);
    let order = freqs.length, deepest = 0;
    while (queue.length > 1) {
      const left = queue.shift(), right = queue.shift();
      const node = {weight: left.weight + right.weight, order: order++, left, right};
      let low = 0, high = queue.length;
      while (low < high) { const mid = (low + high) >>> 1; if (compare(queue[mid], node) < 0) low = mid + 1; else high = mid; }
      queue.splice(low, 0, node);
    }
    function visit(node, depth) {
      if (node.symbol !== undefined) { lengths[node.symbol] = depth; deepest = Math.max(deepest, depth); }
      else { visit(node.left, depth + 1); visit(node.right, depth + 1); }
    }
    visit(queue[0], 0);
    if (deepest <= limit) return lengths;
  }
}

function compare(freqs, limit) {
  const actual = codeLengths(freqs, limit), expected = referenceLengths(freqs, limit);
  assert.deepEqual(actual, expected, `frequencies ${freqs}; limit ${limit}`);
  const code = buildCode(freqs);
  if (freqs.filter(f => f > 0).length <= 4) return;
  const lengths = referenceLengths(freqs, 15).subarray(0, code.alphabetSize);
  const reference = {...code, lengths, codes: canonicalCodes(lengths)}, a = new BitWriter(0), b = new BitWriter(0);
  writePrefixCode(a, code); writePrefixCode(b, reference);
  assert.equal(a.bitLength, b.bitLength);
  assert.deepEqual(a.finish(), b.finish());
}

test('prefix lengths preserve leaf, inner-node and flattened-frequency tie order', () => {
  assert.deepEqual(codeLengths([1, 1, 2, 2], 15), Uint8Array.of(2, 2, 2, 2));
  for (let size = 0; size <= 6; size++) {
    for (let word = 0; word < 4 ** size; word++) {
      let digits = word;
      const freqs = Array.from({length: size}, () => { const value = digits % 4; digits = Math.floor(digits / 4); return value; });
      compare(freqs, Math.max(1, Math.ceil(Math.log2(size))));
    }
  }
});

test('prefix lengths and headers preserve sparse, deep and full-width frequencies', () => {
  let state = 0x48c098ea;
  const next = () => (state ^= state << 13, state ^= state >>> 17, state ^= state << 5, state >>> 0);
  for (const size of [18, 33, 64, 257, 2049]) {
    const minimum = Math.ceil(Math.log2(size));
    const patterns = [
      () => 0,
      () => 1,
      i => i + 1,
      i => 2 ** Math.min(i, 30),
      () => next() % 4,
      () => next() % 65536,
      () => next(),
      i => Number.MAX_SAFE_INTEGER - i,
      i => Number.MAX_VALUE / (1 + i),
      () => next() % 8 / 4,
      () => next() % 8 === 0 ? next() : 0,
      () => Infinity,
    ];
    for (const pattern of patterns) {
      const freqs = Float64Array.from({length: size}, (_, i) => pattern(i));
      for (const limit of new Set([minimum, Math.max(minimum, 5), 15])) compare(freqs, limit);
    }
  }
});
