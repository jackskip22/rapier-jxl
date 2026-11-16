// SPDX-License-Identifier: MIT
import {JxlBits, readSize} from '../jxl-size.mjs';
import {boxes, SIGNATURE, CODESTREAM, PARTIAL} from '../container.mjs';

export function pictureSize(bytes) {
  try {
    if (bytes[0] === 255 && bytes[1] === 10) return readSize(new JxlBits(bytes));
    if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) return null;
    let prefix = null, used = 0, next = 0;
    const pending = new Map();
    for (const box of boxes(bytes)) {
      if (box.type === CODESTREAM) return readSize(new JxlBits(bytes.subarray(box.body, box.end)));
      if (box.type !== PARTIAL) continue;
      prefix ||= new Uint8Array(16);
      const at = box.body, index = (bytes[at] & 127) * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
      pending.set(index, box);
      while (pending.has(next) && used < prefix.length) {
        const part = pending.get(next++); pending.delete(next - 1);
        const count = Math.min(prefix.length - used, part.end - part.body - 4);
        prefix.set(bytes.subarray(part.body + 4, part.body + 4 + count), used); used += count;
      }
      if (used === prefix.length) break;
    }
    return prefix && readSize(new JxlBits(prefix.subarray(0, used)));
  } catch { return null; }
}
