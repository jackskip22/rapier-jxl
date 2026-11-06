// SPDX-License-Identifier: MIT
export function packLevels(image) {
  image.components.forEach((component, c) => {
    const {coeffs} = component, counts = image.nonZero?.[c] ?? splitBlockCounts(coeffs);
    let total = 0;
    for (let b = 0; b < counts.length; b++) total += counts[b];
    const at = new Uint8Array(total), levels = new Int16Array(total), stride = component.stride, starts = new Uint32Array(counts.length / stride);
    for (let b = 0, n = 0; b < counts.length; b++) {
      const base = b * 64;
      if (b % stride === 0) starts[b / stride] = n;
      for (let k = 1, left = counts[b]; left; k++) { const v = coeffs[base + k]; if (v) { at[n] = k; levels[n++] = v; left--; } }
    }
    component.packed = {at, levels, counts, starts, segment: stride, length: coeffs.length};
    component.coeffs = null;
  });
  return image;
}
export function splitBlockCounts(coeffs) {
  const counts = new Uint8Array(coeffs.length / 64);
  for (let b = 0; b < counts.length; b++) { let n = 0; for (let k = 1; k < 64; k++) n += coeffs[b * 64 + k] !== 0; counts[b] = n; }
  return counts;
}
export function unpackLevels(image, splitScratch) {
  image.components.forEach((component, c) => {
    const packed = component.packed;
    if (!packed || component.coeffs) return;
    if (!splitScratch[c] || splitScratch[c].length < packed.length) splitScratch[c] = new Int16Array(packed.length);
    const coeffs = splitScratch[c].subarray(0, packed.length), {at, levels, counts, starts, segment} = packed, stride = component.stride;
    const segments = Math.ceil(stride / segment);
    coeffs.fill(0);
    for (let row = 0, b = 0; b < counts.length; row++) for (let s = 0; s < segments; s++) {
      let n = starts[row * segments + s];
      for (const end = row * stride + Math.min(stride, (s + 1) * segment); b < end; b++) { const base = b * 64; for (const last = n + counts[b]; n < last; n++) coeffs[base + at[n]] = levels[n]; }
    }
    component.coeffs = coeffs;
  });
}

export function packedOnly(image) { for (const component of image.components) if (component.packed) component.coeffs = null; }

