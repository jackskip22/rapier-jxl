// SPDX-License-Identifier: MIT
// Mutations follow JPEG marker, table, scan and restart boundaries; pixel seeds cross block and group edges.
export function rng(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
const pick = (values, random) => values[Math.floor(random() * values.length)];
const byte = random => Math.floor(random() * 256);

export function jpegParts(bytes) {
  const parts = [];
  for (let start = 2; start + 3 < bytes.length;) {
    let at = start;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) break;
    const payload = at + 2, end = at + bytes[at] * 256 + bytes[at + 1];
    if (end > bytes.length || end < payload) break;
    const part = {marker, start, payload, end, restarts: []};
    start = end;
    if (marker === 218) {
      while (start + 1 < bytes.length) {
        if (bytes[start] !== 255) { start++; continue; }
        if (bytes[start + 1] === 0 || bytes[start + 1] === 255) { start += bytes[start + 1] === 0 ? 2 : 1; continue; }
        if (bytes[start + 1] >= 208 && bytes[start + 1] <= 215) { part.restarts.push(start); start += 2; continue; }
        break;
      }
      part.scanEnd = start;
    }
    parts.push(part);
  }
  return parts;
}

export const mutationKinds = ['segment', 'table', 'scan', 'restart', 'truncate', 'dimension', 'entropy', 'metadata'];
export function mutateJPEG(input, random, index) {
  const out = Uint8Array.from(input), parts = jpegParts(input), kind = mutationKinds[index % mutationKinds.length];
  const matching = marker => parts.filter(p => marker.includes(p.marker));
  const splice = (at, remove, insert = []) => Uint8Array.from([...out.subarray(0, at), ...insert, ...out.subarray(at + remove)]);
  if (kind === 'segment') {
    const part = pick(parts, random);
    if (random() < 0.5) { const length = pick([0, 1, 2, 3, 65535], random); out[part.payload - 2] = length >> 8; out[part.payload - 1] = length & 255; }
    else return {kind, bytes: splice(part.start, part.end - part.start)};
  } else if (kind === 'table') {
    const part = pick(matching([196, 219]), random);
    out[part.payload + Math.floor(random() * (part.end - part.payload))] = byte(random);
  } else if (kind === 'scan') {
    const part = pick(matching([218]), random);
    out[part.payload + Math.floor(random() * (part.end - part.payload))] = pick([0, 1, 2, 3, 15, 16, 63, 64, 255], random);
  } else if (kind === 'restart') {
    const positions = parts.flatMap(p => p.restarts);
    if (positions.length) out[pick(positions, random) + 1] = pick([208, 209, 215, 217, 0], random);
    else { const part = pick(matching([218]), random); return {kind, bytes: splice(part.end, 0, [255, pick([208, 215], random)])}; }
  } else if (kind === 'truncate') {
    const points = parts.flatMap(p => [p.start, p.payload - 1, p.end - 1, p.end, ...(p.scanEnd ? [p.scanEnd - 1] : [])]);
    return {kind, bytes: out.subarray(0, pick(points, random))};
  } else if (kind === 'dimension') {
    const part = pick(matching([192, 193, 194]), random);
    // Admitted mutations stay small; oversized cases exceed the public edge limit and must fail before allocation.
    for (const offset of [1, 3]) { const value = pick([0, 1, 7, 8, 9, 17, 33, 65, 16385, 65535], random); out[part.payload + offset] = value >> 8; out[part.payload + offset + 1] = value & 255; }
  } else if (kind === 'entropy') {
    const part = pick(matching([218]), random), at = part.end + Math.floor(random() * Math.max(1, part.scanEnd - part.end));
    out[at] ^= 1 << Math.floor(random() * 8);
  } else {
    const part = pick(parts, random), payload = Array.from({length: Math.floor(random() * 16)}, () => byte(random));
    return {kind, bytes: splice(part.start, 0, [255, pick([225, 226, 238, 254], random), 0, payload.length + 2, ...payload])};
  }
  return {kind, bytes: out};
}

// A picture made by integer arithmetic alone, (x + y, 3x + 7y, 13x + 19y, 255): at 2,049 x 257 the lossy stream whose
// coarse Squeeze border crosses a DC group, which jxl-rs 0.7.4 read from the wrong origin (seeds/README.md).
export function borderCase(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([(x + y) & 255, (3 * x + 7 * y) & 255, (13 * x + 19 * y) & 255, 255], (y * width + x) * 4);
  return {rgba, width, height};
}

export function pixelCase(seed, index, {compact = false} = {}) {
  const random = rng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const [width, height] = pick(compact ? [[1, 1], [1, 17], [17, 1], [7, 9], [8, 8], [9, 9], [17, 3], [3, 17], [17, 17]] : [[1, 1], [1, 17], [17, 1], [7, 9], [8, 8], [9, 9], [17, 31], [255, 17], [257, 19], [19, 257], [257, 255], [2049, 1], [1, 257]], random);
  const kind = pick(['rgba', 'rgb', 'grey', 'grey-alpha', 'palette', 'stripes'], random), rgba = new Uint8Array(width * height * 4);
  const palette = Array.from({length: pick([1, 2, 5, 31, 257, 513], random)}, () => [byte(random), byte(random), byte(random), byte(random)]);
  for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 4) {
    const r = byte(random);
    const colour = kind === 'palette' ? pick(palette, random) : kind === 'stripes' ? [(x * 7) & 255, (y * 11) & 255, ((x + y) * 3) & 255, 255] : [r, kind.startsWith('grey') ? r : byte(random), kind.startsWith('grey') ? r : byte(random), kind === 'rgba' || kind === 'grey-alpha' ? byte(random) : 255];
    rgba.set(colour, at);
  }
  return {width, height, rgba, kind, quality: pick([1, 60, 90, 99, 100], random)};
}

// The mutation grammar admits at most a 65-pixel edge and sampling factors at most four.
// An oversized header must refuse before it can allocate an attacker-sized coefficient plane.
export function guardJPEGPlanes(work) {
  const Original = globalThis.Int16Array, samples = (Math.ceil(65 / 32) * 32) ** 2;
  globalThis.Int16Array = new Proxy(Original, {construct(target, args) {
    if (typeof args[0] === 'number' && args[0] > samples) throw new Error('JPEG mutation allocated beyond its admitted fixture dimensions');
    return Reflect.construct(target, args);
  }});
  try { return work(); } finally { globalThis.Int16Array = Original; }
}

// Random access by index makes a stopped run resumable without replaying a mutable PRNG state.
// Half the table/scan/entropy cases combine several edits at the original structural boundaries.
export function scaleJPEG(input, seed, index) {
  const random = rng((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const result = mutateJPEG(input, random, index), bytes = result.bytes;
  if (index % 16 < 8 && ['table', 'scan', 'entropy'].includes(result.kind)) {
    const eligible = jpegParts(input).filter(p => result.kind === 'table' ? [196,219].includes(p.marker) : p.marker === 218);
    for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
      const part = pick(eligible, random), start = result.kind === 'entropy' ? part.end : part.payload;
      const end = result.kind === 'entropy' ? part.scanEnd : part.end;
      if (end > start) bytes[start + Math.floor(random() * (end - start))] ^= 1 << Math.floor(random() * 8);
    }
  }
  return result;
}
