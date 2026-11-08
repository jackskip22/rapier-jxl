// SPDX-License-Identifier: MIT
export function exifOrientation(bytes, start, end, found) {
  const little = bytes[start] === 73 && bytes[start + 1] === 73;
  if (!little && !(bytes[start] === 77 && bytes[start + 1] === 77)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => at + 2 > end ? 0 : view.getUint16(at, little);
  const u32 = at => at + 4 > end ? 0 : view.getUint32(at, little);
  if (u16(start + 2) !== 42 || u32(start + 4) < 8) return null;
  const ifd = start + u32(start + 4), entries = u16(ifd);
  for (let i = 0, at = ifd + 2; i < entries && at + 12 <= end; i++, at += 12) {
    const value = u16(at + 8);
    if (u16(at) === 274 && u16(at + 2) === 3 && u32(at + 4) === 1 && value >= 1 && value <= 8) {
      found?.(at + 8, !little); return value;
    }
  }
  return null;
}
