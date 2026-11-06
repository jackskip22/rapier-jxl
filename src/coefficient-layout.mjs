// SPDX-License-Identifier: MIT
export const ORDER_STRATEGY_BUCKETS = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
const dctScans = new Map();

export function naturalOrderLower(widthBlocks, heightBlocks, order, i, next) {
  const cx = Math.max(widthBlocks, heightBlocks), cy = Math.min(widthBlocks, heightBlocks), width = cx * 8, ratio = cx / cy;
  for (let j = 0; j <= i; j++) {
    let x = j, y = i - j;
    if (i & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    y /= ratio;
    order[x < cx && y < cy ? y * cx + x : next++] = y * width + x;
  }
  return next;
}
export function naturalOrderUpper(widthBlocks, heightBlocks, order, ip, next) {
  const cx = Math.max(widthBlocks, heightBlocks), cy = Math.min(widthBlocks, heightBlocks), width = cx * 8, ratio = cx / cy;
  for (let j = 0; j < ip; j++) {
    let x = width - ip + j, y = width - 1 - j;
    if ((ip - 1) & 1) [x, y] = [y, x];
    if (y % ratio) continue;
    order[next++] = y / ratio * width + x;
  }
  return next;
}

export function naturalOrder(widthBlocks, heightBlocks) {
  const cx = Math.max(widthBlocks, heightBlocks), cy = Math.min(widthBlocks, heightBlocks), key = cx * 64 + cy;
  if (dctScans.has(key)) return dctScans.get(key);
  const width = cx * 8, order = new Uint32Array(cx * cy * 64);
  let next = cx * cy;
  for (let i = 0; i < width; i++) next = naturalOrderLower(widthBlocks, heightBlocks, order, i, next);
  for (let ip = width - 1; ip > 0; ip--) next = naturalOrderUpper(widthBlocks, heightBlocks, order, ip, next);
  dctScans.set(key, order);
  return order;
}
