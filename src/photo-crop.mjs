// SPDX-License-Identifier: MIT
import {PHOTO_LIMITS} from './limits.mjs';
import {BitWriter} from './bits.mjs';
import {admitSize, admitOutputSize} from './admit.mjs';
import {readFrames, writeStillImageHeader, writeStillFrame, copyBits} from './framing.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';

export function photoLevelContainer(bytes, level) {
  if (level !== 10) return bytes;
  const prefix = fileHeader(10), box = boxHeader(CODESTREAM, bytes.length);
  admitOutputSize(prefix.length + box.length + bytes.length);
  const result = new Uint8Array(prefix.length + box.length + bytes.length);
  result.set(prefix); result.set(box, prefix.length); result.set(bytes, prefix.length + box.length);
  return result;
}

export function padPhotoTiles(data, width, height) {
  const w = Math.ceil(width / 8) * 8, h = Math.ceil(height / 8) * 8;
  if (w === width && h === height) return null;
  admitSize(w, h, PHOTO_LIMITS);
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = Math.min(height - 1, y) * width * 4;
    pixels.set(data.subarray(row, row + width * 4), y * w * 4);
    for (let x = width; x < w; x++) pixels.set(data.subarray(row + (width - 1) * 4, row + width * 4), (y * w + x) * 4);
  }
  return {data: pixels, width: w, height: h};
}

export function cropPhotoCanvas(bytes, width, height) {
  const still = readFrames(bytes), writer = new BitWriter(256), canvas = {width, height, extraChannels: still.image.extraChannels};
  writeStillImageHeader(writer, still, canvas);
  for (const frame of still.frames) {
    if (frame.type === 1) copyBits(writer, still.codestream, frame.start * 8, frame.end * 8);
    else writeStillFrame(writer, still, frame, {canvas, last: frame.last});
  }
  const result = writer.finish(); admitOutputSize(result.length); return photoLevelContainer(result, still.level);
}
