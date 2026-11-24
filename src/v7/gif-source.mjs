// SPDX-License-Identifier: MIT
import {fail, declared, dimensions, PIXELS, pixelLimit} from './primitives.mjs';
import {cliError as inputError} from './cli-error.mjs';
import {viewBytes} from './bytes.mjs';
import {FrameTape} from '../frame-tape.mjs';
export const READ_GIFS = new WeakSet();

const MAX_CANVAS_BYTES = 2 ** 30;
function gifHostMemory() {
  let gigabytes;
  try { gigabytes = globalThis.navigator?.deviceMemory; } catch {}
  if (gigabytes > 0) return gigabytes * 2 ** 29;
  const constrained = globalThis.process?.constrainedMemory?.();
  if (constrained > 0 && constrained < Number.MAX_SAFE_INTEGER) return constrained;
  const os = globalThis.process?.getBuiltinModule?.('node:os');
  return os ? os.totalmem() : Infinity;
}

function lzwDecode(minCodeSize, data, pixelCount, bad) {
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  const codes = Math.floor(data.length * 8 / (minCodeSize + 1)), ramp = Math.min(codes, 4096);
  if (ramp * (ramp + 1) / 2 + (codes - ramp) * 4096 < pixelCount) bad();
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1, nextCode = eoiCode + 1, codeMask = (1 << codeSize) - 1;
  let datum = 0, bits = 0, first = 0, oldCode = -1, top = 0, dst = 0, pos = 0;
  for (let i = 0; i < clearCode; i++) { prefix[i] = -1; suffix[i] = i; }
  while (dst < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) bad();
      datum |= data[pos++] << bits;
      bits += 8;
    }
    let code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      nextCode = eoiCode + 1;
      oldCode = -1;
      continue;
    }
    if (code === eoiCode) bad();
    if (code > nextCode || oldCode === -1 && code >= clearCode) bad();
    if (oldCode === -1) {
      out[dst++] = suffix[code];
      oldCode = code;
      first = code;
      continue;
    }
    const inCode = code;
    if (code >= nextCode) {
      stack[top++] = first;
      code = oldCode;
    }
    while (code >= clearCode) {
      stack[top++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[top++] = first;
    if (nextCode < 4096) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = first;
      nextCode++;
      if ((nextCode & codeMask) === 0 && nextCode < 4096) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    oldCode = inCode;
    while (top > 0 && dst < pixelCount) out[dst++] = stack[--top];
  }
  return out;
}

function* gifTape(bytes, filePath, maxPixels, maxBytes, stream) {
  const cut = () => inputError('JXL_INPUT', `"${filePath}": GIF incomplete`, 'pass a complete GIF');
  if (bytes.length < 13) throw cut();
  if (bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70 || bytes[3] !== 56 || bytes[4] !== 55 && bytes[4] !== 57 || bytes[5] !== 97)
    throw inputError('JXL_INPUT', `"${filePath}": not GIF87a or GIF89a`, `pass a GIF file`);
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
  dimensions(width, height, maxPixels);
  const packed = bytes[10];
  let pos = 13;
  let globalPalette = null;
  if (packed & 0x80) {
    const count = 1 << ((packed & 7) + 1);
    if (pos + count * 3 > bytes.length) throw cut();
    globalPalette = bytes.subarray(pos, pos + count * 3);
    pos += count * 3;
  }
  const readSubBlocks = () => {
    const chunks = [];
    while (pos < bytes.length) {
      const sz = bytes[pos++];
      if (!sz) return finish(chunks);
      if (pos + sz > bytes.length) throw cut();
      chunks.push(bytes.subarray(pos, pos + sz));
      pos += sz;
    }
    throw cut();
  };
  const finish = chunks => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.length; }
    return merged;
  };
  const canvasBytes = width * height * 4, memory = () => fail('JXL_MEMORY', `"${filePath}": exceeds ${maxBytes} B; maxPendingBytes`);
  if (canvasBytes > maxBytes) throw memory();
  const allocCanvas = size => {
    if (size > MAX_CANVAS_BYTES || size * 4 > gifHostMemory())
      throw fail('JXL_MEMORY', `"${filePath}": ${width} x ${height} GIF canvas exceeds memory; use a smaller canvas`);
    try { return new Uint8Array(size); }
    catch (cause) { throw Object.assign(fail('JXL_MEMORY', `"${filePath}": ${width} x ${height} GIF canvas allocation failed; use a smaller canvas`), {cause}); }
  };
  if (!stream) {
    if (canvasBytes > MAX_CANVAS_BYTES || canvasBytes * 4 > gifHostMemory())
      throw fail('JXL_MEMORY', `"${filePath}": ${width} x ${height} GIF canvas exceeds memory; use a smaller canvas`);
    yield canvasBytes;
  }
  let canvas = null;
  const frames = [];
  let tape = null, x0 = width, y0 = height, x1 = -1, y1 = -1;
  const touch = (left, top, right, bottom) => { x0 = Math.min(x0, left); y0 = Math.min(y0, top); x1 = Math.max(x1, right); y1 = Math.max(y1, bottom); };
  let delayMs = 100, transIdx = -1, disposal = 0, loops = 1;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (pos >= bytes.length) throw cut();
      const label = bytes[pos++];
      if (label === 0xf9) {
        const control = readSubBlocks();
        if (control.length < 4) throw cut();
        const flags = control[0];
        disposal = (flags >> 2) & 7;
        const delayCs = control[1] | (control[2] << 8);
        delayMs = Math.max(10, (delayCs || 10) * 10);
        transIdx = flags & 1 ? control[3] : -1;
      } else if (label === 0xff) {
        const sub = readSubBlocks();
        const app = String.fromCharCode(...sub.subarray(0, 11));
        if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && sub.length >= 14 && sub[11] === 1) { const repeats = sub[12] | (sub[13] << 8); loops = repeats && repeats + 1; }
      } else {
        readSubBlocks();
      }
    } else if (block === 0x2c) {
      if (pos + 9 > bytes.length) throw cut();
      const left = bytes[pos] | (bytes[pos + 1] << 8), top = bytes[pos] ? bytes[pos + 2] | (bytes[pos + 3] << 8) : bytes[pos + 2] | (bytes[pos + 3] << 8);
      const fw = bytes[pos + 4] | (bytes[pos + 5] << 8), fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const fpack = bytes[pos + 8];
      pos += 9;
      let pal = globalPalette;
      if (fpack & 0x80) {
        const count = 1 << ((fpack & 7) + 1);
        if (pos + count * 3 > bytes.length) throw cut();
        pal = bytes.subarray(pos, pos + count * 3);
        pos += count * 3;
      }
      if (!pal) throw inputError('JXL_INPUT', `"${filePath}": GIF color table missing`, `re-export "${filePath}"`);
      if (!fw || !fh || fw * fh > maxPixels) throw inputError('JXL_DIMENSIONS', `"${filePath}": GIF frame ${fw}x${fh}, check maxPixels`, `re-export "${filePath}"`);
      if (pos >= bytes.length) throw cut();
      const minCodeSize = bytes[pos++];
      if (!(minCodeSize >= 2 && minCodeSize <= 8)) throw inputError('JXL_INPUT', `"${filePath}": invalid GIF LZW code size ${minCodeSize} (expected 2-8)`, `re-export "${filePath}"`);
      const lzwData = readSubBlocks();
      const indices = lzwDecode(minCodeSize, lzwData, fw * fh, () => { throw inputError('JXL_INPUT', `"${filePath}": GIF pixels incomplete`, `re-export "${filePath}"`); });
      canvas ??= allocCanvas(canvasBytes);
      const prevCanvas = disposal === 3 ? canvas.slice() : null;
      const interlaced = !!(fpack & 0x40);
      const rowOrder = [];
      if (interlaced) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let y = start; y < fh; y += step) rowOrder.push(y);
        }
      }
      for (let sy = 0; sy < fh; sy++) {
        const dy = top + (interlaced ? rowOrder[sy] : sy);
        for (let sx = 0; sx < fw; sx++) {
          const dx = left + sx;
          const idx = indices[sy * fw + sx];
          if (idx === transIdx) continue;
          const dst = (dy * width + dx) * 4, red = pal[idx * 3] ?? 0, green = pal[idx * 3 + 1] ?? 0, blue = pal[idx * 3 + 2] ?? 0;
          if (canvas[dst] === red && canvas[dst + 1] === green && canvas[dst + 2] === blue && canvas[dst + 3] === 255) continue;
          canvas[dst] = red; canvas[dst + 1] = green; canvas[dst + 2] = blue; canvas[dst + 3] = 255;
          touch(dx, dy, dx, dy);
        }
      }
      if (stream) yield {frame: {data: canvas.slice(), duration: delayMs}, width, height, loops};
      else {
        if (!tape) tape = new FrameTape(width, height, canvas.slice());
        else {
          const rect = x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], held = tape.nextHeld(rect);
          if (held > maxBytes) throw memory();
          if (held > tape.held) yield held;
          tape.push(canvas, rect);
        }
        x0 = width; y0 = height; x1 = y1 = -1;
        const k = frames.length, shown = tape;
        frames.push({get data() { return shown.frameAt(k); }, duration: delayMs});
      }
      if ((disposal === 2 || disposal === 3 && prevCanvas) && left < width && top < height) touch(Math.min(left, width - 1), Math.min(top, height - 1), Math.min(width, left + fw) - 1, Math.min(height, top + fh) - 1);
      if (disposal === 2) {
        for (let sy = 0; sy < fh; sy++) {
          const dy = top + sy;
          if (dy < height) canvas.fill(0, (dy * width + left) * 4, (dy * width + Math.min(width, left + fw)) * 4);
        }
      } else if (disposal === 3 && prevCanvas) {
        canvas.set(prevCanvas);
      }
      delayMs = 100; transIdx = -1; disposal = 0;
    } else {
      throw inputError('JXL_INPUT', `"${filePath}": GIF block ${block} invalid`, `re-export "${filePath}"`);
    }
  }
  if (stream) return {width, height, loops};
  if (!frames.length) throw inputError('JXL_INPUT', `"${filePath}": GIF frames missing`, `GIF image`);
  if (frames.length === 1) return {kind: 'still', picture: {data: frames[0].data, width, height}};
  const animation = {width, height, loops, frames};
  READ_GIFS.add(animation);
  return {kind: 'animation', animation};
}

export function readGifTape(bytes, filePath = 'input.gif', maxPixels = PIXELS, maxBytes = Infinity, retain) {
  bytes = viewBytes(bytes);
  pixelLimit(maxPixels);
  if (typeof filePath !== 'string') throw fail('JXL_OPTIONS', "filePath: string");
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw fail('JXL_OPTIONS', "maxBytes: positive safe integer");
  const steps = gifTape(bytes, filePath, maxPixels, maxBytes), next = () => { try { return steps.next(); } catch (error) { throw declared(error); } };
  if (retain) return (async () => {
    try {
      for (;;) { const step = next(); if (step.done) return step.value; await retain(step.value); }
    } finally { steps.return(); }
  })();
  for (;;) { const step = next(); if (step.done) return step.value; }
}

export function readGifBytes(bytes, filePath, maxPixels, maxBytes) {
  const read = readGifTape(bytes, filePath, maxPixels, maxBytes);
  if (read.kind !== 'animation') return read;
  const {width, height, loops, frames} = read.animation;
  const copies = new Map(), own = data => copies.get(data) ?? copies.set(data, data.slice()).get(data);
  return {kind: 'animation', animation: {width, height, loops, frames: frames.map(({data, duration}) => ({data: own(data), duration}))}};
}

function scanGifBlocks(bytes) {
  if (bytes.length < 13) return {frames: 0, loops: 1};
  let pos = 13, frames = 0, loops = 1;
  if (bytes[10] & 0x80) pos += 3 << ((bytes[10] & 7) + 1);
  if (pos > bytes.length) return {frames: 0, loops: 1};
  const skip = () => {
    while (pos < bytes.length) {
      const size = bytes[pos++];
      if (!size) return true;
      if (pos + size > bytes.length) { pos = bytes.length; return false; }
      pos += size;
    }
    return false;
  };
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      if (pos >= bytes.length) break;
      const label = bytes[pos++];
      if (label === 0xff) {
        const chunks = [];
        let ok = false;
        while (pos < bytes.length) {
          const size = bytes[pos++];
          if (!size) { ok = true; break; }
          if (pos + size > bytes.length) { pos = bytes.length; break; }
          if (chunks.length < 2) chunks.push(bytes.subarray(pos, pos + size));
          pos += size;
        }
        if (ok && chunks.length >= 2 && chunks[0].length === 11) {
          const app = String.fromCharCode(...chunks[0]);
          if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && chunks[1].length >= 3 && chunks[1][0] === 1) {
            const repeats = chunks[1][1] | (chunks[1][2] << 8);
            loops = repeats && repeats + 1;
          }
        }
      } else if (!skip()) break;
    } else if (block === 0x2c) {
      if (pos + 9 > bytes.length) break;
      const packed = bytes[pos + 8];
      pos += 9;
      if (packed & 0x80) pos += 3 << ((packed & 7) + 1);
      if (pos >= bytes.length) break;
      pos++;
      if (!skip()) break;
      frames++;
    } else break;
  }
  return {frames, loops};
}

export function readGifStream(bytes, filePath = 'input.gif', maxPixels = PIXELS) {
  bytes = viewBytes(bytes);
  pixelLimit(maxPixels);
  const {loops} = scanGifBlocks(bytes);
  const steps = gifTape(bytes, filePath, maxPixels, Infinity, true);
  let head;
  const pull = () => { try { const step = steps.next(); if (step.done) return null; head ??= step.value; return step.value.frame; } catch (error) { throw declared(error); } };
  const first = pull(), second = first && pull();
  if (!second) { steps.return(); return null; }
  let ahead = [first, second], done = false;
  const {width, height} = head;
  return {width, height, loops, next: () => { const frame = ahead.length ? ahead.shift() : done ? null : pull(); if (!frame) done = true; return frame; },
    stop: () => { done = true; steps.return(); }};
}

export function gifFrameCount(bytes) {
  bytes = viewBytes(bytes);
  return scanGifBlocks(bytes).frames;
}
