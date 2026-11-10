// SPDX-License-Identifier: MIT
import {fail, dimensions} from './primitives.mjs';

const inputError = (code, message, fix) => Object.assign(fail(code, `${message} Fix: ${fix}`), {fix});

function lzwDecode(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1, nextCode = eoiCode + 1, codeMask = (1 << codeSize) - 1;
  let datum = 0, bits = 0, first = 0, oldCode = -1, top = 0, dst = 0, pos = 0;
  for (let i = 0; i < clearCode; i++) { prefix[i] = -1; suffix[i] = i; }
  while (dst < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out;
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
    if (code === eoiCode) break;
    if (code > nextCode || oldCode === -1 && code >= clearCode) break;
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

export function readGifBytes(bytes, filePath = 'input.gif', maxPixels = 40000000, heldPixels = 1 << 28) {
  if (bytes.length < 13) throw inputError('JXL_INPUT', `"${filePath}" is truncated.`, `pass a complete GIF file.`);
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
  dimensions(width, height, maxPixels);
  const packed = bytes[10];
  let pos = 13;
  let globalPalette = null;
  if (packed & 0x80) {
    const count = 1 << ((packed & 7) + 1);
    globalPalette = bytes.subarray(pos, pos + count * 3);
    pos += count * 3;
  }
  const readSubBlocks = () => {
    const chunks = [];
    while (pos < bytes.length) {
      const sz = bytes[pos++];
      if (!sz) break;
      chunks.push(bytes.subarray(pos, pos + sz));
      pos += sz;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.length; }
    return merged;
  };
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let delayMs = 100, transIdx = -1, disposal = 0, loops = 1;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const sz = bytes[pos++];
        const flags = bytes[pos];
        disposal = (flags >> 2) & 7;
        const hasTrans = flags & 1;
        const delayCs = bytes[pos + 1] | (bytes[pos + 2] << 8);
        delayMs = Math.max(10, (delayCs || 10) * 10);
        transIdx = hasTrans ? bytes[pos + 3] : -1;
        pos += sz + 1;
      } else if (label === 0xff) {
        const sub = readSubBlocks();
        const app = String.fromCharCode(...sub.subarray(0, 11));
        if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && sub.length >= 14 && sub[11] === 1) { const repeats = sub[12] | (sub[13] << 8); loops = repeats && repeats + 1; }
      } else {
        readSubBlocks();
      }
    } else if (block === 0x2c) {
      const left = bytes[pos] | (bytes[pos + 1] << 8), top = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const fw = bytes[pos + 4] | (bytes[pos + 5] << 8), fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const fpack = bytes[pos + 8];
      pos += 9;
      let pal = globalPalette;
      if (fpack & 0x80) {
        const count = 1 << ((fpack & 7) + 1);
        pal = bytes.subarray(pos, pos + count * 3);
        pos += count * 3;
      }
      if (!pal) throw inputError('JXL_INPUT', `"${filePath}" GIF frame has no color table.`, `re-export "${filePath}".`);
      if (!fw || !fh || fw * fh > maxPixels) throw inputError('JXL_DIMENSIONS', `"${filePath}" has a ${fw} x ${fh} GIF frame.`, `re-export "${filePath}".`);
      const minCodeSize = bytes[pos++];
      if (!(minCodeSize >= 2 && minCodeSize <= 8)) throw inputError('JXL_INPUT', `"${filePath}" is not a valid GIF (LZW code size ${minCodeSize}).`, `re-export "${filePath}".`);
      if ((frames.length + 1) * Math.max(width * height, 65536) > heldPixels) throw inputError('JXL_LIMIT', `"${filePath}" has more frames than fit in 1 GiB at ${width} x ${height}.`, `shorten or resize it first.`);
      const lzwData = readSubBlocks();
      const indices = lzwDecode(minCodeSize, lzwData, fw * fh);
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
        if (dy >= height) continue;
        for (let sx = 0; sx < fw; sx++) {
          const dx = left + sx;
          if (dx >= width) continue;
          const idx = indices[sy * fw + sx];
          if (idx === transIdx) continue;
          const dst = (dy * width + dx) * 4;
          canvas[dst] = pal[idx * 3] ?? 0;
          canvas[dst + 1] = pal[idx * 3 + 1] ?? 0;
          canvas[dst + 2] = pal[idx * 3 + 2] ?? 0;
          canvas[dst + 3] = 255;
        }
      }
      frames.push({data: canvas.slice(), duration: delayMs});
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
      break;
    }
  }
  if (!frames.length) throw inputError('JXL_INPUT', `"${filePath}" contains no GIF frames.`, `pass a valid GIF image.`);
  if (frames.length === 1) return {kind: 'still', picture: {data: frames[0].data, width, height}};
  return {kind: 'animation', animation: {width, height, loops, frames}};
}

