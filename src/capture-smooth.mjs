// SPDX-License-Identifier: MIT
import {captureSmoothCells, captureMaskComponents} from './capture-kernels.mjs';
export function captureSmoothRegions(data, width, height, exactRects) {
  const exact = new Uint8Array(width * height);
  for (const r of exactRects) {
    if (r.edge && r.width * r.height * 2 >= width * height) continue;
    const x0 = Math.max(0, r.x), x1 = Math.min(width, r.x + r.width), y0 = Math.max(0, r.y), y1 = Math.min(height, r.y + r.height);
    for (let y = y0; y < y1; y++) exact.fill(1, y * width + x0, y * width + x1);
  }
  const cw = Math.ceil(width / 16), ch = Math.ceil(height / 16), grid = captureSmoothCells(data, exact, width, height);
  const closed = grid.slice();
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (closed[y * cw + x]) continue;
    if (x && grid[y * cw + x - 1] && (x + 1 < cw && grid[y * cw + x + 1] || x + 2 < cw && grid[y * cw + x + 2]) ||
        y && grid[(y - 1) * cw + x] && (y + 1 < ch && grid[(y + 1) * cw + x] || y + 2 < ch && grid[(y + 2) * cw + x])) closed[y * cw + x] = 1;
  }
  const outside = new Uint8Array(closed.length), pending = [];
  const open = i => { if (outside[i] || closed[i]) return; outside[i] = 1; pending.push(i); };
  for (let x = 0; x < cw; x++) { open(x); open((ch - 1) * cw + x); }
  for (let y = 0; y < ch; y++) { open(y * cw); open(y * cw + cw - 1); }
  while (pending.length) {
    const at = pending.pop(), x = at % cw, y = at / cw | 0;
    if (x) open(at - 1); if (x + 1 < cw) open(at + 1); if (y) open(at - cw); if (y + 1 < ch) open(at + cw);
  }
  for (let i = 0; i < closed.length; i++) if (!outside[i]) closed[i] = 1;
  const regions = [];
  for (const {x: x0, y: y0, width: columns, height: rows, cells} of captureMaskComponents(closed, cw, ch, true)) {
    const x1 = x0 + columns - 1, y1 = y0 + rows - 1;
    if (columns * 4 >= cw * 3 && rows * 4 >= ch * 3 && cells >= columns + rows) { regions.push({x: 0, y: 0, width, height}); continue; }
    if (Math.min(columns, rows) < 3 || Math.max(columns, rows) < 4 || cells < 12 || cells * 2 < columns * rows) continue;
    const x = Math.max(0, (x0 - 1) * 16), y = Math.max(0, (y0 - 1) * 16);
    const region = {x, y, width: Math.min(width, (x1 + 2) * 16) - x, height: Math.min(height, (y1 + 2) * 16) - y};
    if (Math.min(region.width, region.height) < 80) continue;
    regions.push(region);
  }
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height) continue;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    regions[i] = {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y};
    regions.splice(j, 1); i = -1; break;
  }
  return regions;
}
