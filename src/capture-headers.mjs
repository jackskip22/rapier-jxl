// SPDX-License-Identifier: MIT
import {FRAME_SIZE, packSigned} from './bits.mjs';
import {writeTOC, fullFrame} from './frame.mjs';
import {admitOutputSize} from './admit.mjs';

export function writeCaptureHeaderFields(w, width, height, colour, alpha, {colorSpace} = {}) {
  const size = [[9, 1], [13, 1], [18, 1], [30, 1]];
  w.write(16, 0x0AFF);
  w.write(1, 0);
  w.writeU32(size, height);
  w.write(3, 0);
  w.writeU32(size, width);
  w.write(alpha ? 9 : 8, alpha ? 0b101_1_000_0_0 : 0b00_1_000_0_0);
  w.write(1, 0);
  if (colour === 3 && colorSpace === 'display-p3') w.write(21, 0b01_1011_10_0_1001_10_01_00_0_0);
  else if (colour === 3 && colorSpace === 'rec2020') w.write(21, 0b01_1011_10_0_0111_10_01_00_0_0);
  else if (colour === 3) w.write(1, 1);
  else w.write(15, 0b01_1011_10_0_01_01_0_0);
  w.write(3, 4);
  w.zeroPadToByte();
}

export function writeCaptureFrameHeader(w, {alpha, crop, canvas, last = true, reference = 0, shift = 3}) {
  const full = fullFrame(crop, canvas);
  w.write(7, 0b0_00_1_00_0 | (last ? 0 : 6));
  w.write(alpha ? 4 : 2, 0);
  w.write(5, shift | (crop ? 16 : 0));
  if (crop) {
    w.writeU32(FRAME_SIZE, packSigned(crop.x)); w.writeU32(FRAME_SIZE, packSigned(crop.y));
    w.writeU32(FRAME_SIZE, crop.width); w.writeU32(FRAME_SIZE, crop.height);
  }
  for (let c = 0; c <= (alpha ? 1 : 0); c++) w.write(full ? 2 : 4, full ? 0 : 4);
  w.write(1, last ? 1 : 0);
  if (!last) {w.write(2, reference); if (full) w.write(1, 0);}
  w.write(10, 0);
}

export function writeCaptureModularHeader(w, {useGlobalTree = true, transforms = []} = {}) {
  w.write(1, useGlobalTree ? 1 : 0);
  w.write(1, 1);
  w.writeU32([[0, 0], [0, 1], [4, 2], [8, 18]], transforms.length);
  const beginC = [[3, 0], [6, 8], [10, 72], [13, 1096]];
  for (const t of transforms) {
    if (t.type === 'rct') { w.write(2, 0); w.writeU32(beginC, t.beginC); w.writeU32([[0, 6], [2, 0], [4, 2], [6, 10]], t.rctType ?? 6); continue; }
    if (t.type !== 'palette') throw new Error('unknown transform ' + t.type);
    w.write(2, 1); w.writeU32(beginC, t.beginC);
    w.writeU32([[0, 1], [0, 3], [0, 4], [13, 1]], t.numC);
    w.writeU32([[8, 0], [10, 256], [12, 1280], [16, 5376]], t.nbColors);
    w.writeU32([[0, 0], [8, 1], [10, 257], [16, 1281]], t.nbDeltas ?? 0);
    w.write(4, t.predictor ?? 0);
  }
}

export function assembleCaptureCodestream(header, sections) {
  writeTOC(header, sections.map(section => section.length));
  const head = header.finish(), length = head.length + sections.reduce((sum, section) => sum + section.length, 0);
  admitOutputSize(length);
  const bytes = new Uint8Array(length); bytes.set(head);
  for (let i = 0, at = head.length; i < sections.length; at += sections[i++].length) bytes.set(sections[i], at);
  return bytes;
}
