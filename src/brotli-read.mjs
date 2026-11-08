// SPDX-License-Identifier: MIT
import {BROTLI_TRANSFORMS} from './brotli-transforms.mjs';
export const INSERT_BITS = [0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,12,14,24];
export const COPY_BITS = [0,0,0,0,0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,7,8,9,10,24];
export const INSERT_GROUP = [0,0,0,0,8,8,0,16,8,16,16], COPY_GROUP = [0,8,0,8,0,8,16,0,16,8,16];
export const INSERT_BASE = [0], COPY_BASE = [2];
for (let i = 0; i < 23; i++) {
  INSERT_BASE.push(INSERT_BASE[i] + (1 << INSERT_BITS[i]));
  COPY_BASE.push(COPY_BASE[i] + (1 << COPY_BITS[i]));
}
const COUNT_BITS = [2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,6,6,7,8,9,10,11,12,13,24];
const COUNT_BASE = [];
for (let value = 1, i = 0; i < COUNT_BITS.length; i++) { COUNT_BASE.push(value); value += 1 << COUNT_BITS[i]; }
const WORD_BITS = [0,0,0,0,10,10,11,11,10,10,10,10,10,9,9,8,7,7,8,7,7,6,6,5,5], WORD_BASE = [0];
for (let i = 0; i < 24; i++) WORD_BASE.push(WORD_BASE[i] + (i < 4 ? 0 : i * (1 << WORD_BITS[i])));

const UTF8_FIRST = Uint8Array.from([0,0,0,0,0,0,0,0,0,4,4,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,12,16,12,12,20,12,16,24,28,12,12,32,12,36,12,44,44,44,44,44,44,44,44,44,44,32,32,24,40,28,12,12,48,52,52,52,48,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,48,52,52,52,52,52,24,12,28,12,12,12,56,60,60,60,56,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,56,60,60,60,60,60,24,12,28,12,0]);
const UTF8_PREVIOUS = Uint8Array.from({length:256}, (_,v) => v < 33 || v >= 127 && v < 224 ? 0 :
  v >= 224 || v >= 48 && v <= 57 || v >= 65 && v <= 90 ? 2 : v >= 97 && v <= 122 ? 3 : 1);
const SIGNED = Uint8Array.from({length:256}, (_,v) => !v ? 0 : v < 16 ? 1 : v < 64 ? 2 : v < 128 ? 3 : v < 192 ? 4 : v < 240 ? 5 : v < 255 ? 6 : 7);
export function literalContext(mode, previous, older) {
  if (mode === 0) return previous & 63;
  if (mode === 1) return previous >>> 2;
  if (mode === 3) return SIGNED[previous] * 8 + SIGNED[older];
  return (previous < 128 ? UTF8_FIRST[previous] : (previous >= 192 ? 2 : 0) + (previous & 1)) | UTF8_PREVIOUS[older];
}

export function brotliReader(readCode, readSymbol, requireValue, limit) {
  const count8 = r => r.read(1) ? (n => (1 << n) + r.read(n) + 1)(r.read(3)) : 1;
  const codeCount = (r, code) => { const n = readSymbol(r,code); return COUNT_BASE[n] + r.read(COUNT_BITS[n]); };
  class BlockTypes {
    constructor(r) {
      this.count = count8(r); this.current = 0; this.previous = 1; this.remaining = Infinity;
      if (this.count > 1) {
        this.types = readCode(r,this.count + 2); this.lengths = readCode(r,26);
        this.remaining = codeCount(r, this.lengths);
      }
    }
    next(r) {
      if (!this.remaining) {
        const code = readSymbol(r,this.types);
        const type = code === 0 ? this.previous : code === 1 ? (this.current + 1) % this.count : code - 2;
        requireValue(type < this.count, 'Invalid Brotli block type.',r);
        this.previous = this.current; this.current = type; this.remaining = codeCount(r, this.lengths);
      }
      this.remaining--; return this.current;
    }
  }

  function contextMap(r, size) {
    const count = count8(r), map = new Uint8Array(size);
    if (count === 1) return {count,map};
    const runBits = r.read(1) ? r.read(4) + 1 : 0, tree = readCode(r,count + runBits);
    for (let at = 0; at < size;) {
      const symbol = readSymbol(r,tree);
      if (symbol > 0 && symbol <= runBits) {
        const run = (1 << symbol) + r.read(symbol);
        requireValue(run <= size - at, 'Brotli context run exceeds its map.',r); at += run;
      } else map[at++] = symbol ? symbol - runBits : 0;
    }
    if (r.read(1)) {
      const order = Uint8Array.from({length:256}, (_,i)=>i);
      for (let i = 0; i < size; i++) {
        const rank = map[i], value = order[rank];
        order.copyWithin(1,0,rank); order[0] = value; map[i] = value;
      }
    }
    return {count,map};
  }

  function distanceValue(r, symbol, postfix, direct, history) {
    if (symbol < 4) return history[symbol];
    if (symbol < 16) {
      const rank = symbol < 10 ? 0 : 1, offset = symbol < 10 ? symbol - 4 : symbol - 10;
      return history[rank] + (offset & 1 ? 1 : -1) * ((offset >>> 1) + 1);
    }
    if (symbol < 16 + direct) return symbol - 15;
    const code = symbol - 16 - direct, high = code >>> postfix, low = code & ((1 << postfix) - 1), bits = 1 + (high >>> 1);
    return (((2 + (high & 1)) * (1 << bits) - 4 + r.read(bits)) * (1 << postfix)) + low + direct + 1;
  }

  function appendWord(output, at, end, length, wordId, r, dictionary) {
    requireValue(length >= 4 && length <= 24, 'Invalid Brotli dictionary word length.',r);
    const words = 1 << WORD_BITS[length], transform = BROTLI_TRANSFORMS[Math.floor(wordId / words)];
    requireValue(transform, 'Invalid Brotli dictionary transformation.',r);
    const [prefix, action, suffix] = transform, start = action >= 3 && action <= 11 ? Math.min(length,action-2) : 0;
    const stop = action >= 12 ? Math.max(0,length-(action-11)) : length, wordLength = Math.max(0,stop-start);
    const total = prefix.length + wordLength + suffix.length;
    requireValue(total <= end-at, 'Brotli dictionary word exceeds its meta-block.',r);
    for (let i = 0; i < prefix.length; i++) output[at++] = prefix.charCodeAt(i);
    const wordStart = at, base = WORD_BASE[length] + (wordId % words) * length + start;
    if (wordLength) output.set(dictionary().subarray(base,base+wordLength),at);
    at += wordLength;
    if (action === 1 || action === 2) {
      for (let i = wordStart; i < at;) {
        const byte = output[i], width = byte < 192 ? 1 : byte < 224 ? 2 : 3;
        if (width === 1) { if (byte >= 97 && byte <= 122) output[i] ^= 32; }
        else if (i+width <= at) output[i+width-1] ^= width === 2 ? 32 : 5;
        if (action === 1) break;
        i += width;
      }
    }
    for (let i = 0; i < suffix.length; i++) output[at++] = suffix.charCodeAt(i);
    return at;
  }

  return function readBrotli(r, maxOutput, maxBlocks, dictionary) {
    const bytes = r.bytes;
    let words;
    const dictionaryBytes = () => {
      if (words) return words;
      words = dictionary();
      requireValue(words instanceof Uint8Array && words.length === 122784, 'Invalid Brotli dictionary bytes.',r);
      return words;
    };
    let windowBits = 16;
    if (r.read(1)) {
      const high = r.read(3);
      if (high) windowBits = high + 17;
      else { const low = r.read(3); requireValue(low !== 1, 'Invalid Brotli window size.',r); windowBits = low ? low + 8 : 17; }
    }
    const window = (1 << windowBits) - 16, history = [4,11,15,16];
    let output = new Uint8Array(0), at = 0, last = false, blocks = 0;
    while (!last) {
      if (++blocks > maxBlocks) limit(true);
      last = !!r.read(1);
      if (last && r.read(1)) break;
      const nibbles = r.read(2) + 4;
      if (nibbles === 7) {
        requireValue(!r.read(1), 'Invalid Brotli metadata reserved bit.',r);
        const n = r.read(2), size = r.read(n*8);
        requireValue(n <= 1 || size >= 1 << (8*(n-1)), 'Noncanonical Brotli metadata length.',r);
        r.align(); r.skip((n ? size+1 : 0)*8); continue;
      }
      const size = r.read(nibbles*4) + 1, end = at + size;
      requireValue(nibbles === 4 || size > 1 << (4*(nibbles-1)), 'Noncanonical Brotli meta-block length.',r);
      if (end > maxOutput) limit(false);
      if (end > output.length) {
        const capacity = Math.min(maxOutput, Math.max(end, output.length * 2));
        let next;
        try { next = new Uint8Array(capacity); }
        catch (error) { if (!(error instanceof RangeError) || capacity === end) throw error; next = new Uint8Array(end); }
        next.set(output.subarray(0,at)); output = next;
      }
      if (!last && r.read(1)) {
        r.align(); const position = r.bit / 8; r.skip(size*8);
        output.set(bytes.subarray(position,position+size),at); at = end; continue;
      }
      const literalBlocks = new BlockTypes(r), commandBlocks = new BlockTypes(r), distanceBlocks = new BlockTypes(r);
      const postfix = r.read(2), direct = r.read(4) << postfix;
      const modes = Uint8Array.from({length:literalBlocks.count},()=>r.read(2));
      const literals = contextMap(r,literalBlocks.count*64), distances = contextMap(r,distanceBlocks.count*4);
      const literalTrees = Array.from({length:literals.count},()=>readCode(r,256));
      const commandTrees = Array.from({length:commandBlocks.count},()=>readCode(r,704));
      const distanceTrees = Array.from({length:distances.count},()=>readCode(r,16+direct+(48<<postfix)));
      while (at < end) {
        const started = at, bit = r.bit, command = readSymbol(r,commandTrees[commandBlocks.next(r)]), group = command >>> 6;
        const insertCode = INSERT_GROUP[group] + ((command >>> 3) & 7), copyCode = COPY_GROUP[group] + (command & 7);
        const insert = INSERT_BASE[insertCode] + r.read(INSERT_BITS[insertCode]), copy = COPY_BASE[copyCode] + r.read(COPY_BITS[copyCode]);
        requireValue(insert <= end-at, 'Brotli literals exceed their meta-block.',r);
        for (let i = 0; i < insert; i++) {
          const type = literalBlocks.next(r), context = literalContext(modes[type],at ? output[at-1] : 0,at > 1 ? output[at-2] : 0);
          output[at++] = readSymbol(r,literalTrees[literals.map[type*64+context]]);
        }
        if (at === end) break;
        const symbol = command < 128 ? 0 : readSymbol(r,distanceTrees[distances.map[distanceBlocks.next(r)*4+Math.min(3,copy-2)]]);
        const distance = distanceValue(r,symbol,postfix,direct,history), available = Math.min(at,window);
        requireValue(distance > 0, 'Invalid Brotli backward distance.',r);
        if (distance > available) at = appendWord(output,at,end,copy,distance-available-1,r,dictionaryBytes);
        else {
          requireValue(copy <= end-at, 'Brotli copy exceeds its meta-block.',r);
          if (symbol) { history.pop(); history.unshift(distance); }
          if (distance === 1) { output.fill(output[at-1],at,at+copy); at += copy; }
          else for (let i = 0; i < copy; i++,at++) output[at] = output[at-distance];
        }
        requireValue(at > started || r.bit > bit, 'Brotli command does not advance.',r);
      }
    }
    r.end(); return output.length === at ? output : output.slice(0,at);
  };
}
