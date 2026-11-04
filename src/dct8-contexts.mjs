// SPDX-License-Identifier: MIT
import {ZIGZAG} from './jpeg-tables.mjs';
export const NONZERO_BUCKETS = 37, ZERO_DENSITY_CONTEXTS = 458, ORDERS = 13;
export const COEFF_FREQ_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => i < 2 ? 0 : i < 16 ? i - 1 : i < 32 ? 7 + (i >> 1) : 15 + (i >> 2));
export const COEFF_NUM_NONZERO_CONTEXT = /* @__PURE__ */ Array.from({length: 64}, (_, i) => i < 2 ? 0 : i < 3 ? 31 : i < 5 ? 62 : i < 9 ? 93 : i < 13 ? 123 : i < 21 ? 152 : i < 33 ? 180 : 206);

export const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));

export const zeroDensityContext = (left, k, prev) => (COEFF_NUM_NONZERO_CONTEXT[left] + COEFF_FREQ_CONTEXT[k]) * 2 + prev;
export const DCT8_DENSITY = Int32Array.from({length: 64 * 64}, (_, i) => (COEFF_NUM_NONZERO_CONTEXT[i >> 6] + COEFF_FREQ_CONTEXT[i & 63]) * 2);

