// SPDX-License-Identifier: MIT
import {s2RGBA} from './ssimulacra2-input.mjs';
import {kernelModule} from './kernel-runtime.mjs';

const AT = 131072;
export function linearTable() {
  const memory = new WebAssembly.Memory({initial: 3, maximum: 3});
  new WebAssembly.Instance(kernelModule(), {env: {memory}}).exports.s2MetricInit(AT);
  return new Float32Array(memory.buffer, AT, 256).slice();
}
export function linearFromRGBA(rgba, pixels) {
  const input = s2RGBA(rgba, pixels), table = linearTable();
  const planes = [0, 1, 2].map(() => new Float32Array(pixels));
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) planes[c][i] = table[input[i * 4 + c]];
  return planes;
}
