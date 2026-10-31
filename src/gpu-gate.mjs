// SPDX-License-Identifier: MIT
export const GPU_FROM = Object.freeze({7: 0, 8: 0, 9: 0});
export const gpuOffered = (width, height, effort) => width * height >= (GPU_FROM[effort] ?? Infinity);
