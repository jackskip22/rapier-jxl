// SPDX-License-Identifier: MIT
import {journalFact, FACTS} from './step-journal.mjs';

export const smoothProbes = (width, height) => width < 8 || height < 8 ? null : {
  ys: Array.from({length: 8}, (_, ry) => 1 + Math.floor((ry + 0.5) * (height - 2) / 8)),
  xs: Array.from({length: 8}, (_, rx) => 1 + Math.floor((rx + 0.5) * (width - 2) / 8))};
export function smoothProbe(row, above, x) {
  const i = x * 4;
  for (let c = 0; c < 3; c++) {
    const vx = row[i + c], vw = row[i - 4 + c], vn = above[i + c], vnw = above[i - 4 + c], vne = above[i + 4 + c];
    const pl = vw + vn - vnw, lo = vw < vn ? vw : vn, hi = vw < vn ? vn : vw, cg = pl < lo ? lo : pl > hi ? hi : pl;
    const planar = Math.abs(vw - vnw) <= 2 && Math.abs(vn - vnw) <= 2 ? Math.abs(vx - pl) : 256;
    if (Math.min(Math.abs(vx - vw), Math.abs(vx - vn), Math.abs(vx - vnw), Math.abs(vx - vne), Math.abs(vx - cg), planar) > 0) return false;
  }
  return true;
}
export function perfectSmoothSample(data, width, height) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || width < 8 || height < 8 || data.length !== width * height * 4) return false;
  const known = journalFact(data, FACTS)?.smooth;
  if (typeof known === 'boolean') return known;
  const {ys, xs} = smoothProbes(width, height), stride = width * 4;
  for (const y of ys) {
    const row = data.subarray(y * stride, (y + 1) * stride), above = data.subarray((y - 1) * stride, y * stride);
    for (const x of xs) if (!smoothProbe(row, above, x)) return false;
  }
  return true;
}
