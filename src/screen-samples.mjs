// SPDX-License-Identifier: MIT
export const CAPTURE_FLAT = 64;
export function flatSamples(rgba, width, height, min = 0, stride = width, x0 = 0, y0 = 0, from = 0, to = 256) {
  if (width < 32 || height < 32) return 0;
  let flat = 0;
  for (let s = from; s < to; s++) {
    const x = Math.min(width - 2, Math.floor((((s % 16) * 16 + ((s * 13) & 15)) * width) / 256));
    const y = Math.min(height - 2, Math.floor((((s >> 4) * 16 + ((s * 7) & 15)) * height) / 256));
    const p = ((y0 + y) * stride + x0 + x) * 4, q = p + 4, r = p + stride * 4;
    if (rgba[p] === rgba[q] && rgba[p + 1] === rgba[q + 1] && rgba[p + 2] === rgba[q + 2] && rgba[p + 3] === rgba[q + 3] &&
        rgba[p] === rgba[r] && rgba[p + 1] === rgba[r + 1] && rgba[p + 2] === rgba[r + 2] && rgba[p + 3] === rgba[r + 3]) flat++;
    if (flat + 255 - s < min) return 0;
  }
  return flat;
}
export function screenLike(rgba, width, height) {
  return flatSamples(rgba, width, height, 192) >= 192;
}

