// SPDX-License-Identifier: MIT

export const RGB8_THRESHOLDS = /* @__PURE__ */ (() => {
  const buf = new ArrayBuffer(4), f32 = new Float32Array(buf), u32 = new Uint32Array(buf);
  const level = bits => {
    u32[0] = bits;
    const x = f32[0], t = Math.fround(x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255 + 0.5;
    return t >= 255.5 ? 255 : t >= 1 ? Math.trunc(t) : 0;
  };
  const out = new Uint32Array(256);
  for (let k = 1; k < 256; k++) {
    const a = (k - 0.5) / 255;
    f32[0] = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
    let w = u32[0];
    while (w > 0 && level(w - 1) >= k) w--;
    while (level(w) < k) w++;
    out[k] = w;
  }
  return new Float32Array(out.buffer);
})();
