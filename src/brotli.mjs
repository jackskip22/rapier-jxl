// SPDX-License-Identifier: MIT
import {readAll, journaling, journalJoin, journalTool} from './step-journal.mjs';
import {BitWriter, floorLog2, ceilLog2, complete} from './bits.mjs';
import {buildCode, canonicalCodes, writePrefixCode} from './prefix.mjs';
import {fault} from './fault.mjs';
import {populationBits} from './entropy.mjs';
import {INSERT_BITS, COPY_BITS, INSERT_GROUP, COPY_GROUP, INSERT_BASE, COPY_BASE, literalContext, brotliReader} from './brotli-read.mjs';

const invalid = message => fault('JXL_INPUT', 'Portable Brotli: ' + message);
const need = (value, message = 'invalid compressed data.') => { if (!value) throw invalid(message); };
const tooLarge = () => fault('JXL_SIZE', 'The Brotli result exceeds maxOutputLength.');
const COMMAND_GROUP = [128,192,384,256,320,512,448,576,640];

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

function shortCode(history, distance) {
  for (let k = 0; k < 4; k++) if (history[k] === distance) return k;
  for (let c = 4; c < 16; c++) {
    const delta = c < 10 ? c - 4 : c - 10;
    if (history[c < 10 ? 0 : 1] + ((delta & 1) ? 1 : -1) * ((delta >> 1) + 1) === distance) return c;
  }
  return -1;
}
function matchScore(length, distance, history) {
  const sc = shortCode(history, distance);
  return length * 6 - (sc === 0 ? 5 : sc > 0 ? 10 : 10 + floorLog2(distance + 3));
}

function matcher(data, windowBits, cache = false, thorough = false) {
  const span = 1 << Math.min(windowBits, Math.max(16, ceilLog2(data.length))), mask = span - 1, reach = (1 << windowBits) - 16;
  const heads = new Int32Array(65536).fill(-1), previous = new Int32Array(span).fill(-1);
  const heads3 = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) || (typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) ? null : thorough ? new Int32Array(32768).fill(-1) : null;
  const hash = at => Math.imul((data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24), 0x1e35a7bd) >>> 16;
  const hash3 = at => Math.imul((data[at] | data[at + 1] << 8 | data[at + 2] << 16), 0x1e35a7bd) >>> 17;
  return {
    history: [4, 11, 15, 16],
    insert(at) {
      if (at + 3 < data.length) { const key = hash(at); previous[at & mask] = heads[key]; heads[key] = at; }
      if (heads3 && at + 2 < data.length) heads3[hash3(at)] = at;
    },
    fill(from, to) {
      const end = Math.min(to, data.length - 3);
      for (let at = from; at < end; at++) {
        const key = Math.imul(data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24, 0x1e35a7bd) >>> 16;
        previous[at & mask] = heads[key]; heads[key] = at;
      }
      if (heads3) for (let at = from, last = Math.min(to, data.length - 2); at < last; at++) heads3[Math.imul(data[at] | data[at + 1] << 8 | data[at + 2] << 16, 0x1e35a7bd) >>> 17] = at;
    },
    find(at, end, useCache) {
      const available = end - at;
      if (available < (useCache ? 3 : 4)) return {length: 0, distance: 0, score: 0};
      const oldest = Math.max(0, at - reach);
      if ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) || !useCache) {
        let probe = heads[hash(at)], length = 3, distance = 0, attempts = 32;
        while (probe >= oldest && attempts--) {
          if (data[probe] === data[at] && data[probe + 1] === data[at + 1] && data[probe + 2] === data[at + 2] && data[probe + length] === data[at + length]) {
            let count = 3; while (count < available && data[probe + count] === data[at + count]) count++;
            if (count > length) { length = count; distance = at - probe; if (length === available) break; }
          }
          const next = previous[probe & mask]; if (next >= probe) break; probe = next;
        }
        return {length: distance ? length : 0, distance, score: length * 6};
      }
      let bestLen = 0, bestDist = 0, bestScore = 3;
      for (let k = 0; k < 4; k++) {
        const d = this.history[k];
        if (d > at - oldest) continue;
        let count = 0; while (count < available && data[at - d + count] === data[at + count]) count++;
        if (count >= 3) {
          const sc = count * 6 - (k === 0 ? 5 : 9);
          if (sc > bestScore) { bestScore = sc; bestLen = count; bestDist = d; if (bestLen === available) return {length: bestLen, distance: bestDist, score: bestScore}; }
        }
      }
      if (bestLen < 4 && heads3) {
        const p3 = heads3[hash3(at)];
        if (p3 >= oldest && at - p3 <= 256 && data[p3] === data[at] && data[p3 + 1] === data[at + 1] && data[p3 + 2] === data[at + 2]) {
          const d = at - p3, sc = matchScore(3, d, this.history);
          if (sc > bestScore) { bestLen = 3; bestDist = d; bestScore = sc; }
        }
      }
      if (available >= 4 && bestLen < available) {
        let probe = heads[hash(at)], minLen = thorough ? Math.max(3, bestLen - 2) : Math.max(3, bestLen), attempts = thorough ? 128 : 32;
        while (probe >= oldest && attempts--) {
          if (data[probe + minLen] === data[at + minLen] && data[probe] === data[at] && data[probe + 1] === data[at + 1] && data[probe + 2] === data[at + 2]) {
            let count = 3; while (count < available && data[probe + count] === data[at + count]) count++;
            if (count >= 4) {
              const d = at - probe, sc = matchScore(count, d, this.history);
              if (sc > bestScore) { bestScore = sc; bestLen = count; bestDist = d; minLen = thorough ? Math.max(3, bestLen - 2) : bestLen; if (bestLen === available) break; }
            }
          }
          const next = previous[probe & mask]; if (next >= probe) break; probe = next;
        }
      }
      return {length: bestDist ? bestLen : 0, distance: bestDist, score: bestScore};
    },
  };
}

function matchesFor(data, at, to, end, matches, cache, thorough, found) {
  while (at < to) {
    const match = matches.find(at, end, cache); matches.insert(at);
    if (!match.length) { at++; continue; }
    if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && thorough && at + 1 < end && match.length < 32) {
      const next = matches.find(at + 1, end, true);
      if (next.length && next.score > match.score + 5) { at++; continue; }
    }
    found.push(at, match.length, match.distance);
    if (!(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && (!cache || shortCode(matches.history, match.distance))) { matches.history.pop(); matches.history.unshift(match.distance); }
    matches.fill(at + 1, at + match.length);
    at += match.length;
  }
  return at;
}
function encodeDistance(distance, postfix, direct) {
  if (distance <= direct) return {code: 15 + distance, bits: 0, extra: 0};
  const u = distance - direct - 1, low = u & ((1 << postfix) - 1), v = (u >>> postfix) + 4;
  const bits = floorLog2(v) - 1, high = (v >>> bits) & 1;
  return {code: 16 + direct + ((((bits - 1) << 1 | high) << postfix) | low), bits, extra: v - ((2 + high) << bits)};
}
function commandsFor(data, start, end, found, history, cache, postfix = 0, direct = 0) {
  const commands = [], literalFrequencies = new Uint32Array(256), commandFrequencies = new Uint32Array(704);
  const distAlpha = 16 + direct + (48 << postfix), distanceFrequencies = new Uint32Array(distAlpha);
  let literals = start, copied = 0;
  const push = (position, count, distance) => {
    const insert = position - literals, insertCode = lengthCode(insert, INSERT_BASE), copyCode = lengthCode(count || 2, COPY_BASE);
    const code = COMMAND_GROUP[(insertCode >> 3) * 3 + (copyCode >> 3)] + ((insertCode & 7) << 3) + (copyCode & 7);
    const command = {start: literals, insert, count, insertCode, copyCode, code};
    for (let i = literals; i < position; i++) literalFrequencies[data[i]]++;
    const short = !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && count && cache ? shortCode(history, distance) : -1;
    if (short === 0 && insertCode < 8 && copyCode < 16) {
      command.code = (copyCode >= 8 ? 64 : 0) + (insertCode << 3) + (copyCode & 7); command.implicit = true;
    } else if (short >= 0) {
      command.distanceCode = short; command.distanceBits = 0; command.distanceExtra = 0; distanceFrequencies[short]++;
    } else if (count) {
      const enc = encodeDistance(distance, postfix, direct);
      command.distanceCode = enc.code; command.distanceBits = enc.bits; command.distanceExtra = enc.extra;
      distanceFrequencies[enc.code]++;
    }
    if (!(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && count && short !== 0) { history.pop(); history.unshift(distance); }
    if (count) copied += count;
    commands.push(command); commandFrequencies[command.code]++;
  };
  for (let k = 0; k < found.length; k += 3) { push(found[k], found[k + 1], found[k + 2]); literals = found[k] + found[k + 1]; }
  if (literals < end) push(end, 0, 0);
  return {commands, copied, postfix, direct, literalFrequencies, literal: tree(literalFrequencies, 256), command: tree(commandFrequencies, 704), distance: tree(distanceFrequencies, distAlpha)};
}
function bestCommands(data, start, end, found, ring, cache) {
  if ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) || !cache || found.length < 24) return commandsFor(data, start, end, found, ring.slice(), cache, 0, 0);
  let best = null, bestBits = Infinity;
  for (const [postfix, dcode] of [[0, 0], [0, 4], [1, 4], [2, 3]]) {
    const plan = commandsFor(data, start, end, found, ring.slice(), cache, postfix, dcode << postfix);
    let bits = 0, used = 0;
    for (const c of plan.commands) {
      bits += plan.command.lengths[c.code] + INSERT_BITS[c.insertCode] + COPY_BITS[c.copyCode];
      if (c.count && !c.implicit) bits += plan.distance.lengths[c.distanceCode] + c.distanceBits;
    }
    for (let i = 0; i < plan.distance.lengths.length; i++) if (plan.distance.lengths[i]) used++;
    bits += used * 4;
    if (bits < bestBits) { bestBits = bits; best = plan; }
  }
  return best;
}

function blockHeader(writer, length, uncompressed) {
  writer.write(1, 0); writer.write(2, 0); writer.write(16, length - 1); writer.write(1, uncompressed);
}
function histogramBits(a, b) {
  let total = 0, bits = 0, used = 0;
  for (let s = 0; s < 256; s++) { const f = b ? a[s] + b[s] : a[s]; if (f) { total += f; bits -= populationBits(f); used++; } }
  return bits + populationBits(total) + (used > 1 ? 16 + 5 * used : 8);
}
function modeModel(data, commands, kernels, mode) {
  const histograms = Array.from({length: 64}, () => new Uint32Array(256));
  for (const command of commands) for (let at = command.start; at < command.start + command.insert; at++)
    histograms[literalContext(mode, at ? data[at - 1] : 0, at > 1 ? data[at - 2] : 0)][data[at]]++;
  const clusters = histograms.map((freqs, i) => ({freqs, contexts: [i], bits: histogramBits(freqs)})).filter(c => c.freqs.some(Boolean));
  if (clusters.length < 2) return null;
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
  return {mode, map, bits: kept.reduce((total, c) => total + c.bits, 0) + (kept.length > 1 ? 64 * Math.max(1, ceilLog2(kept.length)) : 0), trees: kept.length};
}
function literalModel(data, commands, kernels, modes, models = null) {
  const single = new Uint32Array(256);
  for (const command of commands) for (let at = command.start; at < command.start + command.insert; at++) single[data[at]]++;
  let best = {mode: 0, map: new Uint8Array(64), bits: histogramBits(single), trees: 1};
  for (const mode of modes) { const model = models ? models[mode] : modeModel(data, commands, kernels, mode); if (model && model.bits < best.bits) best = model; }
  if (best.trees === 1) return {...best, histograms: [single]};
  const {mode, map, trees} = best, histograms = Array.from({length: trees}, () => new Uint32Array(256));
  for (const command of commands) for (let at = command.start; at < command.start + command.insert; at++)
    histograms[map[literalContext(mode, at ? data[at - 1] : 0, at > 1 ? data[at - 2] : 0)]][data[at]]++;
  return {...best, histograms};
}
function literalSpans(found, start, end) {
  const spans = [];
  let at = start;
  for (let k = 0; k < found.length; k += 3) { spans.push({start: at, insert: found[k] - at}); at = found[k] + found[k + 1]; }
  if (at < end) spans.push({start: at, insert: end - at});
  return spans;
}
function writeVarLenUint8(writer, value) {
  if (!value) { writer.write(1, 0); return; }
  const n = floorLog2(value); writer.write(1, 1); writer.write(3, n); writer.write(n, value - (1 << n));
}
function writeContextMap(writer, map, trees) {
  writeVarLenUint8(writer, trees - 1);
  if ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) || trees <= 1) return;
  const raw = new BitWriter(64), rawCounts = new Uint32Array(trees);
  for (const k of map) rawCounts[k]++;
  const rawCode = tree(rawCounts, trees);
  raw.write(1, 0); writePrefixCode(raw, rawCode);
  for (const k of map) symbol(raw, rawCode, k);
  raw.write(1, 0);
  const mtf = new Uint8Array(map.length), list = Uint8Array.from({length: trees}, (_, i) => i);
  for (let i = 0; i < map.length; i++) {
    const v = map[i]; let idx = 0; while (list[idx] !== v) idx++;
    mtf[i] = idx;
    if (idx) { list.copyWithin(1, 0, idx); list[0] = v; }
  }
  let maxCode = 0;
  const seq = [];
  for (let i = 0; i < mtf.length;) {
    if (mtf[i] !== 0) { seq.push({sym: mtf[i], extraBits: 0, extra: 0, nonZero: true}); i++; continue; }
    let run = 0; while (i + run < mtf.length && mtf[i + run] === 0) run++;
    i += run;
    while (run >= 2) {
      const c = Math.min(16, floorLog2(run)), rem = run - (1 << c);
      if (rem < (1 << c)) { if (c > maxCode) maxCode = c; seq.push({sym: c, extraBits: c, extra: rem, nonZero: false}); run = 0; }
      else { maxCode = 16; seq.push({sym: 16, extraBits: 16, extra: 65535, nonZero: false}); run -= 131071; }
    }
    if (run === 1) seq.push({sym: 0, extraBits: 0, extra: 0, nonZero: false});
  }
  const rle = new BitWriter(64), alpha = trees + maxCode, rleCounts = new Uint32Array(alpha);
  for (const item of seq) rleCounts[item.nonZero ? item.sym + maxCode : item.sym]++;
  const rleCode = tree(rleCounts, alpha);
  if (maxCode > 0) { rle.write(1, 1); rle.write(4, maxCode - 1); } else rle.write(1, 0);
  writePrefixCode(rle, rleCode);
  for (const item of seq) { symbol(rle, rleCode, item.nonZero ? item.sym + maxCode : item.sym); if (item.extraBits) rle.write(item.extraBits, item.extra); }
  rle.write(1, 1);
  writer.append(rle.bitLength < raw.bitLength ? rle : raw);
}
function compressedBlock(data, start, end, plan, contexts, kernels, thorough = true, models = null) {
  const len = end - start, sparse = !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && len >= 8192 && plan.copied < (len >> 5) && histogramBits(plan.literalFrequencies) > len * 7.9;
  if (sparse && !thorough) return {bytes: new Uint8Array(0), at: len + 8, pending: 0, acc: 0};
  if ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true)) return writeBlock(data, start, end, plan, {mode: 0, map: null, trees: 1, histograms: [plan.literal]});
  const single = sparse && contexts ? null : writeBlock(data, start, end, plan, {mode: 0, map: new Uint8Array(64), trees: 1, histograms: [plan.literal]});
  if (!contexts) return single;
  const model = literalModel(data, plan.commands, kernels, sparse ? [3] : [0, 1, 2, 3], models);
  if (model.trees === 1) return single || writeBlock(data, start, end, plan, {mode: 0, map: new Uint8Array(64), trees: 1, histograms: [plan.literal]});
  const modelled = writeBlock(data, start, end, plan, model);
  return single && single.bitLength <= modelled.bitLength ? single : modelled;
}
function writeBlock(data, start, end, plan, model) {
  const writer = new BitWriter();
  const literals = model.histograms.map(freqs => freqs.lengths ? freqs : tree(Uint32Array.from(freqs), 256));
  blockHeader(writer, end - start, 0);
  writer.write(3, 0);
  writer.write(2, plan.postfix); writer.write(4, plan.direct >> plan.postfix);
  writer.write(2, model.mode);
  if ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true)) writer.write(1, 0); else writeContextMap(writer, model.map, model.trees);
  writer.write(1, 0);
  for (const code of [...literals, plan.command, plan.distance]) writePrefixCode(writer, code);
  for (const command of plan.commands) {
    symbol(writer, plan.command, command.code);
    writer.write(INSERT_BITS[command.insertCode], command.insert - INSERT_BASE[command.insertCode]);
    writer.write(COPY_BITS[command.copyCode], (command.count || 2) - COPY_BASE[command.copyCode]);
    for (let at = command.start; at < command.start + command.insert; at++)
      symbol(writer, literals[!(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && model.trees > 1 ? model.map[literalContext(model.mode, at ? data[at - 1] : 0, at > 1 ? data[at - 2] : 0)] : 0], data[at]);
    if (command.count && !command.implicit) { symbol(writer, plan.distance, command.distanceCode); writer.write(command.distanceBits, command.distanceExtra); }
  }
  return writer;
}

const decodedBytes = parts => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
};
const joinDecoded = parts => journaling() ? journalJoin(parts) : decodedBytes(parts);

export const compressBrotli = (bytes, options = {}) => complete(compressBrotliSteps(bytes, options));
const ran = function* (name, run) { return run(); };
const MATCH_BYTES = 16384;
export function* compressBrotliSteps(bytes, options = {}, unit = ran) {
  const maximum = admission(bytes, options), cache = !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && !!options.literalContexts, thorough = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && cache && options.thorough !== false;
  const reachBytes = !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && options.contextLimit ? Math.min(bytes.length, options.contextLimit) : bytes.length;
  const windowBits = cache ? Math.min(24, Math.max(16, ceilLog2(reachBytes + 16))) : 16;
  const span = 1 << Math.min(windowBits, Math.max(16, ceilLog2(bytes.length)));
  let matches = bytes.length ? matcher(bytes, windowBits, cache, thorough) : null, matched = 0;
  const header = writer => {
    if (windowBits === 16) writer.write(1, 0);
    else if (windowBits === 17) { writer.write(1, 1); writer.write(3, 0); writer.write(3, 0); }
    else { writer.write(1, 1); writer.write(3, windowBits - 17); }
  };
  const ranges = [];
  if (!(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && options.cuts?.length) {
    const cuts = [0, ...options.cuts, bytes.length];
    for (let i = 0; i + 1 < cuts.length; i++) for (let s = cuts[i]; s < cuts[i + 1]; s += 65536) ranges.push([s, Math.min(cuts[i + 1], s + 65536)]);
  } else for (let s = 0; s < bytes.length; s += 65536) ranges.push([s, Math.min(bytes.length, s + 65536)]);
  const blocks = [];
  let bitLength = windowBits === 16 ? 1 : windowBits === 17 ? 7 : 4;
  for (const [start, end] of ranges) {
    const ring = matches.history.slice(), parts = [], blockCache = !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && cache && (!options.contextLimit || start < options.contextLimit);
    let at = start, history = ring, part;
    for (let to = start + MATCH_BYTES; at < end; to += MATCH_BYTES) {
      ({at, found: part, history} = yield* unit('brotli-matches', () => {
        if (matched !== at) {
          matches = matcher(bytes, windowBits, cache, thorough);
          matches.fill(Math.max(0, at - span), at);
        }
        matches.history = history.slice();
        const list = [], next = matchesFor(bytes, at, Math.min(end, to), end, matches, blockCache, thorough && blockCache, list);
        matched = next;
        return {at: next, found: Int32Array.from(list), history: matches.history.slice()};
      }));
      parts.push(part);
    }
    const foundOf = () => { const found = []; for (const part of ((typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) ? parts : readAll(parts))) for (const value of part) found.push(value); return found; };
    let models = null;
    if (!(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && blockCache) {
      models = [];
      for (const pair of [[0, 1], [2, 3]]) models.push(...yield* unit('brotli-modes', () => { const spans = literalSpans(foundOf(), start, end); return pair.map(mode => modeModel(bytes, spans, options.kernels, mode)); }));
    }
    const compressed = yield* unit('brotli-block', () => {
      const found = foundOf(), commands = !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && !(typeof __RAPIER_JXL_METADATA__ !== 'undefined' && __RAPIER_JXL_METADATA__ === true) && thorough && blockCache ? bestCommands(bytes, start, end, found, ring, true) : commandsFor(bytes, start, end, found, ring.slice(), blockCache, 0, 0);
      const block = compressedBlock(bytes, start, end, commands, blockCache, options.kernels, thorough && blockCache, models);
      return {bytes: block.bytes.subarray(0, block.at), at: block.at, pending: block.pending, acc: block.acc, history: history.slice()};
    });
    const rawBits = 20 + ((8 - (bitLength + 20) % 8) % 8) + (end - start) * 8;
    const bits = compressed.at * 8 + compressed.pending, chosenBits = Math.min(rawBits, bits);
    if (Math.ceil((bitLength + chosenBits + 2) / 8) > maximum) throw tooLarge();
    if (bits < rawBits) { blocks.push(compressed); matches.history = compressed.history.slice(); }
    else { matches.history = ring; blocks.push({start, end}); }
    bitLength += chosenBits;
  }
  if (Math.ceil((bitLength + 2) / 8) > maximum) throw tooLarge();
  const first = new BitWriter(); header(first);
  let pending = first.pending, acc = first.acc;
  const pieces = [];
  for (const block of blocks) {
    const part = yield* unit('brotli-join', () => {
      const writer = new BitWriter(65552); writer.pending = pending; writer.acc = acc;
      if (block.bytes) writer.append(block);
      else {
        blockHeader(writer, block.end - block.start, 1); writer.zeroPadToByte();
        writer.append({bytes: bytes.subarray(block.start, block.end), at: block.end - block.start, pending: 0, acc: 0});
      }
      return {bytes: writer.bytes.subarray(0, writer.at), pending: writer.pending, acc: writer.acc};
    });
    pieces.push(part.bytes); pending = part.pending; acc = part.acc;
  }
  pieces.push(yield* unit('brotli-final', () => {
    const writer = new BitWriter(8); writer.pending = pending; writer.acc = acc; writer.write(2, 3); return writer.finish();
  }));
  const output = joinDecoded(pieces); if (output.length > maximum) throw tooLarge(); return output;
}

class Reader {
  constructor(bytes, pos = 0) { this.bytes = bytes; this.pos = pos; this.start = 0; this.part = null; }
  byte(at) {
    if (!this.part || at < this.start || at >= this.start + this.part.length) {
      this.start = at; this.part = this.bytes.subarray(at, Math.min(this.bytes.length, at + 65536));
    }
    return this.part[at - this.start];
  }
  read(count) {
    need(this.pos + count <= this.bytes.length * 8, 'the compressed stream is truncated.');
    let value = 0, shift = 0;
    while (count) {
      const available = Math.min(count, 8 - (this.pos & 7));
      value += ((this.byte(this.pos >> 3) >> (this.pos & 7)) & ((1 << available) - 1)) * (1 << shift);
      this.pos += available; count -= available; shift += available;
    }
    return value;
  }
  pad() { need(this.read((8 - this.pos % 8) % 8) === 0, 'padding bits must be zero.'); }
  get bit() { return this.pos; }
  skip(count) { need(this.pos + count <= this.bytes.length * 8, 'the compressed stream is truncated.'); this.pos += count; }
  align() { this.pad(); }
  end() { this.align(); need(this.pos === this.bytes.length * 8, 'bytes follow the final meta-block.'); }
}
function prefixModel(lengths, explicit) {
  const codes = explicit ?? canonicalCodes(lengths), levels = Array(16).fill(null); let used = 0, only = 0, maximum = 0, space = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    const count = lengths[i]; need(count <= 15);
    (levels[count] ??= new Map()).set(codes[i], i); maximum = Math.max(maximum, count); space += 32768 >> count; used++; only = i;
  }
  need(used > 0 && (used === 1 || space === 32768), 'invalid prefix-code lengths.');
  return {levels, maximum, only: used === 1 ? only : -1};
}
function prefixRead(model, reader) {
  if (model.only >= 0) return model.only;
  let value = 0;
  for (let count = 1; count <= model.maximum; count++) {
    value |= reader.read(1) << (count - 1); const symbol = model.levels[count]?.get(value); if (symbol !== undefined) return symbol;
  }
  throw invalid('invalid prefix symbol.');
}
function readTree(reader, alphabet) {
  const form = reader.read(2), lengths = new Uint8Array(alphabet);
  if (form === 1) {
    const count = reader.read(2) + 1, symbols = Array.from({length: count}, () => reader.read(ceilLog2(alphabet)));
    need(new Set(symbols).size === count && symbols.every(value => value < alphabet), 'invalid simple prefix tree.');
    if (count === 1) return {only: symbols[0], maximum: 0, levels: []};
    const depths = count === 2 ? [1,1] : count === 3 ? [1,2,2] : reader.read(1) ? [1,2,3,3] : [2,2,2,2];
    for (let i = 0; i < count; i++) lengths[symbols[i]] = depths[i];
  } else {
    const order = [1,2,3,4,0,5,17,6,16,7,8,9,10,11,12,13,14,15], codeLengths = new Uint8Array(18);
    const fixed = prefixModel([2,4,3,2,2,4], [0,7,3,2,1,15]); let space = 32, used = 0;
    for (let i = form; i < order.length && space > 0; i++) {
      const length = prefixRead(fixed, reader); codeLengths[order[i]] = length;
      if (length) { space -= 32 >> length; used++; }
    }
    need(space === 0 || used === 1, 'invalid code-length prefix tree.');
    const next = prefixModel(codeLengths); let at = 0, previous = 8, repeated = -1, repeat = 0;
    space = 32768;
    while (at < alphabet && space > 0) {
      const value = prefixRead(next, reader);
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
  return prefixModel(lengths);
}
const readerAt = (bytes, bit = 0) => new Reader(bytes, bit);
function brotliLimits(bytes, options = {}) {
  const maxOutput = admission(bytes, options), maxBlocks = options.maxBlocks ?? 65536, {dictionary} = options;
  need(Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'maxBlocks is a positive safe integer.');
  let words;
  return {maxOutput, maxBlocks, dictionary() {
    if (words) return words;
    words = typeof dictionary === 'function' ? dictionary() : dictionary;
    if (!words) throw Object.assign(invalid('static dictionary references require a full decoder or the dictionary.'), {dictionary: true});
    need(words instanceof Uint8Array && words.length === 122784, 'Invalid Brotli dictionary bytes.');
    return words;
  }};
}
const sharedBrotli = /* @__PURE__ */ brotliReader(readTree, (r, m) => prefixRead(m, r), need, blocks => {
  throw blocks ? fault('JXL_SIZE', 'The Brotli stream exceeds maxBlocks.') : tooLarge();
}, readerAt, brotliLimits);
export const decompressBrotli = (bytes, options = {}) => sharedBrotli.read(bytes, options);
export function* decompressBrotliSteps(bytes, options = {}) {
  if (!journaling()) return decompressBrotli(bytes, options);
  return yield* journalTool('readBrotli')(bytes, options, sharedBrotli.owner);
}
